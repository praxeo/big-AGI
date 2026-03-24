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
 * Env vars (same as /api/stt/transcribe):
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

  let language: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.language === 'string' && body.language.trim())
      language = body.language.trim().split(/[-_]/)[0]?.toLowerCase();
  } catch { /* no body is fine */ }

  const sessionRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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
              ...(language ? { language } : {}),
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
          },
        },
      },
    }),
  });

  if (!sessionRes.ok) {
    const err = await sessionRes.text().catch(() => sessionRes.statusText);
    console.error('[stt/session] OpenAI error:', err);
    return Response.json(
      { error: 'Failed to create transcription session', details: err },
      { status: sessionRes.status },
    );
  }

  const data = await sessionRes.json();

  return Response.json({
    token: data.value,
    expires_at: data.expires_at,
    model,
  });
}
