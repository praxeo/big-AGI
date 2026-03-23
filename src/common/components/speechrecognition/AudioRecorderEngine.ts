import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';


/**
 * Engine which uses the MediaRecorder API → server-side transcription
 * via an OpenAI-compatible /v1/audio/transcriptions endpoint
 * (Mistral Voxtral, OpenAI Whisper, self-hosted vLLM, etc.).
 *
 * Supports two modes:
 *   - Standard:  record mic → stop → POST blob → get text.
 *   - Realtime:  while recording, POST a growing audio blob every few
 *                seconds so the user sees interim text progressively.
 *                Includes an in-flight guard so requests never pile up —
 *                if the previous request hasn't returned, the interval
 *                tick is skipped. This lets the polling self-adapt to
 *                provider speed and growing blob size.
 *
 * The mic stream is kept alive between recordings so that start() is
 * near-instant after the first permission grant.
 */
export class AudioRecorderEngine implements IRecognitionEngine {
  public readonly engineType = 'audioRecorder';

  private onResultCallback: (result: SpeechResult) => void;
  private readonly setState: (state: Partial<SpeechRecognitionState>) => void;

  private preferredLanguage: string;
  private readonly realtimeMode: boolean;

  private _mediaRecorder: MediaRecorder | null = null;
  private _mediaStream: MediaStream | null = null;
  private audioChunks: BlobPart[] = [];
  private results: SpeechResult = createSpeechRecognitionResults();
  private skipTranscriptionOnStop = false;
  private disposed = false;

  // Realtime interim polling
  private _interimInterval: ReturnType<typeof setInterval> | null = null;
  private _interimRequestId = 0;
  private _interimInFlight = false;
  private _recorderMimeType = 'audio/webm';

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    sampleRate: 16000,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  // How often to check whether to send an interim transcription request (ms).
  // Actual request cadence self-adapts: if the provider is slower than this
  // interval, ticks are skipped until the in-flight request returns.
  private static readonly INTERIM_INTERVAL_MS = 1000;

  constructor(
    preferredLanguage: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,
    realtimeMode: boolean = false,
  ) {
    this.preferredLanguage = preferredLanguage;
    this.onResultCallback = onResultCallback;
    this.setState = setState;
    this.realtimeMode = realtimeMode;

    setState({ isAvailable: true });
  }

  async start() {
    this.results = createSpeechRecognitionResults();
    this.skipTranscriptionOnStop = false;
    this.disposed = false;
    this.audioChunks = [];
    this._interimRequestId = 0;
    this._interimInFlight = false;
    this.onResultCallback(this.results);

    try {
      // Reuse pre-warmed stream, or grab a new one
      if (!this._mediaStream) {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: AudioRecorderEngine.AUDIO_CONSTRAINTS,
        });
      }

      const stream = this._mediaStream;

      const recorderOptions: MediaRecorderOptions = {};
      if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          recorderOptions.mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          recorderOptions.mimeType = 'audio/ogg;codecs=opus';
        }
      }

      this._mediaRecorder = new MediaRecorder(stream, recorderOptions);

      this._mediaRecorder.onstart = () => {
        if (this.disposed) return;
        this._recorderMimeType = this._mediaRecorder?.mimeType || 'audio/webm';
        this.setState({ isActive: true, hasAudio: true, hasSpeech: false });
        this.audioChunks = [];

        // Start interim polling if in realtime mode
        if (this.realtimeMode) {
          this._startInterimPolling();
        }
      };

      this._mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this._mediaRecorder.onstop = async () => {
        if (this.disposed) return;

        this._stopInterimPolling();
        this.setState({ isActive: false, hasAudio: false, hasSpeech: false });

        try {
          if (!this.skipTranscriptionOnStop) {
            const audioBlob = new Blob(this.audioChunks, { type: this._recorderMimeType });
            await this._handleAudioBlob(audioBlob, this._recorderMimeType);
          }
        } finally {
          this._cleanupRecorder();
        }
      };

      this._mediaRecorder.onerror = (event) => {
        if (this.disposed) return;
        console.error('AudioRecorderEngine error:', event);
        this._handleError('Recording failed.');
      };

      // Flush chunks every 100ms — prevents first-word clipping
      this._mediaRecorder.start(100);
    } catch (error: any) {
      console.error('MediaDevices.getUserMedia error:', error);
      this._handleError('Microphone access denied or not available.');
    }
  }

  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;
    if (this._mediaRecorder && this._mediaRecorder.state === 'recording')
      this._mediaRecorder.stop();
  }

  dispose() {
    this.disposed = true;
    this.skipTranscriptionOnStop = true;
    this._stopInterimPolling();

    if (this._mediaRecorder) {
      if (this._mediaRecorder.state !== 'inactive')
        this._mediaRecorder.stop();
      this._cleanupRecorder();
    }

    // Only release the mic when the engine is fully disposed
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t) => t.stop());
      this._mediaStream = null;
    }
  }

  isBetweenBeginEnd() {
    return !!this._mediaRecorder && this._mediaRecorder.state === 'recording';
  }

  updateConfiguration(
    language: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
  ) {
    this.preferredLanguage = language;
    this.onResultCallback = onResultCallback;
  }

  // ── Realtime interim polling ────────────────────────────────────────

  private _startInterimPolling() {
    this._stopInterimPolling();
    this._interimInFlight = false;
    this._interimInterval = setInterval(() => {
      this._sendInterimRequest();
    }, AudioRecorderEngine.INTERIM_INTERVAL_MS);
  }

  private _stopInterimPolling() {
    if (this._interimInterval) {
      clearInterval(this._interimInterval);
      this._interimInterval = null;
    }
  }

  private async _sendInterimRequest() {
    if (this.disposed) return;
    if (this.audioChunks.length === 0) return;
    if (this._interimInFlight) return;

    // Snapshot current chunks into a blob
    const blob = new Blob([...this.audioChunks], { type: this._recorderMimeType });

    // Monotonic request ID — lets us discard stale responses
    const requestId = ++this._interimRequestId;

    this._interimInFlight = true;
    try {
      const text = await _transcribeViaServer(blob, this._recorderMimeType, this.preferredLanguage);

      // Discard if disposed, or if a newer request has already landed
      if (this.disposed) return;
      if (requestId < this._interimRequestId) return;

      // Only update interim while still recording
      if (this._mediaRecorder?.state === 'recording') {
        this.results.interimTranscript = text;
        this.onResultCallback(this.results);
      }
    } catch {
      // Swallow interim errors — the final transcription is what matters
    } finally {
      this._interimInFlight = false;
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async _handleAudioBlob(audioBlob: Blob, mimeType: string) {
    if (this.disposed) return;
    try {
      this.results.transcript = await _transcribeViaServer(audioBlob, mimeType, this.preferredLanguage);
      this.results.interimTranscript = '';
      this.results.done = true;
      this.results.doneReason = this.results.doneReason ?? 'api-unknown-timeout';
      this.onResultCallback(this.results);
    } catch (error: any) {
      console.error('Recognition error:', error);
      this._handleError('Recognition failed: ' + (error?.message ?? String(error)));
    }
  }

  private _handleError(message: string) {
    this.skipTranscriptionOnStop = true;
    this._stopInterimPolling();
    this.setState({ errorMessage: message });
    this.results.doneReason = 'api-error';
    this.results.done = true;
    this.onResultCallback(this.results);

    if (this._mediaRecorder && this._mediaRecorder.state === 'recording')
      this._mediaRecorder.stop();

    this.setState({ isActive: false, hasAudio: false, hasSpeech: false });
  }

  private _cleanupRecorder() {
    if (this._mediaRecorder) {
      this._mediaRecorder.onstart = null;
      this._mediaRecorder.ondataavailable = null;
      this._mediaRecorder.onstop = null;
      this._mediaRecorder.onerror = null;
      this._mediaRecorder = null;
    }
  }
}


function _extensionForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

function _normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const trimmed = lang.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/[-_]/)[0]?.toLowerCase() || undefined;
}

async function _transcribeViaServer(
  audioBlob: Blob,
  mimeType: string,
  preferredLanguage?: string,
): Promise<string> {
  const ext = _extensionForMime(mimeType);
  const formData = new FormData();
  formData.append('file', audioBlob, `recording.${ext}`);

  const normalizedLang = _normalizeLanguage(preferredLanguage);
  if (normalizedLang)
    formData.append('language', normalizedLang);

  const response = await fetch('/api/stt/transcribe', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let details = response.statusText;
    try {
      const errData = await response.json();
      details = errData?.details || errData?.error || details;
    } catch {
      try { details = await response.text(); } catch { /* ignore */ }
    }
    throw new Error(`Transcription failed (${response.status}): ${details}`);
  }

  const data = await response.json();
  return data?.text ?? '';
}
