# IsdaPresyo

Mobile-friendly Fish Price Reference and Reporting System for Bulan, Sorsogon.

## Tech
- Backend: Node.js + Express (REST JSON)
- DB: PostgreSQL
- Frontend: Static HTML + Bootstrap + Vanilla JS
- Auth: Admin login via JWT (bcrypt-hashed passwords)

## Local Setup (Windows / PowerShell)

### Quick demo mode (no DB yet)
If you haven't set up PostgreSQL yet, you can still run the backend and use the admin UI with in-memory demo data.

- Start backend:
	- `cd backend`
	- `npm run dev`
- Open admin:
	- `http://localhost:3000/admin` (or set `PORT=3001` if 3000 is busy)
- Demo credentials (non-production only):
	- Username: `admin`
	- Password: `admin123`

To override demo creds, set env vars: `DEMO_ADMIN_USER` and `DEMO_ADMIN_PASS`.

### 1) Create DB
Create a PostgreSQL database (example: `isdapresyo`).

Set `backend/.env` based on `backend/.env.example` (copy it).

### 2) Install backend deps
From `backend/`:
- `npm install`

### 3) Initialize schema
From `backend/`:
- `npm run db:init`

### 4) Create an admin user
From `backend/`:
- `npm run create-admin -- admin yourStrongPassword`

### 5) Start server
From `backend/`:
- `npm run dev`

Open:
- Public: `http://localhost:3000/`
- Hidden admin: `http://localhost:3000/admin`

## Deploy notes

### Option A (recommended): Click-and-go Render (backend + Postgres) + Netlify (frontend)

1) Deploy backend on Render (Blueprint)
- In Render, choose **New > Blueprint** and point it at this repo.
- Render will read `render.yaml` and create:
	- a Postgres database
	- a Node web service

2) Initialize the database tables
- After Render deploys, open the backend service **Shell** and run:
	- `npm run db:init`

3) Create the admin user
- In the same Shell:
	- `npm run create-admin -- admin yourStrongPassword`

4) Deploy frontend on Netlify
- In Netlify, **New site from Git** and select this repo.
- Build settings are auto-detected from `netlify.toml`.
- Set Netlify environment variable:
	- `API_BASE` = `https://<your-render-service>.onrender.com`

That’s it—Netlify will auto-generate `frontend/config.js` during build so the public page and hidden `/admin` page call your Render backend.

### Option A2: Render (backend + Postgres) + Vercel (frontend)

1) Deploy backend on Render (Blueprint)
- Same as Option A steps 1–3.

2) Deploy frontend on Vercel
- In Vercel, **New Project** and select this repo.
- Vercel will use `vercel.json`:
	- build command generates `frontend/config.js`
	- output is the `frontend/` folder (static site)
- Set Vercel environment variable (Project Settings → Environment Variables):
	- `API_BASE` = `https://<your-render-service>.onrender.com`

3) (Optional but recommended) Lock down CORS on the backend
- In Render service env vars, set:
	- `FRONTEND_ORIGIN` = `https://<your-vercel-site>.vercel.app`

### Option B: Single-host deploy (backend serves frontend)
- Set backend env var `SERVE_FRONTEND=true` and deploy only the backend.
- Your public UI and `/admin` will be served by the same domain.

## API
- `GET /api/fish-prices` (public)
- `GET /api/fish-prices/:fish_type` (public)
- `GET /api/fish-types` (public helper)
- `GET /api/gas-prices` (public)
- `GET /api/predictions` (public)
- `GET /api/predictions/:fish_type` (public)
- `POST /api/admin/login` (public; rate-limited)
- `POST /api/fish-prices` (admin)
- `PUT /api/fish-prices/:id` (admin)
- `DELETE /api/fish-prices/:id` (admin)
- `POST /api/gas-prices` (admin; upsert by date)
- `DELETE /api/gas-prices/:date` (admin)
- `POST /api/admin/predictions/run` (admin; manually trigger prediction job)

## Predictions (automated)
The backend can auto-generate predictions from the last 2–3 months of data.

Env vars (optional):
- `ENABLE_PREDICTIONS=true` (default)
- `PREDICTION_INTERVAL_DAYS=3` (default)
- `PREDICTION_TRAINING_DAYS=90` (default)
- `PREDICTION_HORIZON_DAYS=3` (default)

## Branding (logo)
- Place your logo image at `frontend/images/logo.png`.
- It will appear in the top-left header on both the public page and the admin page.
