import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Batch = {
  id: string;
  recipient_id: string;
  sender_id: string;
  message_count: number;
  notify_after: string;
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character] || character));
}

async function sendEmail(to: string, senderName: string, count: number) {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  if (!resendKey || !from) throw new Error('RESEND_API_KEY and EMAIL_FROM are required.');

  const messageLabel = count === 1 ? 'message' : 'messages';
  const safeName = escapeHtml(senderName);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `${senderName} sent you ${count} new ${messageLabel}`,
      html: `<p><strong>${safeName}</strong> sent you <strong>${count}</strong> new ${messageLabel}.</p><p>Open the app to read and reply.</p>`
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
}

Deno.serve(async (request) => {
  const workerSecret = Deno.env.get('MESSAGE_NOTIFICATION_WORKER_SECRET');
  if (!workerSecret || request.headers.get('x-worker-secret') !== workerSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = new Date().toISOString();
  const { data: batches, error } = await supabase
    .from('message_notification_batches')
    .select('id,recipient_id,sender_id,message_count,notify_after')
    .eq('status', 'pending')
    .lte('notify_after', now)
    .order('notify_after')
    .limit(100);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let sent = 0;
  for (const batch of (batches || []) as Batch[]) {
    const { data: claimed } = await supabase
      .from('message_notification_batches')
      .update({ status: 'processing' })
      .eq('id', batch.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    try {
      const [{ data: authUser }, { data: sender }] = await Promise.all([
        supabase.auth.admin.getUserById(batch.recipient_id),
        supabase.from('profiles').select('display_name').eq('id', batch.sender_id).single()
      ]);
      const email = authUser.user?.email;
      const senderName = sender?.display_name || 'Someone';
      if (!email) throw new Error('Recipient has no email address.');
      await sendEmail(email, senderName, batch.message_count);
      await supabase.from('message_notification_batches').delete().eq('id', batch.id).eq('status', 'processing');
      sent += 1;
    } catch (sendError) {
      await supabase.from('message_notification_batches').update({ status: 'pending', last_error: String(sendError) }).eq('id', batch.id);
    }
  }

  return Response.json({ processed: (batches || []).length, sent });
});
