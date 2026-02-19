// server/sporthive.js — Fetch all finishers from a Sporthive race
const fetch = require('node-fetch');
const { query, queryOne } = require('../db/client');

const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 350; // polite delay between pages

// ── Parse event/race IDs from any Sporthive URL ───────────────────────────────
function parseSporthiveUrl(url) {
  const m = url.match(/events\/(\d+)\/races\/(\d+)/);
  if (!m) throw new Error(`Cannot parse event/race IDs from: ${url}`);
  return { eventId: m[1], raceId: m[2] };
}

// ── Fetch one page ─────────────────────────────────────────────────────────────
async function fetchPage(eventId, raceId, page) {
  const url = `https://sporthive.com/api/events/${eventId}/races/${raceId}/participants?count=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SenenViz/1.0)',
      'Accept': 'application/json',
    },
    timeout: 15000,
  });

  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Sporthive API ${res.status} on page ${page}`);

  const data = await res.json();

  // Handle different response shapes
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.participants)) return data.participants;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

// ── Fetch ALL finishers across pages ──────────────────────────────────────────
async function fetchAllFinishers(eventId, raceId, onProgress) {
  const all = [];
  let page = 0;

  while (true) {
    const batch = await fetchPage(eventId, raceId, page);
    if (!batch.length) break;

    all.push(...batch);
    if (onProgress) onProgress(all.length);

    if (batch.length < PAGE_SIZE) break;
    page++;
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return all;
}

// ── Format seconds → H:MM:SS ──────────────────────────────────────────────────
function fmtTime(s) {
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

// ── Main import function ───────────────────────────────────────────────────────
async function importRace({ url, eventName, raceName, eventDate, distanceM, location, replace = false }) {
  const { eventId, raceId } = parseSporthiveUrl(url);

  // Check for existing import
  const existing = await queryOne(
    `SELECT id, total_finishers FROM race_events WHERE sporthive_event_id=$1 AND sporthive_race_id=$2`,
    [eventId, raceId]
  );

  if (existing && !replace) {
    return {
      ok: false,
      already_imported: true,
      race_event_id: existing.id,
      total_finishers: existing.total_finishers,
      message: `Already imported with ${existing.total_finishers} finishers. Use replace=true to re-import.`,
    };
  }

  // Fetch all finishers
  let progress = 0;
  const finishers = await fetchAllFinishers(eventId, raceId, n => { progress = n; });

  if (!finishers.length) {
    throw new Error('No finishers returned — check event/race IDs');
  }

  // Compute totals by category for context
  const totalFinishers = finishers.length;

  // Delete existing if replacing
  if (existing && replace) {
    await query(`DELETE FROM race_finishers WHERE race_event_id=$1`, [existing.id]);
    await query(`DELETE FROM race_events WHERE id=$1`, [existing.id]);
  }

  // Insert race event
  const [raceEvent] = await query(`
    INSERT INTO race_events (
      sporthive_event_id, sporthive_race_id,
      event_name, race_name, event_date,
      distance_m, location, total_finishers
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    eventId, raceId,
    eventName || `Race ${eventId}`,
    raceName || null,
    eventDate || null,
    distanceM || null,
    location || null,
    totalFinishers,
  ]);

  const raceEventId = raceEvent.id;

  // Batch insert finishers — 50 at a time
  const BATCH = 50;
  let inserted = 0;

  for (let i = 0; i < finishers.length; i += BATCH) {
    const batch = finishers.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    batch.forEach(f => {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        raceEventId,
        f.bib || null,
        f.name || null,
        f.gender || null,
        f.category || null,
        f.rank || null,
        f.genderRank || null,
        f.categoryRank || null,
        f.chipTime || null,
        f.countryCode || null
      );
    });

    await query(`
      INSERT INTO race_finishers
        (race_event_id, bib, name, gender, age_group,
         overall_rank, gender_rank, age_group_rank, chip_time_s, country_code)
      VALUES ${values.join(',')}
    `, params);

    inserted += batch.length;
  }

  // Compute age group totals (count per age_group for percentile calcs)
  const ageCounts = finishers.reduce((acc, f) => {
    if (f.category) acc[f.category] = (acc[f.category] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    race_event_id: raceEventId,
    event_id: eventId,
    race_id: raceId,
    event_name: eventName,
    total_finishers: inserted,
    age_groups: Object.keys(ageCounts).length,
    age_group_breakdown: ageCounts,
    sample: finishers.slice(0, 3).map(f => ({
      rank: f.rank,
      bib: f.bib,
      name: f.name,
      category: f.category,
      time: fmtTime(f.chipTime),
    })),
  };
}

// ── Look up a single bib result ───────────────────────────────────────────────
async function lookupBib(raceEventId, bib) {
  const finisher = await queryOne(`
    SELECT f.*, e.event_name, e.event_date, e.total_finishers, e.distance_m
    FROM race_finishers f
    JOIN race_events e ON e.id = f.race_event_id
    WHERE f.race_event_id = $1 AND f.bib = $2
  `, [raceEventId, bib]);

  if (!finisher) return null;

  // Count age group total
  const ageTotal = await queryOne(
    `SELECT COUNT(*) as n FROM race_finishers WHERE race_event_id=$1 AND age_group=$2`,
    [raceEventId, finisher.age_group]
  );
  const genderTotal = await queryOne(
    `SELECT COUNT(*) as n FROM race_finishers WHERE race_event_id=$1 AND gender=$2`,
    [raceEventId, finisher.gender]
  );

  return {
    ...finisher,
    chip_time_fmt: fmtTime(finisher.chip_time_s),
    age_group_total: parseInt(ageTotal?.n || 0),
    gender_total: parseInt(genderTotal?.n || 0),
    overall_pct:    finisher.overall_rank   ? Math.round((1 - finisher.overall_rank   / finisher.total_finishers) * 100) : null,
    age_group_pct:  finisher.age_group_rank ? Math.round((1 - finisher.age_group_rank / parseInt(ageTotal?.n || 1)) * 100) : null,
    gender_pct:     finisher.gender_rank    ? Math.round((1 - finisher.gender_rank    / parseInt(genderTotal?.n || 1)) * 100) : null,
  };
}

module.exports = { importRace, lookupBib, parseSporthiveUrl, fmtTime };
