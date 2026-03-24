/**
 * POST /api/stt/session
 *
 * Creates an ephemeral client secret for the OpenAI Realtime
 * transcription API. The browser uses this short-lived token to
 * open a WebRTC connection directly to OpenAI — your API key
 * never touches the browser.
 *
 * Token TTL is ~60 seconds (enough to complete the WebRTC handshake).
 *
 * Env vars:
 *   STT_API_KEY  – OpenAI API key
 *   STT_MODEL    – e.g. gpt-4o-transcribe (default)
 *   STT_PROMPT   – optional domain prompt for the transcription model
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DEFAULT_PROMPT =
  'Emergency department clinical documentation. '
  + 'Expect medical terminology: cholecystitis, appendicitis, diverticulitis, '
  + 'cellulitis, sepsis, pneumonia, pyelonephritis, pancreatitis, '
  + 'hospitalist, CT, MRI, CBC, BMP, CMP, troponin, lactic acid, '
  + 'DVT, PE, NSTEMI, STEMI, TPA, INR, BNP, procalcitonin, lipase, '
  + 'IV, IM, PO, PRN, q4h, q6h, mg, mL, mcg. '
  + 'Physician names are prefixed with Dr. '
  + 'Use standard medical abbreviations.';

export async function POST(req: Request) {
  const apiKey = process.env.STT_API_KEY;
  if (!apiKey)
    return Response.json({ error: 'Missing STT_API_KEY' }, { status: 500 });

  const model = process.env.STT_MODEL || 'gpt-4o-transcribe';
  const prompt = process.env.STT_PROMPT || DEFAULT_PROMPT;

  let language: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.language === 'string' && body.language.trim()) {
      const tag = body.language.trim().split(/[-_]/)[0]?.toLowerCase();
      if (tag && /^[a-z]{2,3}$/.test(tag)) language = tag;
    }
  } catch { /* no body is fine */ }

  const sessionRes = await fetch(
    'https://api.openai.com/v1/realtime/client_secrets',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              noise_reduction: { type: 'near_field' },
              transcription: {
                model,
                language: language || 'en',
                prompt,
              },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
              },
            },
          },
        },
      }),
    },
  );

  if (!sessionRes.ok) {
    const err = await sessionRes.text().catch(() => sessionRes.statusText);
    console.error('[stt/session] OpenAI error:', err);
    return Response.json(
      { error: 'Failed to create transcription session' },
      { status: 502 },
    );
  }

  const data = await sessionRes.json();
  const token = data?.value;

  if (!token) {
    console.error('[stt/session] Unexpected response shape:', JSON.stringify(data));
    return Response.json(
      { error: 'Unexpected response from OpenAI' },
      { status: 502 },
    );
  }

  return Response.json({
    token,
    expires_at: data.expires_at,
    model,
  });
}
