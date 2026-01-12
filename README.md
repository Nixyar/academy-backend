# VibeCoderAI Backend API

Production-ready Express API for Supabase Auth session handling, Google OAuth via Supabase provider, and profile management.

## Features
- Express (ESM) server with CORS + cookie parsing and health check.
- Supabase Auth session persistence in httpOnly cookies (access + refresh).
- JWT validation via Supabase JWKS.
- Profile `/api/me` endpoint that auto-creates a profile on first visit.
- Lesson-scoped LLM proxy that pulls `llm_system_prompt` from Supabase.
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
| `SUPABASE_JWT_SECRET` | Supabase JWT secret for verifying access tokens (HS256). |
| `LLM_API_URL` | Full URL for LLM generation endpoint (defaults to `http://95.81.99.208/v1/llm/generate`). |
| `COOKIE_SECURE` | `true` to send cookies with `Secure` (set to `false` for local HTTP). |
| `NODE_ENV` | `development` or `production`. |
| `TBANK_TERMINAL_KEY` | TBank TerminalKey (for `/api/payments/tbank/*`). |
| `TBANK_PASSWORD` | TBank password (used to compute request Token). |
| `TBANK_API_URL` | Base URL for TBank API (e.g. `https://.../v2`). |
| `TBANK_SUCCESS_URL` | Optional override for SuccessURL redirect. |
| `TBANK_FAIL_URL` | Optional override for FailURL redirect. |
| `TBANK_NOTIFICATION_URL` | Optional notification webhook URL for `/api/payments/tbank/notification`. |
| `TBANK_SEND_RECEIPT` | `true/false`: include `Receipt` in `/Init` (fiscal check). |
| `TBANK_RECEIPT_TAXATION` | Required when `TBANK_SEND_RECEIPT=true` (Taxation). |
| `TBANK_RECEIPT_TAX` | Required when `TBANK_SEND_RECEIPT=true` (Tax for the item). |
| `TBANK_RECEIPT_PAYMENT_METHOD` | Optional Receipt item `PaymentMethod` (defaults to `full_payment`). |
| `TBANK_RECEIPT_PAYMENT_OBJECT` | Optional Receipt item `PaymentObject` (defaults to `service`). |

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
- `GET /api/health` → `{ ok: true }` (for uptime checks).
- `POST /api/lessons/:lessonId/llm` with body `{ prompt }`
  - Loads the lesson by `id` from Supabase and reads `llm_system_prompt`.
  - Proxies to configured `LLM_API_URL` with `{ prompt, system: llm_system_prompt, temperature: 0.2, maxTokens: 1024 }`.
  - Response mirrors the upstream LLM: `{ text, model, usage: { promptTokens, completionTokens } }`; returns `404 { error: 'LESSON_NOT_FOUND' }` if the lesson is missing, `400 { error: 'LESSON_LLM_SYSTEM_PROMPT_MISSING' }` if the field is empty, or `502 { error: 'LLM_REQUEST_FAILED' }` if upstream fails.
- HTML streaming (lesson-scoped prompts from Supabase; auth required):
  - `POST /api/v1/html/start` with body `{ prompt, lessonId }`
    - Reads `user_id` from Supabase cookies, resolves `course_id` by `lessonId`.
    - If an active `progress.active_job` for this course is queued/running → returns it (`{ already_running: true, jobId, status }`) without creating a new one.
    - Otherwise creates a job (`{ already_running: false, jobId, status: 'running' }`), stores `active_job` + `prompt` + timestamps in `user_course_progress`, and kicks off LLM planning to build the in-memory job (`Map<jobId, ...>`).
    - Atomically stores prompt + status; expects a partial unique index on `user_course_progress (user_id, course_id)` where `progress->'active_job' is not null` to protect against duplicates.
  - `GET /api/v1/html/stream?jobId=...` (SSE)
    - Only the owner can stream. Replays generated CSS/sections; on every SSE chunk writes a heartbeat (`progress.active_job.updatedAt`). On completion saves `progress.result.html` and marks `active_job.status='done'`.
    - Events: `css`, `section`, `done`, `error`. Replays already-generated parts if the stream is re-opened.
  - `GET /api/v1/html/result?jobId=...`
    - Returns cached `{ jobId, status, outline, css, sections, html }` for reloads/re-renders (owner-only).
- `POST /api/auth/session` with body `{ access_token, refresh_token }`
  - Saves `sb_access_token` (~1h) and `sb_refresh_token` (~30d) as httpOnly cookies
  (`sameSite=lax`, `secure` depends on `COOKIE_SECURE/NODE_ENV`).
  - Response: `{ ok: true }`.
- `POST /api/auth/login` with body `{ email, password }`
  - Authenticates via Supabase email/password and stores access/refresh tokens in cookies.
  - Response: `{ ok: true, user: { id, email, name } }`; returns `401 { error: 'INVALID_CREDENTIALS' }` on failure.
- `POST /api/auth/register` with body `{ name, email, password }`
  - Creates a Supabase user (stores `name` in user metadata) and inserts a `profiles` row.
  - If Supabase returns a session, the API sets auth cookies; otherwise, no cookies are set (email confirmation flow).
  - Response: `201 { ok: true, user: { id, email, name } }`; returns `400 { error: 'SIGNUP_FAILED' }` or `500 { error: 'PROFILE_CREATE_FAILED' }`.
- `POST /api/auth/refresh`
  - Uses `sb_refresh_token` cookie to refresh the Supabase session.
  - Overwrites both cookies with new tokens on success.
  - Response: `{ ok: true }`; returns `401 { error: 'REFRESH_FAILED' }` if the refresh token is missing or invalid.
- `POST /api/auth/logout`
  - Clears both cookies.
  - Response: `{ ok: true }`.
- Content (public, anon key):
  - `GET /api/rest/v1/courses?status=active`
    - Optional filters: `status`, `slug`, `access` (`eq.` prefix supported, e.g. `status=eq.active`).
    - Sorted by `sort_order` ascending.
  - `GET /api/rest/v1/lessons?course_id=eq.<COURSE_UUID>`
    - Optional filters: `course_id`, `slug`, `lesson_type` (`eq.` prefix supported).
    - Sorted by `sort_order` ascending.
  - `GET /api/rest/v1/lessons?slug=eq.lesson-1&course_id=eq.<COURSE_UUID>` returns a single lesson by slug within a course.
- `GET /api/me`
  - Requires `sb_access_token` cookie.
  - Verifies the JWT using `SUPABASE_JWT_SECRET` with issuer `${SUPABASE_URL}/auth/v1` and audience `authenticated`.
  - Loads `profiles` by `payload.sub`; creates a default profile if missing (`plan=free`, `daily_limit=15`, `daily_used=0`).
  - Returns the profile JSON.
- Progress (auth required, service role writes to `user_course_progress`):
  - `GET /api/courses/:courseId/progress`
    - Returns `{ courseId, course_id, progress, updatedAt }`. Missing rows return an empty progress object.
    - If `progress.active_job` is queued/running but heartbeat is stale (default TTL 5m), it is auto-marked as `failed`.
  - `PUT /api/courses/:courseId/progress`
    - Body: `{ progress: <object> }` or the progress object itself.
    - Upserts progress for the user/course. Returns `{ courseId, course_id, progress, updatedAt }`.
  - `PATCH /api/courses/:courseId/progress`
    - Body: patch operation. Supported ops:
      - `quiz_answer`: `{ op: 'quiz_answer', lessonId, quizId, answer }` → stores answer under `progress.lessons[lessonId].quiz_answers[quizId]`.
      - `lesson_status`: `{ op: 'lesson_status', lessonId, status: 'in_progress'|'completed', completedAt? }`.
      - `set_resume`: `{ op: 'set_resume', lessonId }` → sets `resume_lesson_id` and `last_viewed_lesson_id`.
      - `touch_lesson`: `{ op: 'touch_lesson', lessonId }` → updates `last_viewed_lesson_id`.
    - Server loads current progress, applies the patch, and upserts. Returns `{ courseId, course_id, progress, updatedAt }`.
  - `GET /api/courses/:courseId/resume`
    - Response: `{ "lesson_id": "<id>|null" }`.
    - Picks `resume_lesson_id`/`last_viewed_lesson_id` if set; otherwise chooses the first incomplete lesson (by `sort_order`) or the first lesson if all are completed.
  - `GET /api/progress?courseIds=course1,course2`
    - Returns `{ progress: { [courseId]: <progress object or {}> } }` for the requested course IDs.
    - Missing rows are returned as empty objects to simplify the frontend.

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

Courses/lessons tables (minimal fields expected by the API):
- `courses`: `id uuid PK`, `slug text`, `title text`, `description text`, `cover_url text`, `access text`, `status text`, `sort_order int`, `created_at timestamptz`, `updated_at timestamptz`.
- `lessons`: `id uuid PK`, `course_id uuid`, `slug text`, `title text`, `lesson_type text`, `sort_order int`, `blocks jsonb`, `created_at timestamptz`, `updated_at timestamptz`.
- `lessons` additionally needs `llm_system_prompt text` for the LLM endpoint.

Progress table for per-user course tracking:
```sql
create table if not exists public.user_course_progress (
  user_id uuid references auth.users not null,
  course_id text not null,
  progress jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, course_id)
);
```

## Deployment to Render (GitHub Actions)
1. Create a Render Web Service connected to this repo. Choose Node 20 runtime and `npm start` command.
2. In Render environment variables, set: `PORT` (Render default), `WEB_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `COOKIE_SECURE=true`, `NODE_ENV=production`.
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
- Frontend can call `POST /api/auth/login` (email/password) to authenticate and set cookies directly.
- For registration, call `POST /api/auth/register`; cookies are set only if Supabase returns a session (email confirmations off).
- If the frontend uses Supabase Auth directly (email/password or Google provider), it receives `access_token` + `refresh_token` and calls `POST /api/auth/session` to store cookies.
- Subsequent authenticated calls include cookies; `/api/me` verifies the access token via HS256 and manages the profile row.
- If an authenticated request returns `401`, the frontend should call `POST /api/auth/refresh` to rotate the cookies using the stored refresh token.
- `POST /api/auth/logout` removes cookies and ends the session on the API side.

## Deploy checklist (quick)
- [ ] Supabase project created; Email + Google providers enabled.
- [ ] `profiles` table created with SQL above.
- [ ] Google OAuth client redirect set to `${SUPABASE_URL}/auth/v1/callback` and frontend URLs.
- [ ] Render env vars set (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `WEB_ORIGIN`, `COOKIE_SECURE`, `NODE_ENV`, `PORT`).
- [ ] GitHub secret `RENDER_DEPLOY_HOOK_URL` added.
