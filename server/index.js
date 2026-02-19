// server/index.js — Senén Strava Visualizer backend
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const fetch        = require('node-fetch');
const path         = require('path');
const { pool, query, queryOne, initDB } = require('../db/client');
const { syncActivities, getStreams, stravaFetch } = require('./strava');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'senen-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  },
}));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.athleteId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

async function getAthlete(req) {
  return queryOne(`SELECT * FROM athletes WHERE strava_id=$1`, [req.session.athleteId]);
}

// ── OAuth routes ──────────────────────────────────────────────────────────────

// Step 1: Redirect to Strava
app.get('/auth/strava', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.STRAVA_CLIENT_ID,
    redirect_uri:  process.env.STRAVA_REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

// Step 2: Strava redirects back here with ?code=
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?error=access_denied');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const data = await tokenRes.json();
    const a    = data.athlete;

    // Upsert athlete in DB
    await query(`
      INSERT INTO athletes (
        strava_id, username, firstname, lastname, profile_pic,
        city, country, access_token, refresh_token, token_expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (strava_id) DO UPDATE SET
        access_token     = EXCLUDED.access_token,
        refresh_token    = EXCLUDED.refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        firstname        = EXCLUDED.firstname,
        lastname         = EXCLUDED.lastname,
        profile_pic      = EXCLUDED.profile_pic,
        updated_at       = NOW()
    `, [
      a.id, a.username, a.firstname, a.lastname, a.profile_medium,
      a.city, a.country,
      data.access_token, data.refresh_token, data.expires_at,
    ]);

    req.session.athleteId = a.id;

    // Check if profile is complete (sex + birthdate set)
    const dbAthlete = await queryOne(`SELECT sex, birthdate FROM athletes WHERE strava_id=$1`, [a.id]);
    if (!dbAthlete.sex || !dbAthlete.birthdate) {
      res.redirect('/profile-setup');
    } else {
      res.redirect('/app');
    }

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?error=oauth_failed');
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Profile setup ─────────────────────────────────────────────────────────────

app.post('/api/profile', requireAuth, async (req, res) => {
  const { sex, birthdate } = req.body;
  if (!sex || !birthdate) return res.status(400).json({ error: 'Missing fields' });

  await query(
    `UPDATE athletes SET sex=$1, birthdate=$2, updated_at=NOW() WHERE strava_id=$3`,
    [sex, birthdate, req.session.athleteId]
  );
  res.json({ ok: true });
});

// ── Me ────────────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
  const athlete = await getAthlete(req);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  res.json({
    strava_id:  athlete.strava_id,
    firstname:  athlete.firstname,
    lastname:   athlete.lastname,
    profile_pic: athlete.profile_pic,
    sex:        athlete.sex,
    birthdate:  athlete.birthdate,
    city:       athlete.city,
    country:    athlete.country,
    last_sync_at: athlete.last_sync_at,
  });
});

// ── Activities ────────────────────────────────────────────────────────────────

// Sync new activities from Strava (incremental)
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const athlete = await getAthlete(req);
    const newCount = await syncActivities(athlete);
    res.json({ ok: true, new_activities: newCount });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get activities from DB (filtered by distance range)
app.get('/api/activities', requireAuth, async (req, res) => {
  const { dist_min = 0, dist_max = 999999 } = req.query;
  const rows = await query(`
    SELECT
      a.strava_id   AS id,
      a.name,
      a.distance_m,
      a.moving_time_s,
      a.start_date_local,
      a.workout_type,
      a.has_heartrate,
      a.ae_score,
      a.avg_heartrate,
      a.avg_speed_ms,
      a.total_elevation_m,
      a.gear_id,
      g.name        AS gear_name,
      g.brand_name  AS gear_brand
    FROM activities a
    LEFT JOIN gear g ON g.strava_id = a.gear_id
    WHERE a.athlete_id = $1
      AND a.distance_m >= $2
      AND a.distance_m <= $3
    ORDER BY a.start_date_local DESC
    LIMIT 200
  `, [req.session.athleteId, dist_min, dist_max]);
  res.json(rows);
});

// ── Streams ───────────────────────────────────────────────────────────────────

app.get('/api/streams/:activityId', requireAuth, async (req, res) => {
  try {
    const athlete = await getAthlete(req);
    // Verify this activity belongs to this athlete
    const act = await queryOne(
      `SELECT strava_id FROM activities WHERE strava_id=$1 AND athlete_id=$2`,
      [req.params.activityId, req.session.athleteId]
    );
    if (!act) return res.status(403).json({ error: 'Not your activity' });

    const streams = await getStreams(athlete, req.params.activityId);
    res.json(streams);
  } catch (err) {
    console.error('Streams error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ 
  ok: true, 
  ts: new Date(),
  has_client_id: !!process.env.STRAVA_CLIENT_ID,
  client_id_preview: process.env.STRAVA_CLIENT_ID?.slice(0,3) || 'MISSING',
  has_secret: !!process.env.STRAVA_CLIENT_SECRET,
  has_db: !!process.env.DATABASE_URL,
}));
// ── SPA catch-all ─────────────────────────────────────────────────────────────

app.get('/app', (req, res) => {
  if (!req.session.athleteId) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

app.get('/profile-setup', (req, res) => {
  if (!req.session.athleteId) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/profile-setup.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 Senén Strava Visualizer running on port ${PORT}`);
  });
}

start().catch(console.error);
