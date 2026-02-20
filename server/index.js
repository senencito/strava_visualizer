// server/index.js — Senén Strava Visualizer backend
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const fetch        = require('node-fetch');
const path         = require('path');
const { pool, query, queryOne, initDB } = require('../db/client');
const { syncActivities, getStreams, stravaFetch } = require('./strava');
const { importRace, lookupBib, fmtTime } = require('./sporthive');
const { importRaceResult, parseRaceResultUrl } = require('./raceresult');

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

// HTTP Basic Auth for admin routes — browser shows native login dialog
function requireAdmin(req, res, next) {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    // No password set — block access entirely in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).send('Admin access disabled — set ADMIN_PASSWORD env var');
    }
    return next(); // dev mode: allow without auth
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Senén Admin"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');

  if (user !== adminUser || pass !== adminPass) {
    res.set('WWW-Authenticate', 'Basic realm="Senén Admin"');
    return res.status(401).send('Invalid credentials');
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


// ── Admin page ────────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(require('path').join(__dirname, '../public/admin.html'));
});

// ── Race import (admin only) ───────────────────────────────────────────────────
app.post('/api/admin/import-race', requireAdmin, async (req, res) => {
  const { url, event_name, race_name, race_id, event_date, distance_m, location, replace, listname } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    // Route to the correct importer based on URL
    let result;
    if (url.includes('raceresult.com')) {
      result = await importRaceResult({ url, eventName: event_name, raceName: race_name, eventDate: event_date, distanceM: distance_m, location, replace, listname });
    } else {
      result = await importRace({ url, eventName: event_name, raceName: race_name, eventDate: event_date, distanceM: distance_m, location, replace, raceId: race_id });
    }
    res.json(result);
  } catch(err) {
    console.error('Import race error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── List all imported races ────────────────────────────────────────────────────
app.get('/api/races', async (req, res) => {
  const rows = await query(`
    SELECT id, sporthive_event_id, sporthive_race_id,
           event_name, race_name, event_date, distance_m,
           location, total_finishers, imported_at
    FROM race_events
    ORDER BY event_date DESC NULLS LAST, imported_at DESC
  `);
  res.json(rows);
});

// ── Get all finishers for a race (paginated) ──────────────────────────────────
app.get('/api/races/:id/finishers', async (req, res) => {
  const { age_group, gender, page = 0, per_page = 100 } = req.query;
  const offset = parseInt(page) * parseInt(per_page);
  let sql = `SELECT * FROM race_finishers WHERE race_event_id=$1`;
  const params = [req.params.id];
  if (age_group) { sql += ` AND age_group=$${params.length+1}`; params.push(age_group); }
  if (gender)    { sql += ` AND gender=$${params.length+1}`;    params.push(gender); }
  sql += ` ORDER BY overall_rank ASC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(per_page, offset);
  const rows = await query(sql, params);
  res.json(rows);
});

// ── Look up a bib in a race ────────────────────────────────────────────────────
app.get('/api/races/:id/bib/:bib', async (req, res) => {
  try {
    const result = await lookupBib(req.params.id, req.params.bib);
    if (!result) return res.status(404).json({ error: 'Bib not found' });
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Age group breakdown for a race ────────────────────────────────────────────
app.get('/api/races/:id/stats', async (req, res) => {
  const groups = await query(`
    SELECT age_group, gender, COUNT(*) as n,
           MIN(chip_time_s) as fastest_s,
           AVG(chip_time_s)::int as avg_s,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY chip_time_s)::int as median_s
    FROM race_finishers
    WHERE race_event_id=$1 AND chip_time_s IS NOT NULL
    GROUP BY age_group, gender
    ORDER BY age_group, gender
  `, [req.params.id]);
  res.json(groups);
});

// ── Claim a result (link bib to logged-in athlete) ────────────────────────────
app.post('/api/races/:id/claim', requireAuth, async (req, res) => {
  const { bib } = req.body;
  if (!bib) return res.status(400).json({ error: 'bib required' });
  // Verify bib exists
  const finisher = await queryOne(
    `SELECT id FROM race_finishers WHERE race_event_id=$1 AND bib=$2`,
    [req.params.id, bib]
  );
  if (!finisher) return res.status(404).json({ error: 'Bib not found in this race' });
  // Link to athlete
  await query(
    `UPDATE race_finishers SET athlete_id=$1 WHERE id=$2`,
    [req.session.athleteId, finisher.id]
  );
  // Return full result with percentiles
  const result = await lookupBib(req.params.id, bib);
  res.json(result);
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date() }));

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
