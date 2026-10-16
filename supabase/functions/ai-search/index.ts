const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SUBJECTS = [
  'Romanian language and literature', 'Mathematics', 'Physics', 'Chemistry', 'Biology',
  'History', 'Geography', 'Computer science', 'ICT', 'English', 'French', 'German',
  'Spanish', 'Latin', 'Logic', 'Psychology', 'Philosophy', 'Economics',
  'Social education', 'Art', 'Music', 'Physical education', 'Religion',
  'Technology', 'Natural sciences', 'Entrepreneurship'
];

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!authorization || !supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Sign in to use AI search.' }, 401);
  }

  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, Authorization: authorization }
  });
  if (!authResponse.ok) return jsonResponse({ error: 'Your session expired. Sign in again.' }, 401);
  if (!geminiApiKey) return jsonResponse({ error: 'AI search is not configured yet. Add GEMINI_API_KEY to Supabase Edge Function secrets.' }, 503);

  let body: { query?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 500) {
    return jsonResponse({ error: 'Enter a search up to 500 characters.' }, 400);
  }

  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const prompt = `You power multilingual student peer tutoring search.
Understand this student's request in whatever language it is written. Pick exactly one best-fit subject from the allowed list. Rewrite the student's need as one concise, reassuring sentence in the SAME language as their request. Produce 3 to 12 short topic keywords in English and, when useful, the original language; these will be matched against student profile bios and strengths. Do not invent students or promise a guaranteed result.
Allowed subjects: ${SUBJECTS.join(' | ')}
Student request: ${JSON.stringify(query)}
Return only a JSON object with this exact shape: {"subject":"one exact allowed subject","message":"one sentence in the student's language","searchTerms":["keyword"]}`;

  const aiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    }
  );

  if (!aiResponse.ok) {
    const details = await aiResponse.json().catch(() => null);
    const message = typeof details?.error?.message === 'string'
      ? details.error.message
      : 'The AI provider could not complete the search.';
    return jsonResponse({ error: message }, aiResponse.status === 429 ? 429 : 502);
  }

  const aiData = await aiResponse.json();
  const responseText = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof responseText !== 'string') {
    return jsonResponse({ error: 'The AI returned an empty response. Please try again.' }, 502);
  }

  let result: { subject?: unknown; message?: unknown; searchTerms?: unknown };
  try {
    result = JSON.parse(responseText);
  } catch {
    return jsonResponse({ error: 'The AI returned an unreadable response. Please try again.' }, 502);
  }

  if (!SUBJECTS.includes(String(result.subject)) || typeof result.message !== 'string' || !Array.isArray(result.searchTerms)) {
    return jsonResponse({ error: 'The AI returned an invalid result. Please try again.' }, 502);
  }

  const searchTerms = result.searchTerms
    .filter((term): term is string => typeof term === 'string')
    .map((term) => term.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 12);

  return jsonResponse({
    subject: result.subject,
    message: result.message.trim().slice(0, 500),
    searchTerms
  });
});
