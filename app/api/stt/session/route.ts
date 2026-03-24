/**
 * POST /api/stt/session
 *
 * Unified SDP proxy for OpenAI Realtime transcription.
 * Browser sends SDP offer here, server combines it with session
 * config in a hand-built multipart body and proxies to OpenAI.
 * Returns the SDP answer.
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

  const sessionConfig = JSON.stringify({
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        noise_reduction: { type: 'near_field' },
        transcription: { model, language, prompt },
        turn_detection: { type: 'semantic_vad', eagerness },
      },
    },
  });

  // Build multipart body manually — Vercel's Node.js FormData
  // doesn't produce what OpenAI expects
  const boundary = '----SdpBoundary' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="sdp"\r\n` +
    `Content-Type: application/sdp\r\n\r\n` +
    `${offerSdp}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="session"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${sessionConfig}\r\n` +
    `--${boundary}--\r\n`;

  const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!sdpRes.ok) {
    const err = await sdpRes.text().catch(() => sdpRes.statusText);
    console.error('[stt/session] OpenAI SDP exchange error:', err);
    return Response.json(
      { error: 'Failed to create transcription session', details: err },
      { status: 502 },
    );
  }

  const answerSdp = await sdpRes.text();
  return new Response(answerSdp, {
    headers: { 'Content-Type': 'application/sdp' },
  });
}
