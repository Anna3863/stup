import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

async function getZoomAccessToken() {
  const accountId = Deno.env.get('ZOOM_ACCOUNT_ID');
  const clientId = Deno.env.get('ZOOM_CLIENT_ID');
  const clientSecret = Deno.env.get('ZOOM_CLIENT_SECRET');
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET are required.');
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!response.ok) throw new Error(`Zoom OAuth returned ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Zoom did not return an access token.');
  return data.access_token as string;
}

async function emailHash(email: string) {
  const normalized = email.trim().toLowerCase();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureZoomMessage(conversationId: string, senderId: string, body: string) {
  const { data: existing, error: lookupError } = await supabase
    .from('messages')
    .select('id,created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_id', senderId)
    .eq('body', body)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing;

  const { data: inserted, error: insertError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, body })
    .select('id,created_at')
    .single();
  if (insertError) throw insertError;
  return inserted;
}

function participantJoinUrl(url: string) {
  return String(url).replace(/\/wc\/(\d+)\/join(\b|\?)/, '/j/$1$2');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('authorization');
  const accessToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const { error: authError } = accessToken
    ? await supabase.auth.getUser(accessToken)
    : { error: new Error('Missing authorization') };
  if (authError) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const conversationId = String(body?.conversation_id || '');
    if (!conversationId) throw new Error('conversation_id is required.');

    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .select('id,requester_id,zoom_meeting_id,zoom_join_url')
      .eq('id', conversationId)
      .single();
    if (conversationError || !conversation) throw new Error('Conversation not found.');

    const { data: members, error: membersError } = await supabase
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId);
    if (membersError || !members || members.length !== 2) throw new Error('Zoom attendance requires a two-person conversation.');

    const memberIds = members.map((member) => member.user_id as string);
    const { data: authUser } = await supabase.auth.getUser(accessToken);
    if (!authUser.user || !memberIds.includes(authUser.user.id)) throw new Error('You are not in this conversation.');
    const requesterId = conversation.requester_id || authUser.user.id;
    if (!memberIds.includes(requesterId)) throw new Error('The conversation requester is not a member.');
    const helperId = memberIds.find((id) => id !== requesterId)!;
    const [requester, helper] = await Promise.all([
      supabase.auth.admin.getUserById(requesterId),
      supabase.auth.admin.getUserById(helperId)
    ]);
    if (!requester.data.user?.email || !helper.data.user?.email) throw new Error('Both participants need verified email addresses.');

    const zoomToken = await getZoomAccessToken();
    if (conversation.zoom_meeting_id && conversation.zoom_join_url) {
      const meetingResponse = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(conversation.zoom_meeting_id)}`, {
        headers: { Authorization: `Bearer ${zoomToken}` }
      });
      if (meetingResponse.ok) {
        const meeting = await meetingResponse.json();
        const joinUrl = participantJoinUrl(String(meeting.join_url || conversation.zoom_join_url));
        await supabase.from('conversations').update({ zoom_join_url: joinUrl }).eq('id', conversationId);
        const message = await ensureZoomMessage(conversationId, authUser.user.id, `Zoom link: ${joinUrl}`);
        return jsonResponse({ join_url: joinUrl, message_id: message.id, message_created_at: message.created_at });
      }
      const meetingError = await meetingResponse.text();
      if (!/3001|meeting does not exist|not found/i.test(meetingError)) {
        throw new Error(`Zoom meeting validation returned ${meetingResponse.status}: ${meetingError}`);
      }
      await supabase.from('conversations').update({ zoom_meeting_id: null, zoom_join_url: null }).eq('id', conversationId);
    }
    // The configured Zoom account is the technical host. Students do not need
    // to be Zoom users in that account; the helper remains the learning
    // session's recipient and attendance reward recipient.
    const zoomHostUser = Deno.env.get('ZOOM_HOST_USER_ID') || 'me';
    const response = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(zoomHostUser)}/meetings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${zoomToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        topic: 'Stup study session',
        type: 1,
        duration: 60,
        settings: {
          join_before_host: true,
          waiting_room: false,
          participant_video: true,
          host_video: true
        }
      })
    });
    if (!response.ok) {
      const responseText = await response.text();
      if (/does not contain scopes|invalid access token/i.test(responseText)) {
        throw new Error('Zoom OAuth is missing the meeting creation scope. Add meeting:write or meeting:write:admin to the Zoom app, then refresh its credentials.');
      }
      throw new Error(`Zoom meeting creation returned ${response.status}: ${responseText}`);
    }

    const meeting = await response.json();
    if (!meeting.join_url) throw new Error('Zoom did not return a meeting join URL.');
    const browserJoinUrl = String(meeting.join_url);
    const meetingId = String(meeting.id);
    const { error: saveError } = await supabase.from('conversations').update({
      requester_id: requesterId,
      zoom_meeting_id: meetingId,
      zoom_join_url: browserJoinUrl
    }).eq('id', conversationId);
    if (saveError) throw saveError;
    const { error: attendanceError } = await supabase.from('zoom_session_attendance').insert({
      conversation_id: conversationId,
      meeting_id: meetingId,
      requester_id: requesterId,
      helper_id: helperId,
      requester_email_hash: await emailHash(requester.data.user.email),
      helper_email_hash: await emailHash(helper.data.user.email)
    });
    if (attendanceError && !/relation .* does not exist|schema cache|could not find/i.test(attendanceError.message || '')) {
      throw attendanceError;
    }
    const message = await ensureZoomMessage(conversationId, authUser.user.id, `Zoom link: ${browserJoinUrl}`);
    return jsonResponse({
      join_url: browserJoinUrl,
      message_id: message.id,
      message_created_at: message.created_at,
      attendance_tracking: !attendanceError,
      ...(attendanceError ? { warning: 'Run migration_zoom_verified_attendance.sql to enable session rewards.' } : {})
    });
  } catch (error) {
    return jsonResponse({ error: errorText(error) }, 500);
  }
});
