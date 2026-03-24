// src/common/components/speechrecognition/CloudflareSTTEngine.ts

import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  PLACEHOLDER_INTERIM_TRANSCRIPT,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';


// AI Gateway config — set these in Vercel env vars
const CF_ACCOUNT_ID = process.env.NEXT_PUBLIC_CF_ACCOUNT_ID || '';
const CF_GATEWAY_ID = process.env.NEXT_PUBLIC_CF_GATEWAY_ID || '';
const CF_API_TOKEN = process.env.NEXT_PUBLIC_CF_API_TOKEN || '';


export class CloudflareSTTEngine implements IRecognitionEngine {
  public readonly engineType = 'cloudflareStt' as const;

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
    _workerUrl: string, // kept for interface compat, ignored now
    preferredLanguage: string,
    softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,
  ) {
    this.language = preferredLanguage;
    this.softStopTimeout = softStopTimeout;
    this.onResultCallback = onResultCallback;
    this.setState = setState;
    this.results = createSpeechRecognitionResults();
    setState({ isAvailable: true });
  }


  start() {
    if (this.disposed || this.withinBeginEnd) return;

    this.withinBeginEnd = true;
    this.wsReady = false;
    this.audioBuffer = [];

    this.results = createSpeechRecognitionResults();
    this.results.flagSendOnDone = undefined;
    this.onResultCallback(this.results);
    this.finalizedSegments = [];
    this.currentInterim = '';

    this.setState({ isActive: true });

    // Start mic immediately
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

    // Connect DIRECTLY to AI Gateway — no worker relay
    const gwUrl =
      'wss://gateway.ai.cloudflare.com/v1/'
      + CF_ACCOUNT_ID + '/'
      + CF_GATEWAY_ID
      + '/workers-ai'
      + '?model=@cf/deepgram/nova-3'
      + '&encoding=linear16'
      + '&sample_rate=16000'
      + '&language=' + encodeURIComponent(this.language)
      + '&interim_results=true'
      + '&endpointing=300'
      + '&utterance_end_ms=1000'
      + '&vad_events=true'
      + '&punctuate=true'
      + '&smart_format=true';

    // Auth via subprotocol (official docs pattern for browsers)
    this.ws = new WebSocket(gwUrl, [
      'cf-aig-authorization.' + CF_API_TOKEN,
    ]);

    this.ws.onopen = () => {
      if (this.disposed || !this.withinBeginEnd) {
        this.ws?.close();
        return;
      }
      this.wsReady = true;

      // Flush buffered audio
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
      this.setState({ errorMessage: 'Connection to Cloudflare STT failed.' });
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


  private _shutdown() {
    this._clearInactivityTimeout();
    this._stopMicrophone();
    this.audioBuffer = [];
    this.wsReady = false;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(new ArrayBuffer(0)); } catch { /* ignore */ }
      this.ws.close();
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    } else {
      this._finalizeResults();
    }
  }


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

    const transcript = (alt.transcript || '').trim();
    if (!transcript) return;

    const isFinal = data.is_final === true;

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
