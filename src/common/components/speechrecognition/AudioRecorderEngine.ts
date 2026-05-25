import {
  createSpeechRecognitionResults,
  IRecognitionEngine,
  SpeechDoneReason,
  SpeechRecognitionState,
  SpeechResult,
} from './useSpeechRecognition';

/**
 * Batch audio-recorder speech recognition engine.
 *
 * Flow:
 *   1. Record microphone audio with the browser MediaRecorder API.
 *   2. On stop, send the complete audio blob to /api/stt/transcribe.
 *   3. The server route performs provider-specific transcription.
 *
 * This engine is intentionally provider-neutral:
 *   - No OpenAI API details here.
 *   - No ElevenLabs API details here.
 *   - No API keys here.
 *
 * For ElevenLabs Scribe v2 batch transcription, /api/stt/transcribe should
 * proxy to:
 *
 *   POST https://api.elevenlabs.io/v1/speech-to-text
 *
 * This implementation is batch-only. It does not do interim polling or
 * pseudo-realtime transcription.
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
  private disposed = false;

  private _recorderMimeType = 'audio/webm';

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    sampleRate: 16000,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  };

  constructor(
    preferredLanguage: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,

    /**
     * Kept only for backwards compatibility with existing call sites.
     *
     * This engine is intentionally batch-only. Passing true here will not
     * enable interim transcription.
     */
    _realtimeMode: boolean = false,
  ) {
    this.preferredLanguage = preferredLanguage;
    this.onResultCallback = onResultCallback;
    this.setState = setState;

    setState({ isAvailable: true });
  }

  async start() {
    this.results = createSpeechRecognitionResults();
    this.skipTranscriptionOnStop = false;
    this.disposed = false;
    this.audioChunks = [];

    this.onResultCallback(this.results);

    try {
      if (!this._mediaStream) {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: AudioRecorderEngine.AUDIO_CONSTRAINTS,
        });
      }

      const recorderOptions = this._getRecorderOptions();

      this._mediaRecorder = new MediaRecorder(this._mediaStream, recorderOptions);

      this._mediaRecorder.onstart = () => {
        if (this.disposed) return;

        this._recorderMimeType = this._mediaRecorder?.mimeType || 'audio/webm';
        this.audioChunks = [];

        this.setState({
          isActive: true,
          hasAudio: true,
          hasSpeech: false,
        });
      };

      this._mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this._mediaRecorder.onstop = async () => {
        if (this.disposed) return;

        this.setState({
          isActive: false,
          hasAudio: false,
          hasSpeech: false,
        });

        try {
          if (!this.skipTranscriptionOnStop) {
            const audioBlob = new Blob(this.audioChunks, {
              type: this._recorderMimeType,
            });

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

      /**
       * The 100ms timeslice makes dataavailable fire regularly while recording.
       * We still only send one complete blob after stop.
       */
      this._mediaRecorder.start(100);
    } catch (error: any) {
      console.error('MediaDevices.getUserMedia error:', error);
      this._handleError('Microphone access denied or not available.');
    }
  }

  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;

    if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
      /**
       * Ask the browser to flush its current recording buffer before stop.
       * stop() should still trigger the final dataavailable event.
       */
      try {
        this._mediaRecorder.requestData();
      } catch {
        // Some browsers can throw if requestData() is called at the wrong time.
        // stop() will still produce the final dataavailable event.
      }

      this._mediaRecorder.stop();
    }
  }

  dispose() {
    this.disposed = true;
    this.skipTranscriptionOnStop = true;

    if (this._mediaRecorder) {
      if (this._mediaRecorder.state !== 'inactive') {
        try {
          this._mediaRecorder.stop();
        } catch {
          // Ignore shutdown errors.
        }
      }

      this._cleanupRecorder();
    }

    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((track) => track.stop());
      this._mediaStream = null;
    }

    this.audioChunks = [];

    this.setState({
      isActive: false,
      hasAudio: false,
      hasSpeech: false,
    });
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

  private _getRecorderOptions(): MediaRecorderOptions {
    const recorderOptions: MediaRecorderOptions = {};

    if (
      typeof MediaRecorder === 'undefined' ||
      typeof MediaRecorder.isTypeSupported !== 'function'
    ) {
      return recorderOptions;
    }

    /**
     * Prefer Opus-in-WebM where available, but include Ogg and MP4 fallbacks.
     *
     * The server route should send file_format=other to ElevenLabs because
     * these are encoded browser audio containers, not raw PCM.
     */
    const preferredMimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
    ];

    const supportedMimeType = preferredMimeTypes.find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    );

    if (supportedMimeType) {
      recorderOptions.mimeType = supportedMimeType;
    }

    return recorderOptions;
  }

  private async _handleAudioBlob(audioBlob: Blob, mimeType: string) {
    if (this.disposed) return;

    if (audioBlob.size <= 0) {
      this._handleError('No audio was recorded.');
      return;
    }

    try {
      this.results.transcript = await _transcribeViaServer(
        audioBlob,
        mimeType,
        this.preferredLanguage,
      );

      this.results.interimTranscript = '';
      this.results.done = true;
      this.results.doneReason =
        this.results.doneReason ?? 'api-unknown-timeout';

      this.onResultCallback(this.results);
    } catch (error: any) {
      console.error('Recognition error:', error);

      this._handleError(
        'Recognition failed: ' + (error?.message ?? String(error)),
      );
    }
  }

  private _handleError(message: string) {
    this.skipTranscriptionOnStop = true;

    this.setState({
      errorMessage: message,
      isActive: false,
      hasAudio: false,
      hasSpeech: false,
    });

    this.results.doneReason = 'api-error';
    this.results.done = true;

    this.onResultCallback(this.results);

    if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
      try {
        this._mediaRecorder.stop();
      } catch {
        // Ignore shutdown errors.
      }
    }
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
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('mp3')) return 'mp3';
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
  if (normalizedLang) {
    formData.append('language', normalizedLang);
  }

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
      try {
        details = await response.text();
      } catch {
        // Ignore secondary error.
      }
    }

    throw new Error(`Transcription failed (${response.status}): ${details}`);
  }

  const data = await response.json();

  return data?.text ?? '';
}
