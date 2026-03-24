import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';

/**
 * Engine which uses the OpenAI Realtime API (WebRTC) for real-time
 * speech transcription.
 *
 * Flow:
 *   1. Mic acquired
 *   2. RTCPeerConnection + data channel created
 *   3. SDP offer → POST /api/stt/session (server does token + SDP)
 *   4. SDP answer → WebRTC connected
 *   5. Session is FULLY configured from the start (config in token)
 *   6. Audio flows immediately — no waiting for session.update
 *   7. On stop: commit buffer, wait for final transcript, finalize
 */
export class RealtimeSTTEngine implements IRecognitionEngine {
  public readonly engineType = 'realtimeStt' as const;

  private onResultCallback: (result: SpeechResult) => void;
  private readonly setState: (state: Partial<SpeechRecognitionState>) => void;
  private preferredLanguage: string;

  private _pc: RTCPeerConnection | null = null;
  private _dc: RTCDataChannel | null = null;
  private _mediaStream: MediaStream | null = null;

  private results: SpeechResult = createSpeechRecognitionResults();
  private disposed = false;
  private withinBeginEnd = false;

  private _confirmedText = '';
  private _currentDelta = '';

  private _pendingFinalize = false;
  private _pendingFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 24000,
  };

  constructor(
    preferredLanguage: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,
  ) {
    this.preferredLanguage = preferredLanguage;
    this.onResultCallback = onResultCallback;
    this.setState = setState;
    setState({ isAvailable: true });
  }

  async start() {
    this.results = createSpeechRecognitionResults();
    this.disposed = false;
    this.withinBeginEnd = false;
    this._confirmedText = '';
    this._currentDelta = '';
    this._pendingFinalize = false;
    this.onResultCallback(this.results);

    try {
      // ── Step 1: Get mic ───────────────────────────────────────────
      if (!this._mediaStream) {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: RealtimeSTTEngine.AUDIO_CONSTRAINTS,
        });
      }
      if (this.disposed) { this._releaseMic(); return; }

      // ── Step 2: Create RTCPeerConnection ──────────────────────────
      this._pc = new RTCPeerConnection();

      this._dc = this._pc.createDataChannel('oai-events');
      this._setupDataChannel(this._dc);

      for (const track of this._mediaStream.getAudioTracks())
        this._pc.addTrack(track, this._mediaStream);

      // ── Step 3: SDP offer ─────────────────────────────────────────
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);

      // ── Step 4: Exchange SDP through our server ───────────────────
      const lang = _normalizeLanguage(this.preferredLanguage);
      const sdpRes = await fetch(
        `/api/stt/session?lang=${encodeURIComponent(lang || 'en')}&eagerness=medium`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        },
      );

      if (!sdpRes.ok) {
        const detail = await sdpRes.text().catch(() => sdpRes.statusText);
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${detail}`);
      }

      const answerSdp = await sdpRes.text();
      if (this.disposed) return;

      await this._pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      this.withinBeginEnd = true;
      this.setState({ isActive: true, hasAudio: true, hasSpeech: false });

    } catch (error: any) {
      if (!this.disposed) {
        console.error('[RealtimeSTTEngine] start error:', error);
        this._handleError(error?.message ?? 'Failed to start realtime transcription.');
      }
    }
  }

  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    if (!this.withinBeginEnd) return;
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;

    // Mute mic
    if (this._mediaStream) {
      for (const track of this._mediaStream.getAudioTracks())
        track.enabled = false;
    }

    // Commit buffer and wait for final transcript
    if (this._dc?.readyState === 'open') {
      try {
        this._dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        this._pendingFinalize = true;

        this._pendingFinalizeTimer = setTimeout(() => {
          if (this._pendingFinalize && this.withinBeginEnd) {
            console.warn('[RealtimeSTTEngine] finalize timeout');
            this._pendingFinalize = false;
            this._finalize();
          }
        }, 3000);
        return;
      } catch { /* send failed */ }
    }

    this._finalize();
  }

  dispose() {
    this.disposed = true;
    this._cleanup(true);
  }

  isBetweenBeginEnd() {
    return this.withinBeginEnd;
  }

  updateConfiguration(
    language: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
  ) {
    this.preferredLanguage = language;
    this.onResultCallback = onResultCallback;
  }

  // ── Data channel ───────────────────────────────────────────────────

  private _setupDataChannel(dc: RTCDataChannel) {
    dc.addEventListener('open', () => {
      if (this.disposed) return;
      // Session fully configured via token — nothing to send
      console.log('[RealtimeSTTEngine] data channel open');
    });

    dc.addEventListener('message', (e: MessageEvent) => {
      if (this.disposed) return;
      try { this._handleEvent(JSON.parse(e.data as string)); }
      catch { /* ignore parse errors */ }
    });

    dc.addEventListener('error', (e) => {
      if (this.disposed) return;
      console.error('[RealtimeSTTEngine] data channel error:', e);
      this._handleError('WebRTC data channel error.');
    });

    dc.addEventListener('close', () => {
      if (this.disposed || !this.withinBeginEnd) return;
      this._finalize();
    });
  }

  private _handleEvent(event: any) {
    switch (event.type) {

      case 'session.created':
        console.log('[RealtimeSTTEngine] full session:', JSON.stringify(event.session, null, 2));
        break;

      case 'session.updated':
        console.log('[RealtimeSTTEngine] session updated');
        break;

      case 'input_audio_buffer.speech_started':
        this.setState({ hasSpeech: true });
        break;

      case 'input_audio_buffer.speech_stopped':
        this.setState({ hasSpeech: false });
        break;

      case 'input_audio_buffer.committed':
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this._currentDelta += event.delta ?? '';
        this.results.interimTranscript = this._confirmedText
          ? (this._confirmedText + ' ' + this._currentDelta).trim()
          : this._currentDelta;
        this.onResultCallback({ ...this.results });
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const turn = (event.transcript ?? '').trim();
        if (turn) {
          this._confirmedText = this._confirmedText
            ? (this._confirmedText + ' ' + turn).trim()
            : turn;
          this._currentDelta = '';
          this.results.interimTranscript = this._confirmedText;
          this.onResultCallback({ ...this.results });
        }

        if (this._pendingFinalize) {
          this._pendingFinalize = false;
          if (this._pendingFinalizeTimer) {
            clearTimeout(this._pendingFinalizeTimer);
            this._pendingFinalizeTimer = null;
          }
          this._finalize();
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.failed':
        console.warn('[RealtimeSTTEngine] transcription failed:', event.error);
        if (this._pendingFinalize) {
          this._pendingFinalize = false;
          if (this._pendingFinalizeTimer) {
            clearTimeout(this._pendingFinalizeTimer);
            this._pendingFinalizeTimer = null;
          }
          this._finalize();
        }
        break;

      case 'conversation.item.added':
      case 'conversation.item.done':
        break;

      case 'error':
        console.error('[RealtimeSTTEngine] server error:', event.error);
        // Empty buffer commit is not fatal
        if (event.error?.code === 'input_audio_buffer_commit_empty') {
          if (this._pendingFinalize) {
            this._pendingFinalize = false;
            if (this._pendingFinalizeTimer) {
              clearTimeout(this._pendingFinalizeTimer);
              this._pendingFinalizeTimer = null;
            }
            this._finalize();
          }
          break;
        }
        if (event.error?.type === 'invalid_request_error')
          this._handleError(event.error?.message ?? 'Transcription error.');
        break;

      default:
        break;
    }
  }

  // ── Finalize / cleanup ─────────────────────────────────────────────

  private _finalize() {
    if (!this.withinBeginEnd) return; // guard against double finalize
    this.withinBeginEnd = false;
    this.setState({ isActive: false, hasAudio: false, hasSpeech: false });

    const finalText = this._confirmedText
      ? this._currentDelta
        ? (this._confirmedText + ' ' + this._currentDelta).trim()
        : this._confirmedText
      : this._currentDelta.trim();

    this.results.transcript = finalText;
    this.results.interimTranscript = finalText; // keep text visible
    this.results.done = true;
    this.results.doneReason = this.results.doneReason ?? 'manual';
    this.onResultCallback({ ...this.results });

    this._cleanup(false);
  }

  private _handleError(message: string) {
    if (!this.withinBeginEnd) return;
    this.withinBeginEnd = false;
    this.setState({ errorMessage: message, isActive: false, hasAudio: false, hasSpeech: false });
    this.results.doneReason = 'api-error';
    this.results.done = true;
    this.onResultCallback({ ...this.results });
    this._cleanup(false);
  }

  private _cleanup(releaseMic: boolean) {
    if (this._pendingFinalizeTimer) {
      clearTimeout(this._pendingFinalizeTimer);
      this._pendingFinalizeTimer = null;
    }
    this._pendingFinalize = false;

    if (this._dc) {
      this._dc.onopen = null;
      this._dc.onmessage = null;
      this._dc.onerror = null;
      this._dc.onclose = null;
      try { if (this._dc.readyState !== 'closed') this._dc.close(); } catch { /* ignore */ }
      this._dc = null;
    }
    if (this._pc) {
      try { this._pc.close(); } catch { /* ignore */ }
      this._pc = null;
    }
    if (releaseMic) this._releaseMic();
  }

  private _releaseMic() {
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(t => t.stop());
      this._mediaStream = null;
    }
  }
}

function _normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const trimmed = lang.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/[-_]/)[0]?.toLowerCase() || undefined;
}
