# VibeCoderAI Backend API

Production-ready Express API for Supabase Auth session handling, Google OAuth via Supabase provider, and profile management.

## Features
- Express (ESM) server with CORS + cookie parsing and health check.
- Supabase Auth session persistence in httpOnly cookies (access + refresh).
- JWT validation via Supabase JWKS.
- Profile `/me` endpoint that auto-creates a profile on first visit.
- Ready for GitHub → Render deploy hook workflow.

## Requirements
- Node.js 20+
- npm
- Supabase project with Auth enabled and a `profiles` table (schema below).

## Environment variables
| Name | Description |
| --- | --- |
| `PORT` | Port the Express server listens on (Render usually provides this). |
| `WEB_ORIGIN` | Allowed frontend origin(s) for CORS (comma-separated list). |
| `SUPABASE_URL` | Supabase project URL (e.g. `https://your-project.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key for server-side profile access. |
| `SUPABASE_ANON_KEY` | Supabase anon key for client-side auth operations (refresh). |
| `COOKIE_SECURE` | `true` to send cookies with `Secure` (set to `false` for local HTTP). |
| `NODE_ENV` | `development` or `production`. |

Copy `.env.example` to `.env` and fill values for local runs:
```bash
cp .env.example .env
```

## Local development
```bash
npm install
npm run dev
```
The API will start on `PORT` (defaults to `3000` in `.env.example`).

## API endpoints
- `GET /health` → `{ ok: true }` (for uptime checks).
- `POST /auth/session` with body `{ access_token, refresh_token }`
  - Saves `sb_access_token` (~1h) and `sb_refresh_token` (~30d) as httpOnly cookies
    (`sameSite=lax`, `secure` depends on `COOKIE_SECURE/NODE_ENV`).
  - Response: `{ ok: true }`.
- `POST /auth/refresh`
  - Uses `sb_refresh_token` cookie to refresh the Supabase session.
  - Overwrites both cookies with new tokens on success.
  - Response: `{ ok: true }`; returns `401 { error: 'REFRESH_FAILED' }` if the refresh token is missing or invalid.
- `POST /auth/logout`
  - Clears both cookies.
  - Response: `{ ok: true }`.
- `GET /me`
  - Requires `sb_access_token` cookie.
  - Verifies the JWT using JWKS from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` with issuer `${SUPABASE_URL}/auth/v1` and audience `authenticated`.
  - Loads `profiles` by `payload.sub`; creates a default profile if missing (`plan=free`, `daily_limit=15`, `daily_used=0`).
  - Returns the profile JSON.

## Database schema (Supabase SQL)
Create the `profiles` table in Supabase:
```sql
create table if not exists public.profiles (
  id uuid primary key,
  email text,
  name text,
  avatar_url text,
  plan text default 'free',
  daily_limit int default 15,
  daily_used int default 0,
  daily_reset_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```
Use Row Level Security policies as needed; the API uses the service role key for server-side access.

## Deployment to Render (GitHub Actions)
1. Create a Render Web Service connected to this repo. Choose Node 20 runtime and `npm start` command.
2. In Render environment variables, set: `PORT` (Render default), `WEB_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COOKIE_SECURE=true`, `NODE_ENV=production`.
3. Enable a **Deploy Hook** in Render and copy the hook URL.
4. In GitHub repo settings → Secrets and variables → Actions, add `RENDER_DEPLOY_HOOK_URL` with the hook URL, plus any runtime env vars you prefer to manage in Actions.
5. On push to `main`, `.github/workflows/deploy-render.yml` installs deps and calls the deploy hook.

## Supabase & Google OAuth setup
1. Create a Supabase project and enable Email + Google providers.
2. Configure Supabase Auth URL settings:
   - Site URL: your frontend origin (`WEB_ORIGIN`).
   - Redirect URLs: add your frontend callback (e.g. `https://app.example.com/auth/callback`) and local dev URL (`http://localhost:5173/auth/callback`).
3. In Supabase Auth → Providers → Google, set the OAuth redirect to `${SUPABASE_URL}/auth/v1/callback` (Supabase callback) and ensure the same URLs are registered in your Google Cloud Console OAuth client.
4. Obtain `SUPABASE_SERVICE_ROLE_KEY` from Settings → API and store it only in env vars (Render + GitHub secret).

## Auth/session flow recap
- Frontend signs in via Supabase Auth (email/password or Google provider) and receives `access_token` + `refresh_token`.
- Frontend calls `POST /auth/session` to store both tokens in httpOnly cookies.
- Subsequent authenticated calls include cookies; `/me` verifies the access token via JWKS and manages the profile row.
- If an authenticated request returns `401`, the frontend should call `POST /auth/refresh` to rotate the cookies using the stored refresh token.
- `POST /auth/logout` removes cookies and ends the session on the API side.

## Deploy checklist (quick)
- [ ] Supabase project created; Email + Google providers enabled.
- [ ] `profiles` table created with SQL above.
- [ ] Google OAuth client redirect set to `${SUPABASE_URL}/auth/v1/callback` and frontend URLs.
- [ ] Render env vars set (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `WEB_ORIGIN`, `COOKIE_SECURE`, `NODE_ENV`, `PORT`).
- [ ] GitHub secret `RENDER_DEPLOY_HOOK_URL` added.
