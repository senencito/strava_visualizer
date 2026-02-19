// server/sporthive.js — Fetch all finishers from a Sporthive race
const fetch = require('node-fetch');
const { query, queryOne } = require('../db/client');

const PAGE_SIZE = 50;   // Sporthive max per request
const RATE_LIMIT_MS = 350;
const API_BASE = 'https://eventresults-api.sporthive.com/api';

// ── Parse event/race IDs from any Sporthive URL ───────────────────────────────
// Handles:
//   https://results.sporthive.com/events/123/races/3
//   https://results.sporthive.com/events/123/races/3/bib/456
//   https://results.sporthive.com/events/123          ← event only, raceId null
function parseSporthiveUrl(url) {
  const withRace = url.match(/events\/(\d+)\/races\/(\d+)/);
  if (withRace) return { eventId: withRace[1], raceId: withRace[2] };

  const eventOnly = url.match(/events\/(\d+)/);
  if (eventOnly) return { eventId: eventOnly[1], raceId: null };

  throw new Error(`Cannot parse event ID from URL: ${url}`);
}

// ── Fetch available races for an event ────────────────────────────────────────
async function fetchEventRaces(eventId) {
  const url = `${API_BASE}/events/${eventId}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SenenViz/1.0)', 'Accept': 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Could not fetch event ${eventId}: ${res.status}`);
  const data = await res.json();
  // Sporthive returns races array on the event object
  const races = data.races || data.event?.races || [];
  return races.map(r => ({
    id:   String(r.id || r.raceId || r.race_id),
    name: r.name || r.raceName || r.race_name || `Race ${r.id}`,
    distance: r.distance || null,
    participants: r.participantCount || r.participants || null,
  }));
}

// ── Fetch one page ─────────────────────────────────────────────────────────────
async function fetchPage(eventId, raceId, offset) {
  const url = `${API_BASE}/events/${eventId}/races/${raceId}/classifications/search?count=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SenenViz/1.0)',
      'Accept': 'application/json',
    },
    timeout: 15000,
  });

  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Sporthive API ${res.status} at offset ${offset}`);

  const data = await res.json();

  // Response shape: { fullClassifications: [ { classification: {...} }, ... ] }
  if (Array.isArray(data.fullClassifications)) {
    return data.fullClassifications.map(f => normalizeFinisher(f.classification || f));
  }
  // Fallback shapes
  if (Array.isArray(data)) return data.map(f => normalizeFinisher(f));
  return [];
}

// Normalize different field name conventions to a consistent shape
function normalizeFinisher(f) {
  return {
    bib:          f.bib || f.bibNumber || f.startNumber || null,
    name:         f.name || [f.firstName, f.lastName].filter(Boolean).join(' ') || null,
    gender:       f.gender ?? (f.genderCode === 'M' ? 1 : f.genderCode === 'F' ? 2 : null),
    category:     f.category || f.ageGroup || f.categoryName || null,
    rank:         f.rank ?? f.overallRank ?? f.position ?? null,
    genderRank:   f.genderRank ?? f.rankGender ?? null,
    categoryRank: f.categoryRank ?? f.rankCategory ?? null,
    chipTime:     f.chipTime ?? f.finishTime ?? f.time ?? null,
    countryCode:  f.countryCode || f.nationality || null,
  };
}

// ── Fetch ALL finishers across pages ──────────────────────────────────────────
async function fetchAllFinishers(eventId, raceId, onProgress) {
  const all = [];
  let offset = 0;

  while (true) {
    const batch = await fetchPage(eventId, raceId, offset);
    if (!batch.length) break;

    all.push(...batch);
    if (onProgress) onProgress(all.length);

    if (batch.length < PAGE_SIZE) break;
    offset += batch.length;
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
async function importRace({ url, eventName, raceName, eventDate, distanceM, location, replace = false, raceId: explicitRaceId }) {
  const { eventId, raceId: parsedRaceId } = parseSporthiveUrl(url);
  const raceId = explicitRaceId || parsedRaceId;

  // If no race ID, fetch the list of races so the user can pick
  if (!raceId) {
    const races = await fetchEventRaces(eventId);
    return { ok: false, needs_race_selection: true, eventId, races };
  }

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

module.exports = { importRace, lookupBib, parseSporthiveUrl, fetchEventRaces, fmtTime };
