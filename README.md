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

If you already created the database from the earlier stup MVP, run only `supabase/migration_subject_ratings.sql` in SQL Editor. Do not rerun the full schema on an existing database, because its policies already exist.

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

## 4. Supabase Auth settings
For local testing, in **Authentication → URL Configuration**, add your local Vite URL (usually `http://localhost:5173`) to the allowed redirect URLs. Configure the production domain after deployment. Keep email confirmation enabled for a real launch.

## 5. Deploy free/cheap
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
- `supabase/schema.sql` — database structure for a fresh project.
- `supabase/migration_subject_ratings.sql` — adds subject ratings to a database made from the earlier MVP.
- `stup_v2_original.html` — untouched original prototype for reference; the running Vite app uses `src/main.js` and `src/style.css`.

## Current feature scope
- Email/password sign-up and login via Supabase Auth
- Profile ststupge and editing in PostgreSQL
- Rate every subject from 1–10 (or leave it unselected)
- Discover profiles in the same county and filter by subject/minimum rating
- Start or reopen a direct conversation
- Persistent messages with Realtime updates
- Responsive UI based on stup's existing purple/gradient style

## Troubleshooting
- `Invalid API key`: ensure the publishable/anon key, not service-role key, is in `.env`.
- Profile insert/query errors: confirm `supabase/schema.sql` ran successfully.
- Confirmation email: check Supabase Auth email settings and spam folder. For development, you can tempstuprily disable confirmation in Supabase Auth settings, but re-enable it before launch.
- Realtime does not update: verify `messages` is enabled in the `supabase_realtime` publication.
