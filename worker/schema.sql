-- Agency leaderboard — D1 (SQLite) schema.
-- One row per opt-in install. No repo names, transcripts, or PII — just a
-- display handle and the standardized score derived server-side.
CREATE TABLE IF NOT EXISTS scores (
  install_id    TEXT PRIMARY KEY,   -- client-generated UUID (anonymous identity)
  handle        TEXT NOT NULL,      -- chosen display name (<=32 chars, sanitized)
  output_tokens INTEGER NOT NULL,   -- lifetime output tokens submitted
  eng_years     REAL NOT NULL,      -- = output_tokens / 5_520_000 (server-computed)
  sources       TEXT,               -- json array, subset of [claude, codex, opencode]
  created_at    INTEGER NOT NULL,   -- ms epoch, first submit
  updated_at    INTEGER NOT NULL    -- ms epoch, last submit
);
CREATE INDEX IF NOT EXISTS idx_scores_eng_years ON scores(eng_years DESC);
