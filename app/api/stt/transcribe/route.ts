export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'scribe_v2';

function normalizeLanguage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const tag = trimmed.split(/[-_]/)[0]?.toLowerCase();
  if (!tag || !/^[a-z]{2,3}$/.test(tag)) return undefined;

  return tag;
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback;

  const value = raw.trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;

  return fallback;
}

function parseEnumEnv<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!raw) return fallback;

  const value = raw.trim() as T;
  return allowed.includes(value) ? value : fallback;
}

function parseNumberEnv(
  raw: string | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw == null || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;

  return value;
}

function normalizeKeyterm(term: string): string | null {
  const cleaned = term
    /**
     * ElevenLabs keyterms do not support:
     *   < > { } [ ] \
     */
    .replace(/[<>{}[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  /**
   * ElevenLabs batch Scribe v2 keyterm constraints:
   *   - less than 50 characters
   *   - at most 5 words after normalization
   */
  if (cleaned.length >= 50) return null;
  if (cleaned.split(/\s+/).filter(Boolean).length > 5) return null;

  return cleaned;
}

/**
 * Optional ElevenLabs keyterm parser.
 *
 * Important:
 *   - This route sends no keyterms unless ELEVENLABS_STT_KEYTERMS is set.
 *   - ElevenLabs calls these "keyterms", not prompts.
 *
 * Accepts either:
 *
 *   ELEVENLABS_STT_KEYTERMS=troponin,D-dimer,ceftriaxone
 *
 * or:
 *
 *   ELEVENLABS_STT_KEYTERMS=["troponin","D-dimer","ceftriaxone"]
 */
function parseKeyterms(raw: string | undefined): string[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  let candidates: string[] = [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        candidates = parsed.map((item) => String(item));
      }
    } catch {
      candidates = [];
    }
  }

  if (candidates.length === 0) {
    candidates = trimmed.split(/[\n,;|]+/g);
  }

  const seen = new Set<string>();
  const keyterms: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeKeyterm(candidate);
    if (!normalized) continue;

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    keyterms.push(normalized);

    if (keyterms.length >= 1000) break;
  }

  return keyterms;
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await res.json();

      if (typeof data?.detail === 'string') return data.detail;
      if (typeof data?.detail?.message === 'string') return data.detail.message;
      if (typeof data?.message === 'string') return data.message;
      if (typeof data?.error === 'string') return data.error;

      return JSON.stringify(data);
    }

    return (await res.text()) || res.statusText || 'Unknown upstream error';
  } catch {
    return res.statusText || 'Unknown upstream error';
  }
}

function extractTranscriptText(data: any): string {
  if (typeof data?.text === 'string') {
    return data.text.trim();
  }

  /**
   * Defensive fallback if use_multi_channel is ever enabled in the future.
   * This route defaults use_multi_channel to false.
   */
  if (Array.isArray(data?.transcripts)) {
    return data.transcripts
      .map((item: any) => (typeof item?.text === 'string' ? item.text.trim() : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return Response.json(
        { error: 'Server is missing ELEVENLABS_API_KEY.' },
        { status: 500 },
      );
    }

    const baseUrl = (
      process.env.ELEVENLABS_API_BASE_URL ||
      process.env.ELEVENLABS_STT_API_BASE_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    const model = (process.env.ELEVENLABS_STT_MODEL || DEFAULT_MODEL).trim();

    if (model !== 'scribe_v2') {
      return Response.json(
        {
          error: 'Invalid ELEVENLABS_STT_MODEL.',
          details: 'For this batch route, set ELEVENLABS_STT_MODEL=scribe_v2.',
        },
        { status: 500 },
      );
    }

    const incomingForm = await req.formData();

    const maybeFile = incomingForm.get('file');
    const maybeLanguage = incomingForm.get('language');

    if (
      !maybeFile ||
      typeof maybeFile === 'string' ||
      typeof (maybeFile as any).arrayBuffer !== 'function'
    ) {
      return Response.json(
        { error: 'Missing audio file upload.' },
        { status: 400 },
      );
    }

    const file = maybeFile as File;

    if (file.size <= 0) {
      return Response.json(
        { error: 'Uploaded audio file is empty.' },
        { status: 400 },
      );
    }

    const incomingLanguage = normalizeLanguage(maybeLanguage);
    const fallbackLanguage = normalizeLanguage(process.env.ELEVENLABS_STT_LANGUAGE_CODE);
    const languageCode = incomingLanguage || fallbackLanguage;

    /**
     * Dictation cleanup:
     *
     * no_verbatim=true:
     *   Removes filler words, false starts, and non-speech sounds.
     *
     * tag_audio_events=false:
     *   Prevents tags such as (laughter), (footsteps), etc. from appearing.
     */
    const noVerbatim = parseBooleanEnv(
      process.env.ELEVENLABS_STT_NO_VERBATIM,
      true,
    );

    const tagAudioEvents = parseBooleanEnv(
      process.env.ELEVENLABS_STT_TAG_AUDIO_EVENTS,
      false,
    );

    const diarize = parseBooleanEnv(
      process.env.ELEVENLABS_STT_DIARIZE,
      false,
    );

    const useMultiChannel = parseBooleanEnv(
      process.env.ELEVENLABS_STT_USE_MULTI_CHANNEL,
      false,
    );

    const timestampsGranularity = parseEnumEnv(
      process.env.ELEVENLABS_STT_TIMESTAMPS_GRANULARITY,
      ['none', 'word', 'character'] as const,
      'none',
    );

    const temperature = parseNumberEnv(
      process.env.ELEVENLABS_STT_TEMPERATURE,
      0,
      0,
      2,
    );

    /**
     * ElevenLabs API reference:
     *   enable_logging=false uses zero-retention mode, but may only be usable
     *   by enterprise customers. If not enterprise / not using zero-retention,
     *   leave this as true.
     */
    const enableLogging = parseBooleanEnv(
      process.env.ELEVENLABS_STT_ENABLE_LOGGING,
      true,
    );

    /**
     * Optional only.
     * Blank/unset ELEVENLABS_STT_KEYTERMS means no keyterms are sent.
     */
    const keyterms = parseKeyterms(process.env.ELEVENLABS_STT_KEYTERMS);

    const upstreamForm = new FormData();

    upstreamForm.append('model_id', model);

    /**
     * Browser MediaRecorder gives us encoded audio such as WebM/Opus,
     * Ogg/Opus, or MP4/AAC.
     *
     * That is not raw 16-bit PCM, so file_format=other.
     */
    upstreamForm.append('file_format', 'other');

    upstreamForm.append('file', file, file.name || 'audio.webm');

    if (languageCode) {
      upstreamForm.append('language_code', languageCode);
    }

    /**
     * Synchronous batch transcription.
     */
    upstreamForm.append('webhook', 'false');

    /**
     * Dictation-oriented settings.
     */
    upstreamForm.append('no_verbatim', String(noVerbatim));
    upstreamForm.append('tag_audio_events', String(tagAudioEvents));

    /**
     * Keep response smaller and avoid unused metadata.
     */
    upstreamForm.append('timestamps_granularity', timestampsGranularity);
    upstreamForm.append('diarize', String(diarize));
    upstreamForm.append('use_multi_channel', String(useMultiChannel));

    if (temperature !== undefined) {
      upstreamForm.append('temperature', String(temperature));
    }

    /**
     * ElevenLabs keyterms.
     *
     * Do not confuse these with prompts. This route sends no keyterms unless
     * ELEVENLABS_STT_KEYTERMS is set.
     */
    for (const keyterm of keyterms) {
      upstreamForm.append('keyterms', keyterm);
    }

    const upstreamUrl = new URL(`${baseUrl}/v1/speech-to-text`);
    upstreamUrl.searchParams.set('enable_logging', String(enableLogging));

    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: upstreamForm,
      cache: 'no-store',
    });

    if (!upstreamRes.ok) {
      const errorBody = await safeErrorBody(upstreamRes);

      console.error(`[stt/transcribe] ElevenLabs ${upstreamRes.status}:`, errorBody);

      return Response.json(
        {
          error: 'ElevenLabs transcription provider returned an error.',
          details: errorBody,
          status: upstreamRes.status,
        },
        { status: upstreamRes.status },
      );
    }

    const data = await upstreamRes.json();
    const text = extractTranscriptText(data);

    return Response.json({
      text,
      language: typeof data?.language_code === 'string' ? data.language_code : null,
      language_probability:
        typeof data?.language_probability === 'number'
          ? data.language_probability
          : null,
      model,
      provider: 'elevenlabs',
      words: Array.isArray(data?.words) ? data.words : [],
      segments: [],

      /**
       * Rollout/debug fields.
       * You may remove these after confirming everything works.
       */
      keyterms_count: keyterms.length,
      no_verbatim: noVerbatim,
      tag_audio_events: tagAudioEvents,
    });
  } catch (error: any) {
    console.error('[stt/transcribe] Unexpected error:', error);

    return Response.json(
      {
        error: 'Unexpected server error during transcription.',
        details: error?.message ?? String(error),
      },
      { status: 500 },
    );
  }
}
