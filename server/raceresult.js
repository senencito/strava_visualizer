// server/raceresult.js — Fetch all finishers from a my.raceresult.com event
const fetch = require('node-fetch');
const { query, queryOne } = require('../db/client');

const RATE_LIMIT_MS = 300;

// ── Parse event ID from any my.raceresult.com URL ─────────────────────────────
function parseRaceResultUrl(url) {
  const m = url.match(/my\.raceresult\.com\/(\d+)/);
  if (!m) throw new Error(`Cannot parse event ID from URL: ${url}`);
  return m[1];
}

// ── Format HH:MM:SS,cc string → total seconds ─────────────────────────────────
function parseTimeToSeconds(val) {
  if (!val || typeof val !== 'string') return null;
  // Strip centiseconds: "01:21:37,03" → "01:21:37"
  const clean = val.split(',')[0].trim();
  const parts = clean.split(':').map(Number);
  if (parts.some(isNaN) || parts.length < 2) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function fmtTime(s) {
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

// ── Fetch one page of the list for a specific group ───────────────────────────
// groupby params control which contest/gender/agegroup is shown
async function fetchPage(eventId, listname, groupFilters, numResults, page) {
  // Build query string manually — URLSearchParams encodes | as %7C which RaceResult rejects
  const parts = [
    `listname=${encodeURIComponent(listname)}`,
    `num_results=${numResults || 500}`,
    `page=${page || 1}`,
  ];

  // Add group filters (f0, f1, f2...)
  if (groupFilters) {
    Object.entries(groupFilters).forEach(([k, v]) => {
      if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(v)}`);
    });
  }

  const url = `https://my.raceresult.com/${eventId}/RRPublish/data/list?${parts.join('&')}`;
  console.log(`  Fetching: ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/javascript, */*',
      'Referer': `https://my.raceresult.com/${eventId}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 20000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RaceResult API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Discover the list name and structure ──────────────────────────────────────
async function discoverEvent(eventId) {
  // Try common list names
  const candidates = ['Online|Final', 'Results|All', 'Online|Results', 'Results|Final', 'Online|All'];

  for (const listname of candidates) {
    try {
      const data = await fetchPage(eventId, listname, {}, 5, 1);
      if (data.data && Object.keys(data.data).length > 0) {
        return {
          listname,
          dataFields: data.DataFields || [],
          groupFilters: data.groupFilters || [],
          contests: (data.groupFilters || [])
            .filter(g => g.Type === 1)
            .flatMap(g => g.Values.filter(Boolean)),
        };
      }
    } catch(e) { /* try next */ }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
  throw new Error('Could not find results list — try providing the listname manually');
}

// ── Extract finishers from the nested data structure ──────────────────────────
// data shape: { "#1_ContestName": { "#1_SubGroup": [[...rows...], [totalCount]] } }
function extractFinishers(data, dataFields) {
  const finishers = [];
  const bibIdx       = dataFields.indexOf('BIB');
  const nameIdx      = dataFields.indexOf('LASTNAME');
  const ageGroupIdx  = dataFields.indexOf('AGEGROUP.NAME');
  const finishIdx    = dataFields.findIndex(f => f.includes('Finish') || f.includes('FINISH'));
  const rankIdx      = dataFields.findIndex(f => f.includes('AUTORANK') || f.includes('Rank') || f.includes('rank'));

  // Walk the nested structure
  for (const [contestKey, subGroups] of Object.entries(data)) {
    const contestName = contestKey.replace(/^#\d+_/, '');

    for (const [subKey, rows] of Object.entries(subGroups)) {
      const subGroupName = subKey.replace(/^#\d+_/, '');
      // Skip non-overall subgroups to avoid duplicate counting
      // We use the gender subgroups (Female/Male) as they have names
      // The unnamed "#1_" group appears to be bib-only without names — skip it
      if (!subGroupName || subGroupName === '') continue;

      for (const row of rows) {
        // Last row is [totalCount] — skip single-element rows
        if (!Array.isArray(row) || row.length === 1) continue;

        const bib      = bibIdx >= 0  ? String(row[bibIdx] || '').trim() : null;
        const name     = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : null;
        const ageGroup = ageGroupIdx >= 0 ? String(row[ageGroupIdx] || '').trim() : null;
        const chipTime = finishIdx >= 0 ? parseTimeToSeconds(row[finishIdx]) : null;
        const rankRaw  = rankIdx >= 0 ? String(row[rankIdx] || '') : null;
        const rank     = rankRaw ? parseInt(rankRaw.replace(/\D/g, '')) || null : null;

        // Infer gender from subgroup name
        const genderStr = subGroupName.toLowerCase();
        const gender = genderStr.includes('female') || genderStr.includes('f') ? 2
                     : genderStr.includes('male')   || genderStr.includes('m') ? 1
                     : null;

        if (!name) continue; // skip bib-only rows

        finishers.push({ bib, name, ageGroup, chipTime, rank, gender, contest: contestName });
      }
    }
  }

  return finishers;
}

// ── Fetch ALL finishers across all pages ──────────────────────────────────────
async function fetchAllFinishers(eventId, listname, dataFields, groupFilters, onProgress) {
  const PAGE_SIZE = 500; // RaceResult supports large pages
  const all = [];

  // Get each contest separately via groupFilter f0
  const contestFilter = (groupFilters || []).find(g => g.Type === 1);
  const contests = contestFilter ? contestFilter.Values.filter(Boolean) : [''];

  for (const contest of contests) {
    let page = 1;
    while (true) {
      const filters = contest ? { f0: contest } : {};
      const result = await fetchPage(eventId, listname, filters, PAGE_SIZE, page);

      if (!result.data || !Object.keys(result.data).length) break;

      const batch = extractFinishers(result.data, dataFields || result.DataFields || []);
      if (!batch.length) break;

      // Tag with contest for dedup
      all.push(...batch);
      if (onProgress) onProgress(all.length);

      // Check if we got a full page (more to come)
      const totalInPage = Object.values(result.data)
        .flatMap(sg => Object.values(sg))
        .flatMap(rows => rows.filter(r => r.length === 1).map(r => r[0]))
        .reduce((a, b) => Math.max(a, b), 0);

      if (batch.length < PAGE_SIZE || (page * PAGE_SIZE) >= totalInPage) break;
      page++;
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  // Deduplicate by bib + contest
  const seen = new Set();
  return all.filter(f => {
    const key = `${f.contest}:${f.bib}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main import function ───────────────────────────────────────────────────────
async function importRaceResult({ url, eventName, raceName, eventDate, distanceM, location, replace = false, listname: manualListname }) {
  const eventId = parseRaceResultUrl(url);

  // Check existing
  const existing = await queryOne(
    `SELECT id, total_finishers FROM race_events
     WHERE sporthive_event_id=$1 AND sporthive_race_id='rr'`,
    [eventId]
  );

  if (existing && !replace) {
    return {
      ok: false,
      already_imported: true,
      race_event_id: existing.id,
      total_finishers: existing.total_finishers,
      message: `Already imported with ${existing.total_finishers} finishers.`,
    };
  }

  // Discover list structure
  console.log(`Discovering RaceResult event ${eventId}...`);
  let discovery;
  if (manualListname) {
    const probe = await fetchPage(eventId, manualListname, {}, 5, 1);
    discovery = {
      listname: manualListname,
      dataFields: probe.DataFields || [],
      groupFilters: probe.groupFilters || [],
    };
  } else {
    discovery = await discoverEvent(eventId);
  }

  console.log(`Using list: ${discovery.listname}`);
  console.log(`Fields: ${discovery.dataFields.join(', ')}`);

  // Fetch all finishers
  let progress = 0;
  const finishers = await fetchAllFinishers(
    eventId,
    discovery.listname,
    discovery.dataFields,
    discovery.groupFilters,
    n => { progress = n; console.log(`  Fetched ${n}...`); }
  );

  if (!finishers.length) throw new Error('No finishers found');

  const totalFinishers = finishers.length;

  // Delete existing if replacing
  if (existing && replace) {
    await query(`DELETE FROM race_finishers WHERE race_event_id=$1`, [existing.id]);
    await query(`DELETE FROM race_events WHERE id=$1`, [existing.id]);
  }

  // Insert race event (reuse race_events table, raceId='rr' for raceresult)
  const [raceEvent] = await query(`
    INSERT INTO race_events (
      sporthive_event_id, sporthive_race_id,
      event_name, race_name, event_date,
      distance_m, location, total_finishers
    ) VALUES ($1,'rr',$2,$3,$4,$5,$6,$7)
    RETURNING id
  `, [eventId, eventName || `RaceResult ${eventId}`, raceName || null,
      eventDate || null, distanceM || null, location || null, totalFinishers]);

  const raceEventId = raceEvent.id;

  // Compute overall rank from chip time if not present
  finishers.sort((a, b) => (a.chipTime || 99999) - (b.chipTime || 99999));
  finishers.forEach((f, i) => { if (!f.rank) f.rank = i + 1; });

  // Batch insert
  const BATCH = 50;
  for (let i = 0; i < finishers.length; i += BATCH) {
    const batch = finishers.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    batch.forEach(f => {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(raceEventId, f.bib, f.name, f.gender, f.ageGroup, f.rank, f.chipTime);
    });

    await query(`
      INSERT INTO race_finishers
        (race_event_id, bib, name, gender, age_group, overall_rank, chip_time_s)
      VALUES ${values.join(',')}
    `, params);
  }

  // Age group breakdown
  const ageCounts = finishers.reduce((acc, f) => {
    const k = f.ageGroup || 'Unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    race_event_id: raceEventId,
    event_id: eventId,
    source: 'raceresult',
    event_name: eventName,
    total_finishers: totalFinishers,
    age_groups: Object.keys(ageCounts).length,
    age_group_breakdown: ageCounts,
    listname: discovery.listname,
    sample: finishers.slice(0, 3).map(f => ({
      rank: f.rank, bib: f.bib, name: f.name,
      category: f.ageGroup, time: fmtTime(f.chipTime),
    })),
  };
}

module.exports = { importRaceResult, parseRaceResultUrl, fmtTime };
