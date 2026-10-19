import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-zm-request-timestamp, x-zm-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.trim().toLowerCase())));
}

async function validZoomSignature(request: Request, body: string) {
  const secret = Deno.env.get('ZOOM_WEBHOOK_SECRET_TOKEN');
  const timestamp = request.headers.get('x-zm-request-timestamp');
  const signature = request.headers.get('x-zm-signature');
  if (!secret || !timestamp || !signature) return false;
  const expected = `v0=${await hmac(secret, `v0:${timestamp}:${body}`)}`;
  return signature === expected;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: true });

  const bodyText = await request.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: true });
  }

  if (body.event === 'endpoint.url_validation') {
    const plainToken = String(body.payload?.plainToken || '');
    const secret = Deno.env.get('ZOOM_WEBHOOK_SECRET_TOKEN');
    if (!secret || !plainToken) return jsonResponse({ error: 'Webhook validation is not configured.' }, 500);
    return jsonResponse({ plainToken, encryptedToken: await hmac(secret, plainToken) });
  }

  if (!(await validZoomSignature(request, bodyText))) return jsonResponse({ ok: true });
  if (!['meeting.participant_joined', 'meeting.participant_left'].includes(body.event)) return jsonResponse({ ok: true });

  const meetingId = String(body.payload?.object?.id || '');
  const participantEmail = String(body.payload?.object?.participant?.email || '');
  if (!meetingId || !participantEmail) return jsonResponse({ ok: true });

  const eventAt = body.payload?.object?.participant?.join_time
    || body.payload?.object?.participant?.leave_time
    || new Date().toISOString();
  await supabase.rpc('record_zoom_attendance', {
    p_meeting_id: meetingId,
    p_participant_email_hash: await sha256(participantEmail),
    p_event: body.event,
    p_event_at: eventAt
  });

  // Never return participant identity, duration, or reward status to Zoom or the client.
  return jsonResponse({ ok: true });
});
