# stup — real multi-user MVP

This is a small, low-cost step toward turning the original `stup_v2.html` prototype into a real website. It preserves the stup gradient/purple visual style and adds Supabase-backed authentication, persistent profiles, a 1–10 rating for every subject, subject-based discovery, direct conversations, and realtime message updates.

`stup_v2_original.html` is your uploaded original, kept unchanged for reference. This MVP still does not include Pass credits, session bookings, AI moderation, or student-ID verification. Subject ratings are included and are self-reported.

## 1. Requirements
- Node.js 20.19+ or 22.12+
- A free Supabase project: https://supabase.com/dashboard

## 2. Create the database
1. Create a Supabase project.
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste and run all of `supabase/schema.sql`.
4. In **Project Settings → API** (or Connect), copy the Project URL and the publishable/anon client key. Never use the `service_role` secret in a browser app.

If you already created the database from the earlier stup MVP, run `supabase/migration_subject_ratings.sql`, `supabase/migration_profile_reviews.sql`, `supabase/migration_profile_fields.sql`, and `supabase/migration_owner_passport.sql` in SQL Editor. The profile fields migration adds the bio, verification flag, owner flag, and passport-photo URL columns required by profile creation and saving, then asks PostgREST to reload its schema cache. If you still see a `bio` column/schema-cache error, confirm the migration ran successfully and wait briefly for the API cache to refresh before saving again. The profile reviews migration also adds the profile-picture column and configures the `profile-photos` bucket. Do not rerun the full schema on an existing database, because its policies already exist.

To create shared Zoom meetings and privately verify attendance, run `supabase/migration_zoom_verified_attendance.sql`, create a Zoom Server-to-Server OAuth app, and deploy `supabase/functions/create-zoom-meeting` and `supabase/functions/zoom-attendance-webhook`. Set these Edge Function secrets:
```bash
supabase secrets set ZOOM_ACCOUNT_ID=your-account-id ZOOM_CLIENT_ID=your-client-id ZOOM_CLIENT_SECRET=your-client-secret
supabase secrets set ZOOM_WEBHOOK_SECRET_TOKEN=your-webhook-secret-token
supabase functions deploy create-zoom-meeting
supabase functions deploy zoom-attendance-webhook
```
Configure the Zoom webhook URL as `https://YOUR_PROJECT_REF.supabase.co/functions/v1/zoom-attendance-webhook` and subscribe to `meeting.participant_joined` and `meeting.participant_left`. Participants must sign in to Zoom using the same verified email address as their Stup account. Attendance, join times, and reward state remain server-only; the browser receives only the join link. The private database migration schedules a server-side check every minute and currently awards the helper one session after 1 minute of simultaneous verified attendance for testing. Restore the threshold to 10 minutes before production. Do not put Zoom credentials in `.env` or frontend code.

## 3. Configure and run locally
```bash
npm install
cp .env.example .env
```
Edit `.env` and set:
```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```
Then run:
```bash
npm run dev
```
Open the local URL printed by Vite.

On Windows PowerShell, `Copy-Item .env.example .env` can replace the `cp` command.

## 4. Enable multilingual AI search
AI search uses a Supabase Edge Function so the Gemini key is never exposed in the browser. Only the submitted search text and the app's allowed subject names are sent to Gemini; student profile data is matched locally and is not sent to the AI provider.

1. Create a Gemini API key in Google AI Studio. Gemini API free-tier availability and limits depend on Google's current terms.
2. Install and sign in to the [Supabase CLI](https://supabase.com/docs/guides/cli), then link this folder to your Supabase project with `supabase link`.
3. Add the key as a Supabase secret (do not add it to `.env` or frontend code):
   ```bash
   supabase secrets set GEMINI_API_KEY=your-key
   ```
4. Deploy the function:
   ```bash
   supabase functions deploy ai-search
   ```

The function defaults to `gemini-2.5-flash`. To select another Gemini model supported by your API key, set `GEMINI_MODEL` as a Supabase secret. AI search requires a signed-in user and a configured Supabase project. If the function or key is not configured, the app reports that instead of pretending a local match is AI.

## 5. Supabase Auth settings
For local testing, in **Authentication → URL Configuration**, add your local Vite URL (usually `http://localhost:5173`) to the allowed redirect URLs. Configure the production domain after deployment. Keep email confirmation enabled for a real launch.

## 6. Deploy free/cheap
- Push this folder to a private or public GitHub repository.
- Import the repository into Vercel or another static host.
- Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as deployment environment variables.
- Add the deployed URL to Supabase Auth's allowed redirect URLs, then redeploy.

## Security notes before inviting real students
- Row Level Security (RLS) is enabled. Conversations and messages are restricted to members.
- Do not collect CNPs, home addresses, phone numbers, or ID photos in this first version.
- This is an MVP, not yet launch-ready for minors. Add a privacy notice, account deletion/export flow, report/block controls, abuse rate limits, and a safe verification process before opening it widely.
- Public profiles currently show display name, school level, county, and main subject to signed-in users. Revisit what should be public before launch.
- Do not put AI-provider keys or Supabase service-role keys in frontend code.

## Files you will most likely edit
- `src/main.js` — signup, discovery filters, student cards, and the 1–10 subject rating controls.
- `src/style.css` — visual style and layout for the subject scales/cards.
- `src/ora-search.css` — Ora-style search controls and result highlighting.
- `supabase/schema.sql` — database structure for a fresh project.
- `supabase/migration_subject_ratings.sql` — adds subject ratings to a database made from the earlier MVP.
- `supabase/migration_profile_reviews.sql` — adds profile star ratings and comments to an existing database.
- `supabase/functions/ai-search/index.ts` — authenticated multilingual Gemini search endpoint.
- `stup_v2_original.html` — untouched original prototype for reference; the running Vite app uses `src/main.js` and `src/style.css`.

## Current feature scope
- Email/password sign-up and login via Supabase Auth
- Profile storage and editing in PostgreSQL
- Rate every subject from 1–10 (or leave it unselected)
- Discover profiles in the same county and filter by subject/minimum rating
- Search for study help in natural language with multilingual AI (requires deploying the Supabase Edge Function and configuring a Gemini API key)
- Start or reopen a direct conversation
- Count completed sessions in the navigation
- Post a 1–5 star rating and optional comment after a completed session; show reviews on student profiles
- Persistent messages with Realtime updates
- Responsive UI based on stup's existing purple/gradient style

## Troubleshooting
- `Invalid API key`: ensure the publishable/anon key, not service-role key, is in `.env`.
- Profile insert/query errors: confirm `supabase/schema.sql` ran successfully.
- Confirmation email: check Supabase Auth email settings and spam folder. For development, you can temporarily disable confirmation in Supabase Auth settings, but re-enable it before launch.
- Realtime does not update: verify `messages` is enabled in the `supabase_realtime` publication.
