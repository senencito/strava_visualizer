-- ═══════════════════════════════════════════════════════
-- Senén Strava Visualizer — PostgreSQL Schema
-- Run once on first deploy (Railway will run this automatically
-- if you wire it up, or run manually via Railway's query console)
-- ═══════════════════════════════════════════════════════

-- Sessions table (for express-session / connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON    NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- Athletes
CREATE TABLE IF NOT EXISTS athletes (
  id              SERIAL PRIMARY KEY,
  strava_id       BIGINT UNIQUE NOT NULL,
  username        VARCHAR(100),
  firstname       VARCHAR(100),
  lastname        VARCHAR(100),
  profile_pic     TEXT,
  sex             CHAR(1),          -- 'M' or 'F' or NULL
  birthdate       DATE,             -- user-provided (Strava API doesn't expose it)
  city            VARCHAR(100),
  country         VARCHAR(100),
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  token_expires_at BIGINT NOT NULL, -- unix timestamp
  last_sync_at    TIMESTAMPTZ,      -- last time we fetched new activities
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Gear / Shoes
CREATE TABLE IF NOT EXISTS gear (
  id          SERIAL PRIMARY KEY,
  strava_id   VARCHAR(50) UNIQUE NOT NULL,  -- e.g. "g12345678"
  athlete_id  BIGINT REFERENCES athletes(strava_id) ON DELETE CASCADE,
  name        VARCHAR(200),
  brand_name  VARCHAR(100),
  model_name  VARCHAR(100),
  distance_m  FLOAT,   -- total distance on this shoe in meters
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Activities
CREATE TABLE IF NOT EXISTS activities (
  id              SERIAL PRIMARY KEY,
  strava_id       BIGINT UNIQUE NOT NULL,
  athlete_id      BIGINT REFERENCES athletes(strava_id) ON DELETE CASCADE,
  name            VARCHAR(300),
  distance_m      FLOAT,
  moving_time_s   INT,
  elapsed_time_s  INT,
  start_date      TIMESTAMPTZ,
  start_date_local TIMESTAMPTZ,
  activity_type   VARCHAR(50),
  sport_type      VARCHAR(50),
  workout_type    INT,
  gear_id         VARCHAR(50) REFERENCES gear(strava_id),
  avg_heartrate   FLOAT,
  max_heartrate   FLOAT,
  avg_speed_ms    FLOAT,
  total_elevation_m FLOAT,
  has_heartrate   BOOLEAN DEFAULT FALSE,
  ae_score        FLOAT,   -- pre-computed avg aerobic efficiency
  map_polyline    TEXT,    -- summary polyline from Strava
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_athlete ON activities(athlete_id);
CREATE INDEX IF NOT EXISTS idx_activities_start   ON activities(start_date DESC);
CREATE INDEX IF NOT EXISTS idx_activities_dist    ON activities(distance_m);

-- Streams (GPS, pace, HR, elevation per activity)
CREATE TABLE IF NOT EXISTS streams (
  id          SERIAL PRIMARY KEY,
  activity_id BIGINT REFERENCES activities(strava_id) ON DELETE CASCADE UNIQUE,
  time_s      JSONB,      -- array of seconds
  distance_m  JSONB,      -- array of meters
  altitude_m  JSONB,      -- array of meters
  velocity_ms JSONB,      -- array of m/s (smooth)
  heartrate   JSONB,      -- array of bpm (nullable)
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_streams_activity ON streams(activity_id);
