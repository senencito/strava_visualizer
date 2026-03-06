// server/racerecord-com.js — Scraper for racerecord.com leaderboard pages
// HTML is server-rendered; we parse the "Time" tab for finish times across all divisions.
const fetch = require('node-fetch');
const { query, queryOne } = require('../db/client');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 1500; // delay between division requests to avoid bot detection

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse race ID from a racerecord.com/race/leaderboard/{id}/... URL ─────────
function parseRaceRecordComUrl(url) {
  const m = url.match(/racerecord\.com\/race\/leaderboard\/(\d+)/);
  if (!m) throw new Error(`Cannot parse race ID from racerecord.com URL: ${url}`);
  return m[1];
}

// ── Fetch leaderboard HTML page, optionally filtered by division ──────────────
async function fetchLeaderboard(raceId, division = null) {
  const base = `https://racerecord.com/race/leaderboard/${raceId}`;
  const url  = division ? `${base}?leaderboardDivision=${encodeURIComponent(division)}` : base;
  const res  = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer':         'https://racerecord.com/',
    },
    timeout: 20000,
  });
  if (!res.ok) throw new Error(`racerecord.com fetch failed: ${res.status} for ${url}`);
  const text = await res.text();
  if (text.includes('automated behavior patterns')) {
    throw new Error('racerecord.com blocked the request. Try again later.');
  }
  return text;
}

// ── Parse event metadata from JSON-LD embedded in the page ───────────────────
function parseMeta(html) {
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let eventName = null, eventDate = null, location = null;
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      eventName = ld.name || null;
      if (ld.startDate) {
        // Normalize "2026-3-1" → "2026-03-01"
        const parts = ld.startDate.split('-');
        if (parts.length === 3) {
          eventDate = `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
        }
      }
      if (ld.location && ld.location.address) {
        const a = ld.location.address;
        location = [a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
      }
    } catch(e) {}
  }
  return { eventName, eventDate, location };
}

// ── Extract all division codes from the division select dropdown ──────────────
function parseDivisions(html) {
  const re = /leaderboardDivision=([A-Z0-9+]+)['"&]/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) seen.add(m[1]);
  return [...seen];
}

// ── Strip HTML tags and decode basic entities ─────────────────────────────────
function strip(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Parse finish time string "H:MM:SS" or "M:SS" → total seconds ─────────────
function parseTime(t) {
  if (!t) return null;
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN) || parts.length < 2) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ── Parse finisher rows from the "Time" tab in the leaderboard HTML ───────────
// Returns [{ bib, name, gender, overallRank, chipTimeSec }]
function parseFinishers(html, divisionCode = null) {
  // The active tab-pane contains the finish times. Its div has class including "active".
  // Pattern: <div class='tab-pane fade show  active' id='pills-NNNNN' role='tabpanel'
  const activeTabRe = /id='(pills-\d+)'\s+role='tabpanel'[^>]*class='[^']*active[^']*'|class='tab-pane[^']*active[^']*'\s+id='(pills-\d+)'/;
  // Simpler: just find the tab-pane div that contains "active"
  // Strategy: find the last occurrence of tab-pane with "active" in class
  let tableHtml = html;
  const allPanes = [...html.matchAll(/id='(pills-\d+)'\s+role='tabpanel'/g)];
  // Find the one with active class nearby
  for (const pane of allPanes) {
    const idx  = pane.index;
    const pre  = html.slice(Math.max(0, idx - 50), idx + 50);
    if (pre.includes('active')) {
      tableHtml = html.slice(idx);
      break;
    }
  }
  // Fallback: look for the section explicitly containing "active" before id='pills-
  const activeDivMatch = html.match(/class='tab-pane[^']*active[^']*'\s+id='(pills-\d+)'/);
  if (activeDivMatch) {
    const divIdx = html.indexOf(`id='${activeDivMatch[1]}'`);
    if (divIdx >= 0) tableHtml = html.slice(divIdx);
  }

  const finishers = [];
  // Match each runner row
  const rowRe = /<tr onclick="window\.location='\/runner\/show\?rid=(\d+)&amp;race=\d+'"\s*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const inner = m[2];
    // Extract all <td> content in order
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(inner)) !== null) tds.push(strip(td[1]));

    // Columns: [place, name, bib, age, sex, time, diff]
    // place is in the first <td style="width: 60px"> — extract first integer
    if (tds.length < 6) continue;
    const placeStr  = tds[0].match(/^\d+/);
    const place     = placeStr ? parseInt(placeStr[0]) : null;
    const name      = tds[1] || null;
    const bib       = tds[2] || null;
    const sex       = tds[4] || null;
    const timeStr   = tds[5] || null;
    const chipTimeSec = parseTime(timeStr);
    const gender    = sex === 'M' ? 1 : sex === 'F' ? 2 : null;

    if (!name || !bib || !chipTimeSec) continue;
    finishers.push({ bib, name, gender, overallRank: place, chipTimeSec });
  }
  return finishers;
}

// ── Main import function ───────────────────────────────────────────────────────
async function importRaceRecordCom({ url, eventName, raceName, eventDate, distanceM, location, replace }) {
  const raceId = parseRaceRecordComUrl(url);
  console.log(`[racerecord.com] Importing race ${raceId}...`);

  // 1. Fetch main page — metadata + divisions list + top-overall finishers
  const mainHtml   = await fetchLeaderboard(raceId);
  const meta       = parseMeta(mainHtml);
  const divisions  = parseDivisions(mainHtml);

  const resolvedEventName = eventName  || meta.eventName || `Race ${raceId}`;
  const resolvedDate      = eventDate  || meta.eventDate  || null;
  const resolvedLocation  = location   || meta.location   || null;
  const resolvedDistance  = distanceM  ? parseFloat(distanceM) : null;

  console.log(`  Event: ${resolvedEventName}, Date: ${resolvedDate}, Divisions: ${divisions.length}`);

  // 2. Handle replace
  const sporthiveEventId = `racerecord-${raceId}`;
  const sporthiveRaceId  = 'main';
  if (replace) {
    await query(`DELETE FROM race_events WHERE sporthive_event_id=$1 AND sporthive_race_id=$2`,
      [sporthiveEventId, sporthiveRaceId]);
    console.log('  Deleted existing event for replace.');
  }
  const existing = await queryOne(
    `SELECT id FROM race_events WHERE sporthive_event_id=$1 AND sporthive_race_id=$2`,
    [sporthiveEventId, sporthiveRaceId]
  );
  if (existing && !replace) {
    throw new Error(`Race racerecord-${raceId} already imported. Use replace=true to re-import.`);
  }

  // 3. Collect finishers from main page + all divisions
  // Key: bib → { bib, name, gender, overallRank, chipTimeSec, ageGroup, ageGroupRank }
  const byBib = new Map();

  // Overall top-finishers (sets overallRank for top runners)
  const mainFinishers = parseFinishers(mainHtml, null);
  mainFinishers.forEach(f => byBib.set(f.bib, { ...f, ageGroup: null, ageGroupRank: null }));
  console.log(`  Main page: ${mainFinishers.length} finishers`);

  // Each division page — fills in the rest + sets ageGroup/ageGroupRank
  for (const div of divisions) {
    await sleep(DELAY_MS);
    try {
      const html        = await fetchLeaderboard(raceId, div);
      const divFinishers = parseFinishers(html, div);
      let added = 0;
      divFinishers.forEach((f, idx) => {
        const existing = byBib.get(f.bib);
        const ageGroupRank = idx + 1; // rank within division (1-based, by page order)
        if (existing) {
          // Enrich with age group info
          existing.ageGroup     = div;
          existing.ageGroupRank = ageGroupRank;
        } else {
          byBib.set(f.bib, { ...f, ageGroup: div, ageGroupRank, overallRank: null });
          added++;
        }
      });
      console.log(`  Division ${div}: ${divFinishers.length} finishers (${added} new)`);
    } catch(e) {
      console.warn(`  Failed to fetch division ${div}: ${e.message}`);
    }
  }

  const finishers = [...byBib.values()];
  console.log(`  Total unique finishers: ${finishers.length}`);

  // 4. Upsert race_event
  const { rows: [raceEvent] } = await query(`
    INSERT INTO race_events
      (sporthive_event_id, sporthive_race_id, event_name, race_name,
       event_date, distance_m, location, total_finishers)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (sporthive_event_id, sporthive_race_id) DO UPDATE SET
      event_name=EXCLUDED.event_name, race_name=EXCLUDED.race_name,
      event_date=EXCLUDED.event_date, distance_m=EXCLUDED.distance_m,
      location=EXCLUDED.location, total_finishers=EXCLUDED.total_finishers
    RETURNING id
  `, [
    sporthiveEventId, sporthiveRaceId,
    resolvedEventName, raceName || resolvedEventName,
    resolvedDate, resolvedDistance, resolvedLocation,
    finishers.length,
  ]);
  const raceEventId = raceEvent.id;

  // 5. Insert finishers in batches
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < finishers.length; i += BATCH) {
    const batch  = finishers.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let   p      = 1;
    batch.forEach(f => {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        raceEventId, f.bib, f.name, f.gender,
        f.ageGroup || null,
        f.overallRank || null,
        f.chipTimeSec
      );
    });
    await query(`
      INSERT INTO race_finishers
        (race_event_id, bib, name, gender, age_group, overall_rank, chip_time_s)
      VALUES ${values.join(',')}
    `, params);
    inserted += batch.length;
  }

  return {
    ok: true,
    inserted,
    total: finishers.length,
    eventName: resolvedEventName,
    divisions: divisions.length,
  };
}

module.exports = { importRaceRecordCom, parseRaceRecordComUrl };
