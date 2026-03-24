export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4o-transcribe';

const DEFAULT_PROMPT =
  'Emergency department clinical documentation. '
  + 'Expect medical terminology: cholecystitis, appendicitis, diverticulitis, '
  + 'cellulitis, sepsis, pneumonia, pyelonephritis, pancreatitis, '
  + 'hospitalist, CT, MRI, CBC, BMP, CMP, troponin, lactic acid, '
  + 'DVT, PE, NSTEMI, STEMI, TPA, INR, BNP, procalcitonin, lipase, '
  + 'IV, IM, PO, PRN, q4h, q6h, mg, mL, mcg. '
  + 'Physician names are prefixed with Dr. '
  + 'Use standard medical abbreviations.';

function normalizeLanguage(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/[-_]/)[0]?.toLowerCase() || undefined;
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText || 'Unknown upstream error';
  } catch {
    return res.statusText || 'Unknown upstream error';
  }
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.STT_API_KEY;
    if (!apiKey)
      return Response.json({ error: 'Server is missing STT_API_KEY.' }, { status: 500 });

    const baseUrl = (process.env.STT_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = process.env.STT_MODEL || DEFAULT_MODEL;
    const prompt = process.env.STT_PROMPT || DEFAULT_PROMPT;

    const incomingForm = await req.formData();
    const maybeFile = incomingForm.get('file');
    const maybeLanguage = incomingForm.get('language');

    if (
      !maybeFile ||
      typeof maybeFile === 'string' ||
      typeof (maybeFile as any).arrayBuffer !== 'function'
    )
      return Response.json({ error: 'Missing audio file upload.' }, { status: 400 });

    const file = maybeFile as File;
    const language = normalizeLanguage(
      typeof maybeLanguage === 'string' ? maybeLanguage : null,
    );

    const upstreamForm = new FormData();
    upstreamForm.append('model', model);
    upstreamForm.append('file', file, file.name || 'audio.webm');
    if (language)
      upstreamForm.append('language', language);

    const prompt = process.env.STT_PROMPT;
    if (prompt)
      upstreamForm.append('prompt', prompt);

    const upstreamUrl = `${baseUrl}/v1/audio/transcriptions`;

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
      cache: 'no-store',
    });

    if (!upstreamRes.ok) {
      const errorBody = await safeErrorBody(upstreamRes);
      console.error(`[stt/transcribe] Upstream ${upstreamRes.status}:`, errorBody);
      return Response.json(
        { error: 'Transcription provider returned an error.', details: errorBody, status: upstreamRes.status },
        { status: upstreamRes.status },
      );
    }

    const data = await upstreamRes.json();

    return Response.json({
      text: typeof data?.text === 'string' ? data.text.trim() : '',
      language: typeof data?.language === 'string' ? data.language : null,
      model: typeof data?.model === 'string' ? data.model : model,
      segments: Array.isArray(data?.segments) ? data.segments : [],
      usage: data?.usage ?? null,
    });
  } catch (error: any) {
    console.error('[stt/transcribe] Unexpected error:', error);
    return Response.json(
      { error: 'Unexpected server error during transcription.', details: error?.message ?? String(error) },
      { status: 500 },
    );
  }
}
