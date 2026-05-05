import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';


/**
 * Engine which uses the MediaRecorder API → server-side transcription
 * via an OpenAI-compatible /v1/audio/transcriptions endpoint.
 *
 * Supports two modes controlled by the realtimeMode flag:
 *   - Standard:  record → stop → transcribe → done.
 *   - Realtime:  every few seconds, send growing blob for interim text.
 *                On stop, send full blob for final accurate transcript.
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
  private _lastInterimLength = 0;
  private _recorderMimeType = 'audio/webm';

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    sampleRate: 16000,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  };

  private static readonly INTERIM_INTERVAL_MS = 4000;

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
    this._lastInterimLength = 0;
    this.onResultCallback(this.results);

    try {
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

        if (this.realtimeMode) {
          this._interimInterval = setInterval(() => {
            this._sendInterim();
          }, AudioRecorderEngine.INTERIM_INTERVAL_MS);
        }
      };

      this._mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this._mediaRecorder.onstop = async () => {
        if (this.disposed) return;

        this._stopPolling();
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
    this._stopPolling();

    if (this._mediaRecorder) {
      if (this._mediaRecorder.state !== 'inactive')
        this._mediaRecorder.stop();
      this._cleanupRecorder();
    }

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

  // ── Interim polling ────────────────────────────────────────────────

  private _stopPolling() {
    if (this._interimInterval) {
      clearInterval(this._interimInterval);
      this._interimInterval = null;
    }
  }

  private async _sendInterim() {
    if (this.disposed) return;
    if (this.audioChunks.length === 0) return;

    const blob = new Blob([...this.audioChunks], { type: this._recorderMimeType });

    // Skip if too little audio — model will hallucinate
    if (blob.size < 10000) return;

    try {
      const text = await _transcribeViaServer(blob, this._recorderMimeType, this.preferredLanguage);

      if (this.disposed) return;
      if (this._mediaRecorder?.state === 'recording') {
        if (!text.trim()) return;

        // Only update if the new text is longer — prevents flickering
        // from the model re-interpreting earlier audio differently
        if (text.length >= this._lastInterimLength) {
          this._lastInterimLength = text.length;
          this.results.interimTranscript = text;
          this.onResultCallback(this.results);
        }
      }
    } catch {
      // Swallow interim errors
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
    this._stopPolling();
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
