import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';


/**
 * Engine which uses the OpenAI Realtime API (WebRTC) for true real-time
 * speech transcription — word-by-word as you speak, ~200ms latency.
 *
 * Flow:
 *   1. POST /api/stt/session → ephemeral token (API key stays server-side)
 *   2. RTCPeerConnection created in browser
 *   3. Mic track added to peer connection
 *   4. SDP offer → POST https://api.openai.com/v1/realtime/calls
 *   5. SDP answer → WebRTC connected
 *   6. Data channel "oai-events" receives streaming transcription deltas
 *   7. Server VAD detects speech automatically — no manual chunking
 *   8. On stop: final transcript assembled from all confirmed turns
 *
 * Vercel compatible: only one short REST call hits Vercel.
 * All audio streams directly browser → OpenAI via WebRTC.
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

  // Accumulate turns — each VAD-detected utterance is one turn
  private _confirmedText = '';
  private _currentDelta = '';

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    // Note: sampleRate hint only — WebRTC resamples internally to 24kHz
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
    this.onResultCallback(this.results);

    try {
      // ── Step 1: Get ephemeral token from our Vercel function ──────────
      const lang = _normalizeLanguage(this.preferredLanguage);
      const sessionRes = await fetch('/api/stt/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      });

      if (!sessionRes.ok)
        throw new Error(`Session creation failed (${sessionRes.status})`);

      const { token } = await sessionRes.json();
      if (!token) throw new Error('No ephemeral token received');
      if (this.disposed) return;

      // ── Step 2: Get mic ───────────────────────────────────────────────
      if (!this._mediaStream) {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: RealtimeSTTEngine.AUDIO_CONSTRAINTS,
        });
      }
      if (this.disposed) { this._releaseMic(); return; }

      // ── Step 3: Create RTCPeerConnection ──────────────────────────────
      this._pc = new RTCPeerConnection();

      // Data channel MUST be created before offer
      this._dc = this._pc.createDataChannel('oai-events');
      this._setupDataChannel(this._dc);

      // Add mic track
      for (const track of this._mediaStream.getAudioTracks())
        this._pc.addTrack(track, this._mediaStream);

      // ── Step 4: SDP offer ─────────────────────────────────────────────
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);

      // ── Step 5: Exchange SDP with OpenAI ──────────────────────────────
      const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent('gpt-4o-transcribe')}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpRes.ok) {
        const detail = await sdpRes.text().catch(() => sdpRes.statusText);
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${detail}`);
      }

      const answerSdp = await sdpRes.text();
      if (this.disposed) return;

      await this._pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // Active — data channel onopen will fire shortly
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
      // Nothing to send — session was already configured server-side
      // when we created the client secret
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

      // ── Session lifecycle ──────────────────────────────────────────
      case 'session.created':
        console.log('[RealtimeSTTEngine] session created, type:', event.session?.type, 'id:', event.session?.id);
        break;

      case 'session.updated':
        console.log('[RealtimeSTTEngine] session updated');
        break;

      // ── VAD events ─────────────────────────────────────────────────
      case 'input_audio_buffer.speech_started':
        this.setState({ hasSpeech: true });
        break;

      case 'input_audio_buffer.speech_stopped':
        this.setState({ hasSpeech: false });
        break;

      case 'input_audio_buffer.committed':
        // VAD committed a turn — transcription will follow
        console.log('[RealtimeSTTEngine] audio buffer committed, item:', event.item_id);
        break;

      // ── Transcription streaming ────────────────────────────────────
      // Streaming delta — word by word as the model transcribes
      case 'conversation.item.input_audio_transcription.delta':
        this._currentDelta += event.delta ?? '';
        this.results.interimTranscript = this._confirmedText
          ? (this._confirmedText + ' ' + this._currentDelta).trim()
          : this._currentDelta;
        this.onResultCallback({ ...this.results });
        break;

      // Turn complete — lock this utterance into confirmed text
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
        break;
      }

      // Transcription failed for a turn — log but don't kill session
      case 'conversation.item.input_audio_transcription.failed':
        console.warn('[RealtimeSTTEngine] transcription failed for turn:', event.item_id, event.error);
        break;

      // ── Conversation item lifecycle (non-critical, log only) ───────
      case 'conversation.item.added':
      case 'conversation.item.done':
        break;

      // ── Errors ─────────────────────────────────────────────────────
      case 'error':
        console.error('[RealtimeSTTEngine] server error:', event.error);
        // Only treat invalid_request_error as fatal — others may be transient
        if (event.error?.type === 'invalid_request_error')
          this._handleError(event.error?.message ?? 'Transcription error.');
        break;

      default:
        // Uncomment for debugging new/unexpected events:
        // console.log('[RealtimeSTTEngine] unhandled event:', event.type, event);
        break;
    }
  }

  // ── Finalize / cleanup ─────────────────────────────────────────────

  private _finalize() {
    this.withinBeginEnd = false;
    this.setState({ isActive: false, hasAudio: false, hasSpeech: false });

    // Combine confirmed turns + any in-progress delta
    const finalText = this._confirmedText
      ? this._currentDelta
        ? (this._confirmedText + ' ' + this._currentDelta).trim()
        : this._confirmedText
      : this._currentDelta.trim();

    this.results.transcript = finalText;
    this.results.interimTranscript = '';
    this.results.done = true;
    this.results.doneReason = this.results.doneReason ?? 'manual';
    this.onResultCallback({ ...this.results });

    this._cleanup(false);
  }

  private _handleError(message: string) {
    this.withinBeginEnd = false;
    this.setState({ errorMessage: message, isActive: false, hasAudio: false, hasSpeech: false });
    this.results.doneReason = 'api-error';
    this.results.done = true;
    this.onResultCallback({ ...this.results });
    this._cleanup(false);
  }

  private _cleanup(releaseMic: boolean) {
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
