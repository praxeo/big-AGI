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
 *   1. Record microphone audio with MediaRecorder.
 *   2. On stop, send the complete audio blob to /api/stt/transcribe.
 *   3. Server route performs provider-specific transcription.
 *
 * This is intentionally batch-only.
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
  private _recordingStartedAtMs = 0;

  private _transcriptionAbortController: AbortController | null = null;

  private static readonly AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  };

  private static readonly AUDIO_BITS_PER_SECOND = 128000;
  private static readonly MEDIA_RECORDER_TIMESLICE_MS = 1000;

  private static readonly MIN_TRANSCRIBE_MS = 1200;
  private static readonly MIN_TRANSCRIBE_BYTES = 4000;

  constructor(
    preferredLanguage: string,
    _softStopTimeout: number,
    onResultCallback: (result: SpeechResult) => void,
    setState: (state: Partial<SpeechRecognitionState>) => void,

    /**
     * Kept for backwards compatibility with existing call sites.
     * This engine is batch-only. This argument is intentionally ignored.
     */
    _realtimeMode: boolean = false,
  ) {
    this.preferredLanguage = preferredLanguage;
    this.onResultCallback = onResultCallback;
    this.setState = setState;

    setState({ isAvailable: true });
  }

  async start() {
    if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
      return;
    }

    this._abortPendingTranscription();

    this.results = createSpeechRecognitionResults();
    this.skipTranscriptionOnStop = false;
    this.disposed = false;
    this.audioChunks = [];
    this._recordingStartedAtMs = 0;

    this.onResultCallback(this.results);

    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        throw new Error('MediaDevices.getUserMedia is not available.');
      }

      if (!this._hasLiveAudioStream()) {
        this._stopMediaStream();

        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: AudioRecorderEngine.AUDIO_CONSTRAINTS,
        });
      }

      const recorderOptions = this._getRecorderOptions();

      this._mediaRecorder = new MediaRecorder(this._mediaStream!, recorderOptions);

      this._mediaRecorder.onstart = () => {
        if (this.disposed) return;

        this._recordingStartedAtMs = Date.now();
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

      this._mediaRecorder.start(AudioRecorderEngine.MEDIA_RECORDER_TIMESLICE_MS);
    } catch (error: any) {
      console.error('MediaDevices.getUserMedia error:', error);
      this._handleError('Microphone access denied or not available.');
    }
  }

  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    this.results.doneReason = reason;
    this.results.flagSendOnDone = sendOnDone;

    if (
      this._mediaRecorder &&
      (this._mediaRecorder.state === 'recording' || this._mediaRecorder.state === 'paused')
    ) {
      try {
        this._mediaRecorder.requestData();
      } catch {
        // Ignore requestData errors.
      }

      try {
        this._mediaRecorder.stop();
      } catch (error) {
        console.warn('AudioRecorderEngine stop failed:', error);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.skipTranscriptionOnStop = true;

    this._abortPendingTranscription();

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

    this._stopMediaStream();

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
    const recorderOptions: MediaRecorderOptions = {
      audioBitsPerSecond: AudioRecorderEngine.AUDIO_BITS_PER_SECOND,
    };

    if (
      typeof MediaRecorder === 'undefined' ||
      typeof MediaRecorder.isTypeSupported !== 'function'
    ) {
      return recorderOptions;
    }

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

  private _hasLiveAudioStream(): boolean {
    if (!this._mediaStream) return false;

    return this._mediaStream
      .getAudioTracks()
      .some((track) => track.readyState === 'live');
  }

  private _stopMediaStream() {
    if (!this._mediaStream) return;

    this._mediaStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore track shutdown errors.
      }
    });

    this._mediaStream = null;
  }

  private async _handleAudioBlob(audioBlob: Blob, mimeType: string) {
    if (this.disposed) return;

    const recordingDurationMs = this._recordingStartedAtMs
      ? Date.now() - this._recordingStartedAtMs
      : 0;

    if (
      audioBlob.size <= 0 ||
      recordingDurationMs < AudioRecorderEngine.MIN_TRANSCRIBE_MS ||
      audioBlob.size < AudioRecorderEngine.MIN_TRANSCRIBE_BYTES
    ) {
      this.results.transcript = '';
      this.results.interimTranscript = '';
      this.results.done = true;
      this.results.doneReason =
        this.results.doneReason ?? 'api-unknown-timeout';

      this.onResultCallback(this.results);
      return;
    }

    const abortController = new AbortController();
    this._transcriptionAbortController = abortController;

    try {
      const transcript = await _transcribeViaServer(
        audioBlob,
        mimeType,
        this.preferredLanguage,
        abortController.signal,
      );

      if (this.disposed || abortController.signal.aborted) return;

      this.results.transcript = transcript;
      this.results.interimTranscript = '';
      this.results.done = true;
      this.results.doneReason =
        this.results.doneReason ?? 'api-unknown-timeout';

      this.onResultCallback(this.results);
    } catch (error: any) {
      if (this.disposed || abortController.signal.aborted) return;

      console.error('Recognition error:', error);

      this._handleError(
        'Recognition failed: ' + (error?.message ?? String(error)),
      );
    } finally {
      if (this._transcriptionAbortController === abortController) {
        this._transcriptionAbortController = null;
      }
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

  private _abortPendingTranscription() {
    if (!this._transcriptionAbortController) return;

    try {
      this._transcriptionAbortController.abort();
    } catch {
      // Ignore abort errors.
    } finally {
      this._transcriptionAbortController = null;
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
  signal?: AbortSignal,
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
    signal,
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
