/**
 * POST /api/stt/session
 *
 * Two-step server-side proxy:
 *   1. Creates an ephemeral token with full session config
 *   2. Uses that token to exchange SDP with OpenAI
 *
 * The browser sends its SDP offer here and gets an SDP answer back.
 * Session config (model, prompt, VAD) is baked into the ephemeral
 * token so the session starts fully configured — no data channel
 * setup needed.
 *
 * Env vars:
 *   STT_API_KEY  – OpenAI API key
 *   STT_MODEL    – e.g. gpt-4o-transcribe (default)
 *   STT_PROMPT   – optional domain prompt override
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

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/sdp'))
    return Response.json({ error: 'Expected Content-Type: application/sdp' }, { status: 400 });

  const offerSdp = await req.text();
  if (!offerSdp.trim())
    return Response.json({ error: 'Empty SDP offer' }, { status: 400 });

  const url = new URL(req.url);
  const langParam = url.searchParams.get('lang');
  let language = 'en';
  if (langParam) {
    const tag = langParam.trim().split(/[-_]/)[0]?.toLowerCase();
    if (tag && /^[a-z]{2,3}$/.test(tag)) language = tag;
  }

  const eagerness = ['low', 'medium', 'high'].includes(url.searchParams.get('eagerness') || '')
    ? url.searchParams.get('eagerness')!
    : 'medium';

  // ── Step 1: Create ephemeral token with full session config ──────
  const secretRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
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
            transcription: { model, language, prompt },
            turn_detection: { type: 'semantic_vad', eagerness },
          },
        },
      },
    }),
  });

  if (!secretRes.ok) {
    const err = await secretRes.text().catch(() => secretRes.statusText);
    console.error('[stt/session] Token creation error:', err);
    return Response.json(
      { error: 'Failed to create session token', details: err },
      { status: 502 },
    );
  }

  const secretData = await secretRes.json();
  const ephemeralToken = secretData?.value;
  if (!ephemeralToken) {
    console.error('[stt/session] No token in response:', JSON.stringify(secretData));
    return Response.json({ error: 'No token received' }, { status: 502 });
  }

  // ── Step 2: SDP exchange using ephemeral token ───────────────────
  const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ephemeralToken}`,
      'Content-Type': 'application/sdp',
    },
    body: offerSdp,
  });

  if (!sdpRes.ok) {
    const err = await sdpRes.text().catch(() => sdpRes.statusText);
    console.error('[stt/session] SDP exchange error:', err);
    return Response.json(
      { error: 'Failed to exchange SDP', details: err },
      { status: 502 },
    );
  }

  const answerSdp = await sdpRes.text();
  return new Response(answerSdp, {
    headers: { 'Content-Type': 'application/sdp' },
  });
}
