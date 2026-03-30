# Deploy: Render (backend + Postgres) + Vercel (frontend)

This repo is already set up for:
- **Render**: Node/Express backend + Postgres via `render.yaml` (Blueprint)
- **Vercel**: Static frontend from the `frontend/` folder via `vercel.json`

Use this document as a handoff checklist for groupmates.

---

## 0) Prerequisites (do this first)

- Put the project in a Git repo your groupmates can access (GitHub recommended)
  - Option A: one shared repo
  - Option B: each groupmate forks your repo and deploys their own

You will deploy **two** things:
1) Backend API on Render (and Postgres)
2) Frontend static site on Vercel

---

## 1) Render: deploy backend + create Postgres

### A. Create the services (Blueprint)

1. Go to Render Dashboard → **New +** → **Blueprint**
2. Connect the GitHub repo and select it
3. Render reads `render.yaml` and creates:
   - a Postgres DB (free plan)
   - a Node Web Service (free plan)

### B. Set the backend environment variables

Open Render → your web service → **Environment**.

Required in production:
- `NODE_ENV=production`
- `DATABASE_URL` = the DB **External Database URL**
- `JWT_SECRET` = long random secret (Render can generate)

Recommended:
- `SERVE_FRONTEND=false` (since Vercel hosts the frontend)
- `FRONTEND_ORIGIN=https://<your-vercel-domain>` (CORS; see step 3)

Optional “first deploy” helpers (remove after setup):
- `AUTO_DB_INIT=true` (auto-runs `backend/db/schema.sql` on startup)
- `BOOTSTRAP_ADMIN_USER=admin`
- `BOOTSTRAP_ADMIN_PASS=<strong password>`

Security note:
- If you use `BOOTSTRAP_ADMIN_PASS`, remove it immediately after the first successful boot.

### C. Initialize schema + create admin user

You have two ways.

**Option 1 (preferred): use Render Shell**
1. Render → your backend service → **Shell**
2. Run:
   - `npm run db:init`
   - `npm run create-admin -- admin yourStrongPassword`

**Option 2 (no Shell / free-tier limitations): env var bootstrap**
1. Set these env vars on the backend service:
   - `AUTO_DB_INIT=true`
   - `BOOTSTRAP_ADMIN_USER=admin`
   - `BOOTSTRAP_ADMIN_PASS=<strong password>`
2. Trigger a redeploy
3. Confirm health works (step 4)
4. Remove `BOOTSTRAP_ADMIN_PASS` (and optionally `AUTO_DB_INIT`) and redeploy again

---

## 2) Vercel: deploy frontend

1. Go to Vercel Dashboard → **New Project**
2. Import the same GitHub repo
3. Vercel will use `vercel.json`:
   - `buildCommand`: `npm run build` (writes `frontend/config.js`)
   - `outputDirectory`: `frontend`

### Set Vercel env var

Vercel Project → **Settings → Environment Variables**:
- `API_BASE` = `https://<your-render-service>.onrender.com`

Then redeploy the Vercel project (or trigger a new deploy).

---

## 3) Render: set CORS origin (important)

Because the frontend (Vercel) calls the backend (Render) cross-origin, the backend must allow it.

Render backend service → **Environment**:
- `FRONTEND_ORIGIN=https://<your-vercel-domain>`

Notes:
- You can allow multiple origins by comma-separating them.
- Use the exact origin, e.g. `https://my-app.vercel.app` (no trailing slash).

---

## 4) Smoke tests (copy/paste)

### A. Backend health
Open in browser:
- `https://<render-service>.onrender.com/api/health`

Expected:
- `ok: true`
- `demoMode: false` (in production with DB configured)

### B. Frontend loads data
Open:
- `https://<vercel-domain>/`

Then in DevTools Console (optional):
- Confirm `window.API_BASE` is set to the Render URL (not empty)

### C. Admin login
Open:
- `https://<vercel-domain>/admin/`

Log in with the admin user you created.

---

## 5) Troubleshooting

### Frontend shows no data / requests failing
- Verify Vercel env var `API_BASE` is set
- Confirm `frontend/config.js` is being generated during deploy (Vercel build logs)
- Ensure Render has `FRONTEND_ORIGIN` set to the exact Vercel origin

### Render deploy succeeds but API errors on DB tables
- Run `npm run db:init` in Render Shell OR enable `AUTO_DB_INIT=true` and redeploy

### CORS errors in browser console
- On Render, set `FRONTEND_ORIGIN=https://<vercel-domain>`
- If you use Vercel preview URLs, you may need to include them (or temporarily allow multiple origins)

### Free tier caveat
- Render free services may sleep/stop when idle; background prediction scheduling won’t run while asleep.

### Import fails with “duplicate key value violates unique constraint fish_prices_pkey”
This happens when you bulk-import rows that include `id` values that collide with rows already in the table.

**Option A (recommended):** import without the `id` column.

**Option B (wipe then import with `id`):**
1. Connect to your Render Postgres (pgAdmin works) and open a SQL/query tool.
2. Run:
   - `TRUNCATE TABLE public.fish_prices RESTART IDENTITY;`
3. Import your CSV again (including the `id` column if you want).
4. IMPORTANT: if you imported explicit `id` values, sync the sequence so future inserts don’t re-use `id=1`:
   - `SELECT setval(pg_get_serial_sequence('public.fish_prices','id'), (SELECT COALESCE(MAX(id), 1) FROM public.fish_prices));`
5. Quick verify:
   - `SELECT COUNT(*) FROM public.fish_prices;`

Notes:
- If you’re also importing `gas_prices` with explicit `id`, repeat the same pattern for `public.gas_prices`.
- If you already generated predictions, it’s simplest to re-generate them after importing real data.

---

## Reference

- Main README: `README.md`
- Render blueprint config: `render.yaml`
- Vercel static config: `vercel.json`
- Frontend config generator: `deploy/write-frontend-config.js`
