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
 * Flow: record mic → stop → POST blob to /api/stt/transcribe → get text.
 *
 * The mic stream is pre-warmed on engine creation so that start() is
 * near-instant (no getUserMedia cold-boot). The stream is only released
 * when the engine is disposed.
 */
export class AudioRecorderEngine implements IRecognitionEngine {
  public readonly engineType = 'audioRecorder';

  private onResultCallback: (result: SpeechResult) => void;
  private readonly setState: (state: Partial<SpeechRecognitionState>) => void;

  private preferredLanguage: string;

  private _mediaRecorder: MediaRecorder | null = null;
  private _mediaStream: MediaStream | null = null;
  private audioChunks: BlobPart[] = [];
  private results: SpeechResult = createSpeechRecognitionResults();
  private skipTranscriptionOnStop = false;

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    sampleRate: 16000,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true,
  };

  constructor(
    preferredLanguage: string,
    _softStopTimeoutIgnored: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,
  ) {
    this.preferredLanguage = preferredLanguage;
    this.onResultCallback = onResultCallback;
    this.setState = setState;

    // Pre-warm the mic so start() is instant
    this._warmUpMic();

    setState({ isAvailable: true });
  }

  private async _warmUpMic() {
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) return;

      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: AudioRecorderEngine.AUDIO_CONSTRAINTS,
      });
    } catch (error: any) {
      console.warn('Mic pre-warm failed (will retry on start):', error?.message);
      this._mediaStream = null;
    }
  }

  async start() {
    this.results = createSpeechRecognitionResults();
    this.skipTranscriptionOnStop = false;
    this.audioChunks = [];
    this.onResultCallback(this.results);

    try {
      // Reuse pre-warmed stream, or grab a new one if pre-warm failed
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
        this.setState({ isActive: true, hasAudio: true, hasSpeech: false });
        this.audioChunks = [];
      };

      this._mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this._mediaRecorder.onstop = async () => {
        this.setState({ isActive: false, hasAudio: false, hasSpeech: false });

        const recorderMimeType = this._mediaRecorder?.mimeType || 'audio/webm';

        // Don't release the stream — keep it warm for next recording

        try {
          if (!this.skipTranscriptionOnStop) {
            const audioBlob = new Blob(this.audioChunks, { type: recorderMimeType });
            await this._handleAudioBlob(audioBlob, recorderMimeType);
          }
        } finally {
          if (this._mediaRecorder) {
            this._mediaRecorder.onstart = null;
            this._mediaRecorder.ondataavailable = null;
            this._mediaRecorder.onstop = null;
            this._mediaRecorder.onerror = null;
            this._mediaRecorder = null;
          }
        }
      };

      this._mediaRecorder.onerror = (event) => {
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
    this.skipTranscriptionOnStop = true;

    if (this._mediaRecorder) {
      if (this._mediaRecorder.state !== 'inactive')
        this._mediaRecorder.stop();
      this._mediaRecorder.onstart = null;
      this._mediaRecorder.ondataavailable = null;
      this._mediaRecorder.onstop = null;
      this._mediaRecorder.onerror = null;
      this._mediaRecorder = null;
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

  private async _handleAudioBlob(audioBlob: Blob, mimeType: string) {
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
    this.setState({ errorMessage: message });
    this.results.doneReason = 'api-error';
    this.results.done = true;
    this.onResultCallback(this.results);

    if (this._mediaRecorder && this._mediaRecorder.state === 'recording')
      this._mediaRecorder.stop();

    this.setState({ isActive: false, hasAudio: false, hasSpeech: false });
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
