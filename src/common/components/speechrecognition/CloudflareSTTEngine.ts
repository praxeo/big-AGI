// src/common/components/speechrecognitionwebspeech/CloudflareSTTEngine.ts

import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  PLACEHOLDER_INTERIM_TRANSCRIPT,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';


export class CloudflareSTTEngine implements IRecognitionEngine {
  public readonly engineType = 'cloudflareStt' as const;

  // Config
  private workerUrl: string;
  private language: string;
  private softStopTimeout: number;
  private onResultCallback: (result: SpeechResult) => void;
  private setState: (state: Partial<SpeechRecognitionState>) => void;

  // Runtime
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private mediaStream: MediaStream | null = null;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private results: SpeechResult;
  private withinBeginEnd = false;
  private disposed = false;

  // Deepgram sends incremental messages, not cumulative like WebSpeech.
  // We accumulate finalized segments ourselves.
  private finalizedSegments: string[] = [];
  private currentInterim = '';


  constructor(
    workerUrl: string,
    preferredLanguage: string,
    softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,
  ) {
    this.workerUrl = workerUrl;
    this.language = preferredLanguage;
    this.softStopTimeout = softStopTimeout;
    this.onResultCallback = onResultCallback;
    this.setState = setState;
    this.results = createSpeechRecognitionResults();
    setState({ isAvailable: true });
  }


  // ── IRecognitionEngine ─────────────────────────────────────────

  start() {
    if (this.disposed || this.withinBeginEnd) return;

    // Reset state
    this.results = createSpeechRecognitionResults();
    this.results.flagSendOnDone = undefined;
    this.onResultCallback(this.results);
    this.finalizedSegments = [];
    this.currentInterim = '';

    // Build WSS URL with language query param
    const wsUrl = new URL(this.workerUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!wsUrl.pathname.endsWith('/transcribe'))
      wsUrl.pathname = wsUrl.pathname.replace(/\/$/, '') + '/transcribe';
    wsUrl.searchParams.set('language', this.language);

    this.ws = new WebSocket(wsUrl.toString());

    this.ws.onopen = () => {
      if (this.disposed) return;
      this.withinBeginEnd = true;
      this.setState({ isActive: true });

      this._startMicrophone().catch((err) => {
        if (this.disposed) return;
        const msg =
          err?.name === 'NotAllowedError'
            ? 'Microphone access blocked. Enable it in browser settings.'
            : err?.name === 'NotFoundError'
              ? 'No microphone found on this device.'
              : `Microphone error: ${err?.message || 'unknown'}`;
        this.setState({ errorMessage: msg });
        this.results.doneReason = 'api-error';
        this.ws?.close();
      });
    };

    this.ws.onmessage = (event) => {
      if (this.disposed) return;
      try {
        this._handleDeepgramMessage(JSON.parse(event.data as string));
      } catch { /* ignore non-JSON */ }
    };

    this.ws.onerror = () => {
      if (this.disposed) return;
      this.setState({ errorMessage: 'Connection to Cloudflare STT worker failed.' });
      this.results.doneReason = 'api-error';
    };

    this.ws.onclose = () => {
      if (this.disposed) return;
      this._clearInactivityTimeout();
      this._stopMicrophone();
      this._finalizeResults();
    };
  }


  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;
    this._stopMicrophone();
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(new ArrayBuffer(0)); // Deepgram end-of-stream signal
    this.ws?.close();
  }


  dispose() {
    this.disposed = true;
    this._clearInactivityTimeout();
    this._stopMicrophone();
    if (this.withinBeginEnd) {
      this.withinBeginEnd = false;
      this.results.doneReason = 'react-unmount';
    }
    this.ws?.close();
    this.ws = null;
  }


  isBetweenBeginEnd() {
    return this.withinBeginEnd;
  }


  updateConfiguration(
    language: string,
    softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
  ) {
    this.language = language;
    this.softStopTimeout = softStopTimeout;
    this.onResultCallback = onResultCallback;
  }


  // ── Deepgram message handling ──────────────────────────────────
  //
  //  Nova-3 streaming messages (per the actual schema):
  //
  //  { type: "Metadata" }             — connection info, ignore
  //  { type: "SpeechStarted" }        — vad_events: voice detected
  //  { type: "UtteranceEnd" }         — utterance_end_ms: speaker done
  //  { type: "Results", is_final, speech_final,
  //    channel: { alternatives: [{ transcript, confidence, words }] } }
  //
  //  is_final: false  → interim (text still changing)
  //  is_final: true   → segment locked in, won't change
  //  speech_final: true → endpointing detected pause
  //

  private _handleDeepgramMessage(data: any) {

    // VAD: speech started
    if (data.type === 'SpeechStarted') {
      this.setState({ hasSpeech: true });
      return;
    }

    // Utterance boundary
    if (data.type === 'UtteranceEnd') {
      this.setState({ hasSpeech: false });
      return;
    }

    // Ignore metadata / other types
    if (data.type === 'Metadata') return;

    // ── Transcript result ──
    // Schema: data.channel.alternatives[0].transcript
    const alt = data?.channel?.alternatives?.[0];
    if (!alt) return;

    const transcript = (alt.transcript || '').trim();
    const isFinal = data.is_final === true;
    // const speechFinal = data.speech_final === true;

    if (isFinal) {
      if (transcript) this.finalizedSegments.push(transcript);
      this.currentInterim = '';
    } else {
      this.currentInterim = transcript;
    }

    // Build SpeechResult (same shape as WebSpeechApiEngine output)
    this.results.transcript = _chunkExpressionReplaceEN(
      this.finalizedSegments.join(' ') + (this.finalizedSegments.length ? ' ' : ''),
    );
    this.results.interimTranscript = this.currentInterim
      ? _chunkExpressionReplaceEN(this.currentInterim + ' ')
      : '';

    this.onResultCallback(this.results);

    // Reload soft-stop inactivity timer
    if (this.softStopTimeout > 0)
      this._reloadInactivityTimeout(this.softStopTimeout, 'continuous-deadline');
  }


  // ── Finalize on close (same edge case as WebSpeechApiEngine) ──

  private _finalizeResults() {
    // Promote remaining interim → final
    if (this.currentInterim && this.currentInterim !== PLACEHOLDER_INTERIM_TRANSCRIPT) {
      this.results.transcript = _chunkExpressionReplaceEN(
        (this.results.transcript.trim() + ' ' + this.currentInterim).trim() + ' ',
      );
    }
    this.results.interimTranscript = '';
    this.results.done = true;
    this.results.doneReason = this.results.doneReason ?? 'api-unknown-timeout';
    this.onResultCallback(this.results);

    this.withinBeginEnd = false;
    this.setState({ isActive: false, hasAudio: false, hasSpeech: false });
  }


  // ── Microphone → linear16 PCM @ 16 kHz → WebSocket ────────────

  private async _startMicrophone() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    this.setState({ hasAudio: true });

    // AudioContext at 16 kHz — resamples from mic's native rate
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Prefer AudioWorklet, fall back to ScriptProcessor
    if (this.audioContext.audioWorklet) {
      try {
        await this._setupAudioWorklet(source);
        return;
      } catch { /* fall through */ }
    }
    this._setupScriptProcessor(source);
  }

  private async _setupAudioWorklet(source: MediaStreamAudioSourceNode) {
    const code = `
      class P extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch) {
            const b = new Int16Array(ch.length);
            for (let i = 0; i < ch.length; i++)
              b[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
            this.port.postMessage(b.buffer, [b.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm', P);
    `;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await this.audioContext!.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.workletNode = new AudioWorkletNode(this.audioContext!, 'pcm');
    this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext!.destination);
  }

  private _setupScriptProcessor(source: MediaStreamAudioSourceNode) {
    this.scriptProcessor = this.audioContext!.createScriptProcessor(4096, 1, 1);
    this.scriptProcessor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const f = e.inputBuffer.getChannelData(0);
      const b = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++)
        b[i] = Math.max(-32768, Math.min(32767, f[i] * 32768));
      this.ws.send(b.buffer);
    };
    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext!.destination);
  }

  private _stopMicrophone() {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.scriptProcessor?.disconnect();
    this.scriptProcessor = null;
    if (this.audioContext?.state !== 'closed')
      this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.setState({ hasAudio: false });
  }


  // ── Inactivity timeout (same pattern as WebSpeechApiEngine) ────

  private _clearInactivityTimeout() {
    if (this.inactivityTimeoutId) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = null;
    }
  }

  private _reloadInactivityTimeout(timeoutMs: number, doneReason: SpeechDoneReason) {
    this._clearInactivityTimeout();
    this.inactivityTimeoutId = setTimeout(() => {
      if (this.disposed) return;
      this.inactivityTimeoutId = null;
      this.results.doneReason = doneReason;
      this._stopMicrophone();
      if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(new ArrayBuffer(0));
      this.ws?.close();
    }, timeoutMs);
  }
}


// Same helper as WebSpeechApiEngine — handles spoken punctuation commands
function _chunkExpressionReplaceEN(fullText: string): string {
  return fullText
    .replaceAll(/\.?\scomma\b/gi, ',')
    .replaceAll(/\.?\speriod\b/gi, '.')
    .replaceAll(/\.?\squestion mark\b/gi, '?')
    .replaceAll(/\.?\sexclamation mark\b/gi, '!');
}
