// server/strava.js — Strava API wrapper with auto token refresh
const fetch = require('node-fetch');
const { query, queryOne } = require('../db/client');

const STRAVA_BASE = 'https://www.strava.com/api/v3';

// ── Weather fetch (Open-Meteo, free, no API key) ───────────────────────────────
async function fetchWeather(lat, lon, isoDate) {
  if (!lat || !lon) return { temp_c: null, humidity_pct: null };
  try {
    // Open-Meteo historical API — date must be YYYY-MM-DD
    const date = isoDate.slice(0, 10);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=temperature_2m,relativehumidity_2m&timezone=auto`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return { temp_c: null, humidity_pct: null };
    const data = await res.json();

    // Find the closest hour to the activity start time
    const hour = parseInt(isoDate.slice(11, 13)) || 0;
    const temps = data.hourly?.temperature_2m || [];
    const humids = data.hourly?.relativehumidity_2m || [];

    return {
      temp_c:       temps[hour]  != null ? Math.round(temps[hour]  * 10) / 10 : null,
      humidity_pct: humids[hour] != null ? Math.round(humids[hour]) : null,
    };
  } catch(e) {
    console.warn('Weather fetch failed:', e.message);
    return { temp_c: null, humidity_pct: null };
  }
}

// ── Token management ──────────────────────────────────────────────────────────

async function refreshTokenIfNeeded(athlete) {
  const now = Math.floor(Date.now() / 1000);
  if (athlete.token_expires_at > now + 60) {
    return athlete.access_token; // still valid
  }

  console.log(`Refreshing token for athlete ${athlete.strava_id}...`);
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: athlete.refresh_token,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();

  await query(
    `UPDATE athletes SET access_token=$1, refresh_token=$2, token_expires_at=$3, updated_at=NOW()
     WHERE strava_id=$4`,
    [data.access_token, data.refresh_token, data.expires_at, athlete.strava_id]
  );

  return data.access_token;
}

// ── Generic authenticated fetch ───────────────────────────────────────────────

async function stravaFetch(athlete, path, params = {}) {
  const token = await refreshTokenIfNeeded(athlete);
  const url = new URL(`${STRAVA_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Activities sync ───────────────────────────────────────────────────────────

async function syncActivities(athlete) {
  // Figure out what timestamp to fetch from
  const lastSync = athlete.last_sync_at
    ? Math.floor(new Date(athlete.last_sync_at).getTime() / 1000)
    : 0;

  console.log(`Syncing activities for ${athlete.strava_id} since ${lastSync}`);

  let page = 1;
  let totalNew = 0;

  while (true) {
    const params = { per_page: 50, page };
    if (lastSync > 0) params.after = lastSync;
    const acts = await stravaFetch(athlete, '/athlete/activities', params);

    if (!Array.isArray(acts) || acts.length === 0) break;

    for (const a of acts) {
      // Only sync runs
      const isRun = ['Run','VirtualRun','TrailRun'].includes(a.type) ||
                    (a.sport_type || '').toLowerCase().includes('run');
      if (!isRun) continue;

      // Upsert gear if present
      if (a.gear_id) {
        await upsertGear(athlete, a.gear_id);
      }

      // Pre-compute AE score from summary data
      const ae = (a.average_speed && a.average_heartrate)
        ? parseFloat((a.average_speed / a.average_heartrate * 1000).toFixed(4))
        : null;

      // Save and use start lat/lon
      const lat = a.start_latlng?.[0] || null;
      const lon = a.start_latlng?.[1] || null;
      const { temp_c, humidity_pct } = await fetchWeather(lat, lon, a.start_date);

      // Upsert activity
      await query(`
        INSERT INTO activities (
          strava_id, athlete_id, name, distance_m, moving_time_s, elapsed_time_s,
          start_date, start_date_local, activity_type, sport_type, workout_type,
          gear_id, avg_heartrate, max_heartrate, avg_speed_ms, total_elevation_m,
          has_heartrate, ae_score, map_polyline, start_lat, start_lng, temp_c, humidity_pct
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (strava_id) DO UPDATE SET
          name=EXCLUDED.name, gear_id=EXCLUDED.gear_id,
          avg_heartrate=EXCLUDED.avg_heartrate, ae_score=EXCLUDED.ae_score,
          start_lat=COALESCE(activities.start_lat, EXCLUDED.start_lat),
          start_lng=COALESCE(activities.start_lng, EXCLUDED.start_lng),
          temp_c=COALESCE(activities.temp_c, EXCLUDED.temp_c),
          humidity_pct=COALESCE(activities.humidity_pct, EXCLUDED.humidity_pct)
      `, [
        a.id, athlete.strava_id, a.name,
        a.distance, a.moving_time, a.elapsed_time,
        a.start_date, a.start_date_local,
        a.type, a.sport_type, a.workout_type,
        a.gear_id || null,
        a.average_heartrate || null, a.max_heartrate || null,
        a.average_speed || null, a.total_elevation_gain || null,
        a.has_heartrate || false,
        ae,
        a.map?.summary_polyline || null,
        lat, lon, temp_c, humidity_pct,
      ]);

      totalNew++;
    }

    if (acts.length < 50) break;
    page++;
  }

  // Update last sync timestamp
  await query(
    `UPDATE athletes SET last_sync_at=NOW() WHERE strava_id=$1`,
    [athlete.strava_id]
  );

  // After sync, find any race matches for this athlete
  const raceMatches = await findRaceMatches(athlete.strava_id);

  console.log(`Synced ${totalNew} new activities for ${athlete.strava_id}`);
  return { newActivities: totalNew, raceMatches };
}

// ── Gear upsert ───────────────────────────────────────────────────────────────

async function upsertGear(athlete, gearId) {
  // Check cache first
  const existing = await queryOne(`SELECT id FROM gear WHERE strava_id=$1`, [gearId]);
  if (existing) return;

  try {
    const g = await stravaFetch(athlete, `/gear/${gearId}`);
    await query(`
      INSERT INTO gear (strava_id, athlete_id, name, brand_name, model_name, distance_m)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (strava_id) DO UPDATE SET name=EXCLUDED.name
    `, [g.id, athlete.strava_id, g.name, g.brand_name, g.model_name, g.distance]);
  } catch (e) {
    console.warn(`Could not fetch gear ${gearId}:`, e.message);
  }
}

// ── Streams (cached) ──────────────────────────────────────────────────────────

async function getStreams(athlete, activityId) {
  // Check cache first
  const cached = await queryOne(
    `SELECT * FROM streams WHERE activity_id=$1`, [activityId]
  );
  if (cached) {
    console.log(`Streams cache hit: ${activityId}`);
    return cached;
  }

  // Fetch from Strava
  console.log(`Fetching streams from Strava: ${activityId}`);
  const data = await stravaFetch(athlete, `/activities/${activityId}/streams`, {
    keys: 'distance,altitude,time,velocity_smooth,heartrate',
    key_by_type: 'true',
  });

  // Cache in DB
  await query(`
    INSERT INTO streams (activity_id, time_s, distance_m, altitude_m, velocity_ms, heartrate)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (activity_id) DO NOTHING
  `, [
    activityId,
    JSON.stringify(data.time?.data || []),
    JSON.stringify(data.distance?.data || []),
    JSON.stringify(data.altitude?.data || []),
    JSON.stringify(data.velocity_smooth?.data || []),
    JSON.stringify(data.heartrate?.data || null),
  ]);

  return {
    time_s:     data.time?.data || [],
    distance_m: data.distance?.data || [],
    altitude_m: data.altitude?.data || [],
    velocity_ms: data.velocity_smooth?.data || [],
    heartrate:  data.heartrate?.data || null,
  };
}

// ── Race matching ─────────────────────────────────────────────────────────────
// Find activities that likely correspond to a race in the DB (±7 days, ±10% distance)
// Returns races the athlete hasn't yet claimed
async function findRaceMatches(athleteId) {
  const rows = await query(`
    SELECT
      re.id              AS race_event_id,
      re.event_name,
      re.event_date,
      re.distance_m      AS race_distance_m,
      re.location,
      a.strava_id        AS activity_id,
      a.name             AS activity_name,
      a.start_date_local,
      a.distance_m       AS activity_distance_m,
      a.moving_time_s,
      -- Check athlete hasn't already claimed a result in this race
      (SELECT COUNT(*) FROM race_finishers rf
       WHERE rf.race_event_id = re.id AND rf.athlete_id = $1) AS already_claimed
    FROM race_events re
    JOIN activities a ON (
      a.athlete_id = $1
      -- Date within ±7 days of race
      AND ABS(EXTRACT(EPOCH FROM (a.start_date_local::date - re.event_date)) / 86400) <= 7
      -- Distance within ±10%
      AND re.distance_m > 0
      AND a.distance_m BETWEEN re.distance_m * 0.90 AND re.distance_m * 1.10
    )
    WHERE re.event_date IS NOT NULL
    ORDER BY re.event_date DESC
  `, [athleteId]);

  return rows.filter(r => parseInt(r.already_claimed) === 0);
}

module.exports = { syncActivities, getStreams, stravaFetch, refreshTokenIfNeeded, findRaceMatches };
