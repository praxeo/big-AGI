/**
 * POST /api/stt/session
 *
 * Unified SDP proxy for OpenAI Realtime transcription.
 * Browser sends SDP offer here, server proxies to OpenAI,
 * returns SDP answer. No browser → OpenAI HTTP calls.
 *
 * Session config (prompt, VAD, language) is sent by the client
 * over the data channel after WebRTC connects.
 *
 * Env vars:
 *   STT_API_KEY  – OpenAI API key
 *   STT_MODEL    – e.g. gpt-4o-transcribe (default)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function POST(req: Request) {
  const apiKey = process.env.STT_API_KEY;
  if (!apiKey)
    return Response.json({ error: 'Missing STT_API_KEY' }, { status: 500 });

  const model = process.env.STT_MODEL || 'gpt-4o-transcribe';

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/sdp'))
    return Response.json({ error: 'Expected Content-Type: application/sdp' }, { status: 400 });

  const offerSdp = await req.text();
  if (!offerSdp.trim())
    return Response.json({ error: 'Empty SDP offer' }, { status: 400 });

  const sdpRes = await fetch(
    `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    },
  );

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
