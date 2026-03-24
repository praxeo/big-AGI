// src/common/components/speechrecognition/CloudflareSTTEngine.ts

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

  private workerUrl: string;
  private language: string;
  private softStopTimeout: number;
  private onResultCallback: (result: SpeechResult) => void;
  private setState: (state: Partial<SpeechRecognitionState>) => void;

  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private mediaStream: MediaStream | null = null;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private results: SpeechResult;
  private withinBeginEnd = false;
  private disposed = false;

  private audioBuffer: ArrayBuffer[] = [];
  private wsReady = false;

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


  start() {
    if (this.disposed || this.withinBeginEnd) return;

    // Set IMMEDIATELY so stop() works right away
    this.withinBeginEnd = true;
    this.wsReady = false;
    this.audioBuffer = [];

    this.results = createSpeechRecognitionResults();
    this.results.flagSendOnDone = undefined;
    this.onResultCallback(this.results);
    this.finalizedSegments = [];
    this.currentInterim = '';

    this.setState({ isActive: true });

    // Start mic IMMEDIATELY — don't wait for WebSocket
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
      this._shutdown();
    });

    // Connect WebSocket in parallel
    const wsUrl = new URL(this.workerUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!wsUrl.pathname.endsWith('/transcribe'))
      wsUrl.pathname = wsUrl.pathname.replace(/\/$/, '') + '/transcribe';
    wsUrl.searchParams.set('language', this.language);

    this.ws = new WebSocket(wsUrl.toString());

    this.ws.onopen = () => {
      if (this.disposed || !this.withinBeginEnd) {
        this.ws?.close();
        return;
      }
      this.wsReady = true;

      // Flush buffered audio captured while WS was connecting
      for (const chunk of this.audioBuffer) {
        if (this.ws?.readyState === WebSocket.OPEN)
          this.ws.send(chunk);
      }
      this.audioBuffer = [];
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
    if (!this.withinBeginEnd) return;
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;
    this._shutdown();
  }


  dispose() {
    this.disposed = true;
    this._clearInactivityTimeout();
    this._stopMicrophone();
    if (this.withinBeginEnd) {
      this.withinBeginEnd = false;
      this.results.doneReason = 'react-unmount';
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
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


  // ── Shutdown ───────────────────────────────────────────────────

  private _shutdown() {
    this._clearInactivityTimeout();
    this._stopMicrophone();
    this.audioBuffer = [];
    this.wsReady = false;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(new ArrayBuffer(0)); } catch { /* ignore */ }
      this.ws.close();
      // onclose will call _finalizeResults()
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      // WS hasn't opened yet — force close, onclose will fire
      this.ws.close();
    } else {
      // No WS or already closed — finalize directly
      this._finalizeResults();
    }
  }


  // ── Deepgram message handling ──────────────────────────────────

  private _handleDeepgramMessage(data: any) {

    if (data.type === 'SpeechStarted') {
      this.setState({ hasSpeech: true });
      return;
    }

    if (data.type === 'UtteranceEnd') {
      this.setState({ hasSpeech: false });
      return;
    }

    if (data.type === 'Metadata') return;

    const alt = data?.channel?.alternatives?.[0];
    if (!alt) return;

    let transcript = (alt.transcript || '').trim();
    if (!transcript) return; // skip empty results

    const isFinal = data.is_final === true;

    // Client-side punctuation fallback (in case worker can't pass punctuate param)
    if (isFinal && transcript.length >= 2) {
      transcript = transcript.charAt(0).toUpperCase() + transcript.slice(1);
      if (!/[.!?;:,]$/.test(transcript))
        transcript += '.';
    }

    if (isFinal) {
      this.finalizedSegments.push(transcript);
      this.currentInterim = '';
    } else {
      this.currentInterim = transcript;
    }

    this.results.transcript = _chunkExpressionReplaceEN(
      this.finalizedSegments.join(' ') + (this.finalizedSegments.length ? ' ' : ''),
    );
    this.results.interimTranscript = this.currentInterim
      ? _chunkExpressionReplaceEN(this.currentInterim + ' ')
      : '';

    this.onResultCallback(this.results);

    if (this.softStopTimeout > 0)
      this._reloadInactivityTimeout(this.softStopTimeout, 'continuous-deadline');
  }


  // ── Finalize ───────────────────────────────────────────────────

  private _finalizeResults() {
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


  // ── Microphone → linear16 PCM @ 16 kHz ────────────────────────

  private _sendOrBuffer(data: ArrayBuffer) {
    if (this.wsReady && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.audioBuffer.push(data);
    }
  }

  private async _startMicrophone() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    if (this.disposed || !this.withinBeginEnd) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
      return;
    }
    this.setState({ hasAudio: true });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

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
      this._sendOrBuffer(e.data);
    };
    source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext!.destination);
  }

  private _setupScriptProcessor(source: MediaStreamAudioSourceNode) {
    this.scriptProcessor = this.audioContext!.createScriptProcessor(4096, 1, 1);
    this.scriptProcessor.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0);
      const b = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++)
        b[i] = Math.max(-32768, Math.min(32767, f[i] * 32768));
      this._sendOrBuffer(b.buffer);
    };
    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext!.destination);
  }

  private _stopMicrophone() {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.scriptProcessor?.disconnect();
    this.scriptProcessor = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.setState({ hasAudio: false });
  }


  // ── Inactivity timeout ────────────────────────────────────────

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
      this._shutdown();
    }, timeoutMs);
  }
}


function _chunkExpressionReplaceEN(fullText: string): string {
  return fullText
    .replaceAll(/\.?\scomma\b/gi, ',')
    .replaceAll(/\.?\speriod\b/gi, '.')
    .replaceAll(/\.?\squestion mark\b/gi, '?')
    .replaceAll(/\.?\sexclamation mark\b/gi, '!');
}
