-- ============================================================
-- TikTok Ingestion Extension Schema
-- Run against your Supabase project via:
--   supabase db push  OR  paste into the SQL Editor
-- ============================================================

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: tokscript_transcripts
-- Stores fetched video transcripts with semantic search support
-- ============================================================
CREATE TABLE IF NOT EXISTS tokscript_transcripts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 TEXT        NOT NULL UNIQUE,
  platform            TEXT        NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  title               TEXT,
  author              TEXT,
  duration            INTEGER,                          -- seconds
  transcript          TEXT        NOT NULL,
  embedding           VECTOR(1536),
  tags                TEXT[]      DEFAULT '{}',
  metadata            JSONB       DEFAULT '{}'::jsonb,
  content_fingerprint TEXT        UNIQUE,               -- SHA-256 of url, dedup guard
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for semantic similarity search
CREATE INDEX IF NOT EXISTS tokscript_transcripts_embedding_idx
  ON tokscript_transcripts
  USING hnsw (embedding vector_cosine_ops);

-- GIN index for metadata filtering
CREATE INDEX IF NOT EXISTS tokscript_transcripts_metadata_idx
  ON tokscript_transcripts
  USING gin (metadata);

-- Filter by platform
CREATE INDEX IF NOT EXISTS tokscript_transcripts_platform_idx
  ON tokscript_transcripts (platform);

-- Date range queries
CREATE INDEX IF NOT EXISTS tokscript_transcripts_created_at_idx
  ON tokscript_transcripts (created_at DESC);

-- Auto-update updated_at (reuse existing function if it exists, else create it)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tokscript_transcripts_updated_at ON tokscript_transcripts;
CREATE TRIGGER tokscript_transcripts_updated_at
  BEFORE UPDATE ON tokscript_transcripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: service role only
ALTER TABLE tokscript_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON tokscript_transcripts
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Table: tokscript_tokens
-- Single-row OAuth token store for TokScript
-- ============================================================
CREATE TABLE IF NOT EXISTS tokscript_tokens (
  id            INTEGER     PRIMARY KEY DEFAULT 1,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- RLS: service role only
ALTER TABLE tokscript_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON tokscript_tokens
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Table: tokscript_oauth_state
-- Ephemeral PKCE state storage during OAuth callback flow
-- ============================================================
CREATE TABLE IF NOT EXISTS tokscript_oauth_state (
  state           TEXT        PRIMARY KEY,
  code_verifier   TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-expire stale state entries (10 minute TTL handled in code,
-- this index supports cleanup queries)
CREATE INDEX IF NOT EXISTS tokscript_oauth_state_created_at_idx
  ON tokscript_oauth_state (created_at);

ALTER TABLE tokscript_oauth_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON tokscript_oauth_state
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RPC: match_tokscript_transcripts
-- Semantic similarity search over tokscript_transcripts
-- Mirrors the match_thoughts function signature
-- ============================================================
CREATE OR REPLACE FUNCTION match_tokscript_transcripts(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 10,
  filter           JSONB   DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id          UUID,
  url         TEXT,
  platform    TEXT,
  title       TEXT,
  author      TEXT,
  transcript  TEXT,
  metadata    JSONB,
  tags        TEXT[],
  similarity  FLOAT,
  created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.url,
    t.platform,
    t.title,
    t.author,
    t.transcript,
    t.metadata,
    t.tags,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM tokscript_transcripts t
  WHERE
    t.embedding IS NOT NULL
    AND (1 - (t.embedding <=> query_embedding)) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
