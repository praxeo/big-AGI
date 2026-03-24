/**
 * POST /api/stt/session
 *
 * Unified interface for OpenAI Realtime transcription via WebRTC.
 * The browser sends its SDP offer here; this route combines it with
 * the session config and proxies it to OpenAI. Returns the SDP answer.
 *
 * The browser NEVER contacts api.openai.com directly — only this
 * server does. This avoids CORS preflight and firewall issues.
 *
 * Request:  Content-Type: application/sdp, body = SDP offer string
 *           Optional query param: ?lang=en
 * Response: Content-Type: application/sdp, body = SDP answer string
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

  // Language via query param: /api/stt/session?lang=en
  const url = new URL(req.url);
  const langParam = url.searchParams.get('lang');
  let language = 'en';
  if (langParam) {
    const tag = langParam.trim().split(/[-_]/)[0]?.toLowerCase();
    if (tag && /^[a-z]{2,3}$/.test(tag)) language = tag;
  }

  const sessionConfig = JSON.stringify({
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        noise_reduction: { type: 'near_field' },
        transcription: { model, language, prompt },
        turn_detection: { type: 'semantic_vad', eagerness: 'medium' },
      },
    },
  });

  const fd = new FormData();
fd.set('sdp', new Blob([offerSdp], { type: 'application/sdp' }), 'offer.sdp');
fd.set('session', new Blob([sessionConfig], { type: 'application/json' }), 'session.json');

  const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  if (!sdpRes.ok) {
    const err = await sdpRes.text().catch(() => sdpRes.statusText);
    console.error('[stt/session] OpenAI SDP exchange error:', err);
    return Response.json(
      { error: 'Failed to create transcription session' },
      { status: 502 },
    );
  }

  const answerSdp = await sdpRes.text();
  return new Response(answerSdp, {
    headers: { 'Content-Type': 'application/sdp' },
  });
}
