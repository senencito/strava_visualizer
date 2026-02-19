# Senén Strava Visualizer

Animated Strava run visualizer with elevation, pace, heart rate and aerobic efficiency charts. Multi-race comparison, shoe tracking, and incremental activity caching.

## Stack

- **Frontend** — Vanilla JS + SVG charts (no frameworks)
- **Backend** — Node.js + Express
- **Database** — PostgreSQL (Railway managed)
- **Auth** — Strava OAuth 2.0 (server-side, secure)
- **Hosting** — Railway

---

## Deploy to Railway (15 minutes)

### Step 1 — Create a Strava API App

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Create a new application
3. Set **Authorization Callback Domain** to `your-app.railway.app` (you'll update this after deploy)
4. Note your **Client ID** and **Client Secret**

### Step 2 — Push to GitHub

```bash
# Clone or create your repo
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/senen-viz
git push -u origin main
```

### Step 3 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository
4. Railway will auto-detect Node.js and start building

### Step 4 — Add PostgreSQL

1. In your Railway project, click **New → Database → Add PostgreSQL**
2. Railway automatically sets `DATABASE_URL` in your app's environment ✅

### Step 5 — Set Environment Variables

In Railway dashboard → your app → **Variables**, add:

| Variable | Value |
|----------|-------|
| `STRAVA_CLIENT_ID` | From Strava API settings |
| `STRAVA_CLIENT_SECRET` | From Strava API settings |
| `STRAVA_REDIRECT_URI` | `https://your-app.railway.app/auth/callback` |
| `SESSION_SECRET` | Random string (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `NODE_ENV` | `production` |

### Step 6 — Update Strava Callback Domain

1. Go back to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Update **Authorization Callback Domain** to `your-app.railway.app`
3. Update `STRAVA_REDIRECT_URI` in Railway to match

### Step 7 — Done! 🎉

Visit `https://your-app.railway.app` — users can now log in with Strava directly.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env

# You need a local Postgres instance
# On Mac: brew install postgresql && brew services start postgresql
# Create DB: createdb senen_viz
# Update DATABASE_URL in .env

# Start dev server (auto-restarts on changes)
npm run dev

# Visit http://localhost:3000
```

For local Strava OAuth, set:
- `STRAVA_REDIRECT_URI=http://localhost:3000/auth/callback`  
- Strava app **Authorization Callback Domain**: `localhost`

---

## Architecture

```
senen-strava/
├── server/
│   ├── index.js      # Express app, routes, OAuth flow
│   └── strava.js     # Strava API wrapper, token refresh, caching
├── db/
│   ├── client.js     # PostgreSQL pool + helpers
│   └── schema.sql    # Tables: athletes, activities, streams, gear
├── public/
│   ├── index.html    # Landing page with "Connect with Strava"
│   ├── profile-setup.html  # One-time sex/birthdate form
│   └── app.html      # Main visualizer app
├── .env.example
├── railway.toml
└── package.json
```

## How caching works

1. First login → full activity sync from Strava (all pages)
2. Subsequent visits → only fetches activities newer than `last_sync_at`
3. Streams (GPS/HR data) cached in DB after first view — never re-fetched
4. Gear names cached per `gear_id` — fetched once, stored forever

## Database tables

| Table | Purpose |
|-------|---------|
| `athletes` | Strava profile + tokens + sex/birthdate |
| `activities` | Cached run metadata + pre-computed AE score |
| `streams` | Cached GPS/pace/HR arrays (JSONB) |
| `gear` | Shoe names by gear_id |
| `session` | Express session store |
