# Deploy: Netlify (frontend) + Supabase (Postgres) + VM (backend)

This repo’s backend is an always-on Express server (and runs an in-process prediction scheduler). That means you should deploy the backend to an always-on host (VM), not serverless functions.

## 0) What you’ll deploy

- Frontend: Netlify (static site from the `frontend/` folder)
- Database: Supabase Postgres
- Backend: Node/Express on a VM (Ubuntu recommended)

## 1) Supabase: create DB + get connection string

In Supabase:
- Create a project
- Go to **Connect** → **Direct** → choose **URI**
- Copy the URI (starts with `postgresql://...`)

You will use that value as `DATABASE_URL` for the backend.

Supabase typically requires SSL.
- Set `PGSSL=true` on your backend host.

## 2) Initialize schema on Supabase

Run from your local machine (or on the VM after cloning):

PowerShell:
- `cd backend`
- `$env:DATABASE_URL="<your supabase postgresql://... URI>"`
- `$env:PGSSL="true"`
- `npm ci`
- `npm run db:init`

## 3) Create an admin user

PowerShell:
- `cd backend`
- `$env:DATABASE_URL="<your supabase URI>"`
- `$env:PGSSL="true"`
- `npm run create-admin -- admin yourStrongPassword`

## 4) Deploy backend to a VM (Ubuntu)

### A. VM prerequisites

- Open inbound TCP 80/443 (and optionally 22 for SSH)
- Install Node.js (LTS), npm, and nginx

### B. Create a dedicated user + install the app

On the VM:
- Create an app user (example): `sudo adduser --system --group isdapresyo`
- Create app folder: `sudo mkdir -p /opt/isdapresyo`
- `sudo chown -R isdapresyo:isdapresyo /opt/isdapresyo`
- Clone your repo into `/opt/isdapresyo` (as `isdapresyo` user)
- `cd /opt/isdapresyo/backend && npm ci`

### C. Configure environment variables

You must set at least:
- `NODE_ENV=production`
- `PORT=3000`
- `DATABASE_URL=<supabase URI>`
- `PGSSL=true`
- `JWT_SECRET=<long random string>`
- `FRONTEND_ORIGIN=https://<your-netlify-site>.netlify.app`
- `SERVE_FRONTEND=false`

### D. Run as a service (systemd)

Use the template in `deploy/vm/isdapresyo-backend.service`.

Typical install steps:
- Copy to: `/etc/systemd/system/isdapresyo-backend.service`
- Edit the `Environment=` lines (or point to an EnvironmentFile)
- `sudo systemctl daemon-reload`
- `sudo systemctl enable isdapresyo-backend`
- `sudo systemctl start isdapresyo-backend`
- `sudo systemctl status isdapresyo-backend`

### E. Put nginx in front

Use the template in `deploy/vm/nginx-isdapresyo-backend.conf`.

After configuring nginx:
- `sudo nginx -t`
- `sudo systemctl reload nginx`

Then add TLS (recommended) using Certbot or your preferred method.

## 5) Deploy frontend to Netlify

Netlify is already configured via `netlify.toml`.

In Netlify site settings, set environment variables:
- `API_BASE=https://<your backend public origin>`

Redeploy the Netlify site so the build regenerates `frontend/config.js`.

## 6) Quick smoke tests

Once deployed:
- `GET https://api.example.com/api/health`
  - should return `{ ok: true, demoMode: false, ... }`
- Open the Netlify site and try:
  - public fish prices load
  - admin login works
