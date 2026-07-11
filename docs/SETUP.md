# Donna AI setup

## Local development

1. Install dependencies with `pnpm install`.
2. Copy `.env.example` to `.env` and fill in Supabase, Google OAuth, OpenAI, Twilio, and cron secrets.
3. Run `supabase/schema.sql` in your Supabase SQL editor.
4. Configure Google OAuth redirect URI to match `GOOGLE_REDIRECT_URI`.
5. Start locally with `pnpm dev`.

## Vercel deployment

- Add all `.env.example` keys as encrypted Vercel environment variables.
- Schedule a Vercel Cron job to GET `/api/cron/meeting-briefs` every minute with `Authorization: Bearer $CRON_SECRET`.
- Point `PUBLIC_BASE_URL` and `GOOGLE_REDIRECT_URI` at the deployed Vercel URL.

## Privacy notes

Donna requests Gmail and Calendar read-only scopes only. Keep `.env` out of Git; this repository's `.gitignore` excludes `.env` and `.env.*` while allowing `.env.example`.
