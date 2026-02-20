// import-csilo-2025.js
// One-time import of CSILO Run 2025 results from extracted PDF text.
//
// Usage:
//   node import-csilo-2025.js
// Requires DATABASE_URL set in .env or environment.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, queryOne, initDB } = require('./db/client');

const TXT_FILE = path.join(__dirname, 'temp_files', 'csilo_2025_extracted.txt');

// ── Time parsing ──────────────────────────────────────────────────────────────
// Handles: "HH:MM:SS,cc"  "HH:MM:SS"  "MM:SS"  "H:MM:SS"
function parseTime(val) {
  if (!val) return null;
  const clean = val.split(',')[0].trim(); // strip centiseconds
  const parts = clean.split(':').map(Number);
  if (parts.some(isNaN) || parts.length < 2) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// Matches both "HH:MM:SS,cc" and "MM:SS" style times
const TIME_TOKEN = /\b\d{1,2}:\d{2}(?::\d{2})?(?:,\d{2})?\b/g;

// Data row: "42. 1234 Some Name [AgeGroup] time [time ...]"
const ROW_RE = /^(\d+)\.\s+(\d+)\s+(.*?)\s+(\d{1,2}:\d{2}.*)$/;

// Lines to discard (headers, page numbers)
const SKIP_RE = /^(CSILO Run|Results|Pl\.\s+Bib|\d+\s*$)/;

// ── Section header patterns ───────────────────────────────────────────────────
const RACE_RE    = /^(Half Marathon|5K|Silla de ruedas)$/;
const GENDER_RE  = /^(Female|Male)$/;
const AG_STD_RE  = /^(Female|Male)\s+(\d{1,2}[-+]\d{0,2}|\d{2}\+)$/;
const AG_OPEN_RE = /^Open\s+(F|M)$/i;
const OVERALL_RE = /^overall$/i;

// Inline age-group suffix on data rows (e.g. "Female 30-34", "Open F", "overall")
const AG_INLINE_RE = /\s+((?:(?:Female|Male)\s+(?:\d{1,2}[-+]\d{0,2}|\d{2}\+))|Open\s+[FM]|overall)\s*$/i;

// ── Parser ────────────────────────────────────────────────────────────────────
function parsePDF(text) {
  const lines = text.split('\n');

  let currentRace  = null;    // 'hm' | '5k'
  let sectionType  = null;    // 'overall' | 'gender' | 'agegroup'
  let gender       = null;    // 1=M, 2=F
  let ageGroup     = null;    // e.g. "Female 30-34"

  const races = {
    hm:  { overall: new Map(), gender: new Map(), agegroup: new Map() },
    '5k': { overall: new Map(), gender: new Map(), agegroup: new Map() },
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || SKIP_RE.test(line)) continue;

    // ── Race-level header ──
    const raceM = RACE_RE.exec(line);
    if (raceM) {
      currentRace = (raceM[1] === '5K') ? '5k' : 'hm';
      sectionType = 'overall';
      gender = null;
      ageGroup = null;
      continue;
    }

    // ── "overall" named sub-section (elite runners, bibs 1-20) ──
    if (OVERALL_RE.test(line)) {
      sectionType = 'agegroup';
      gender = null;
      ageGroup = 'Overall';
      continue;
    }

    // ── Gender-only section (top N per gender) ──
    if (GENDER_RE.test(line)) {
      gender = line === 'Female' ? 2 : 1;
      ageGroup = null;
      sectionType = 'gender';
      continue;
    }

    // ── Standard age-group section "Female 30-34" ──
    const agM = AG_STD_RE.exec(line);
    if (agM) {
      gender = agM[1] === 'Female' ? 2 : 1;
      ageGroup = line;
      sectionType = 'agegroup';
      continue;
    }

    // ── Wheelchair "Open F" / "Open M" ──
    const openM = AG_OPEN_RE.exec(line);
    if (openM) {
      gender = openM[1].toUpperCase() === 'F' ? 2 : 1;
      ageGroup = `Open ${openM[1].toUpperCase()}`;
      sectionType = 'agegroup';
      continue;
    }

    if (!currentRace) continue;

    // ── Data row ──
    const rowM = ROW_RE.exec(line);
    if (!rowM) continue;

    const rank     = parseInt(rowM[1]);
    const bib      = rowM[2];
    let nameAndAG  = rowM[3].trim();
    const timesPart = rowM[4];

    // FINISH = last time on the row
    const times = timesPart.match(TIME_TOKEN) || [];
    if (!times.length) continue;
    const chipTimeS = parseTime(times[times.length - 1]);

    // Strip inline age group from name field
    let inlineAG = null;
    const agInlineM = AG_INLINE_RE.exec(nameAndAG);
    if (agInlineM) {
      inlineAG = agInlineM[1];
      nameAndAG = nameAndAG.slice(0, agInlineM.index).trim();
    }

    const resolvedAG = inlineAG || ageGroup || null;
    // bib-only rows (overall HM section): name === bib string
    const name = (nameAndAG === bib) ? null : (nameAndAG || null);

    const raceData = races[currentRace];

    if (sectionType === 'overall') {
      // Bib-only section → just capture overall rank
      raceData.overall.set(bib, rank);
    } else if (sectionType === 'gender') {
      raceData.gender.set(bib, rank);
    } else if (sectionType === 'agegroup') {
      // First occurrence wins (avoids duplicates if bib appears in multiple sections)
      if (!raceData.agegroup.has(bib)) {
        raceData.agegroup.set(bib, {
          bib,
          name,
          gender: gender,
          ageGroup: resolvedAG,
          ageGroupRank: rank,
          chipTimeS,
        });
      }
    }
  }

  return races;
}

// ── Merge rank data into finisher records ─────────────────────────────────────
function buildFinishers(raceData) {
  return Array.from(raceData.agegroup.values()).map(f => ({
    ...f,
    overallRank: raceData.overall.get(f.bib) || null,
    genderRank:  raceData.gender.get(f.bib)  || null,
  }));
}

// ── DB insert ─────────────────────────────────────────────────────────────────
async function insertRace(raceId, finishers, meta) {
  const existing = await queryOne(
    `SELECT id FROM race_events WHERE sporthive_event_id=$1 AND sporthive_race_id=$2`,
    [meta.eventId, raceId]
  );
  if (existing) {
    console.log(`  Replacing existing import for ${meta.raceName}...`);
    await query(`DELETE FROM race_finishers WHERE race_event_id=$1`, [existing.id]);
    await query(`DELETE FROM race_events     WHERE id=$1`,           [existing.id]);
  }

  const [row] = await query(`
    INSERT INTO race_events
      (sporthive_event_id, sporthive_race_id, event_name, race_name,
       event_date, distance_m, location, total_finishers)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    meta.eventId, raceId, meta.eventName, meta.raceName,
    meta.eventDate, meta.distanceM, meta.location, finishers.length,
  ]);

  const raceEventId = row.id;
  const BATCH = 50;

  for (let i = 0; i < finishers.length; i += BATCH) {
    const batch = finishers.slice(i, i + BATCH);
    const vals = [], params = [];
    let p = 1;
    batch.forEach(f => {
      vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        raceEventId,
        f.bib      || null,
        f.name     || null,
        f.gender   || null,
        f.ageGroup || null,
        f.overallRank  || null,
        f.genderRank   || null,
        f.ageGroupRank || null,
        f.chipTimeS    || null,
      );
    });
    await query(`
      INSERT INTO race_finishers
        (race_event_id, bib, name, gender, age_group,
         overall_rank, gender_rank, age_group_rank, chip_time_s)
      VALUES ${vals.join(',')}
    `, params);
  }

  console.log(`✅ ${meta.raceName}: ${finishers.length} finishers  (race_event_id=${raceEventId})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await initDB();

  const text = fs.readFileSync(TXT_FILE, 'utf8');
  const races = parsePDF(text);

  const EVENT_ID   = 'csilo-2025';
  const EVENT_DATE = '2025-08-24';          // set to 'YYYY-MM-DD' if known
  const LOCATION   = 'Puerto Rico';

  for (const [raceKey, raceData] of Object.entries(races)) {
    const finishers = buildFinishers(raceData);
    if (!finishers.length) { console.log(`No finishers for ${raceKey}, skipping.`); continue; }

    const isHM = raceKey === 'hm';
    const raceName   = isHM ? 'Half Marathon' : '5K';
    const distanceM  = isHM ? 21097 : 5000;

    console.log(`\n${raceName}: ${finishers.length} finishers`);
    console.log('Sample:', finishers.slice(0, 2).map(f =>
      `${f.bib} ${f.name} (${f.ageGroup}) → ${f.chipTimeS}s`
    ).join(' | '));

    await insertRace(raceKey, finishers, {
      eventId:   EVENT_ID,
      eventName: 'CSILO Run 2025',
      raceName,
      eventDate: EVENT_DATE,
      distanceM,
      location:  LOCATION,
    });
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
