-- ============================================================
-- Social Media Ingestion Extension Schema
-- Run against your Supabase project via:
--   supabase db push  OR  paste into the SQL Editor
-- ============================================================

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: social_media_transcripts
-- Stores fetched social media transcripts with semantic search support
-- ============================================================
CREATE TABLE IF NOT EXISTS social_media_transcripts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 TEXT        NOT NULL UNIQUE,
  platform            TEXT        NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube', 'unknown')),
  provider            TEXT        NOT NULL CHECK (provider IN ('tokscript', 'elevenlabs', 'openrouter_vision', 'youtube_captions')),
  content_type        TEXT        NOT NULL DEFAULT 'video' CHECK (content_type IN ('video', 'photo_carousel', 'unknown')),
  title               TEXT,
  author              TEXT,
  duration            INTEGER,                          -- seconds
  language            TEXT,
  transcript          TEXT        NOT NULL,
  image_urls          TEXT[]      DEFAULT '{}',
  embedding           VECTOR(1536),
  tags                TEXT[]      DEFAULT '{}',
  metadata            JSONB       DEFAULT '{}'::jsonb,
  content_fingerprint TEXT        UNIQUE,               -- SHA-256 of normalized URL, dedup guard
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for semantic similarity search
CREATE INDEX IF NOT EXISTS social_media_transcripts_embedding_idx
  ON social_media_transcripts
  USING hnsw (embedding vector_cosine_ops);

-- GIN indexes for metadata and array filtering
CREATE INDEX IF NOT EXISTS social_media_transcripts_metadata_idx
  ON social_media_transcripts
  USING gin (metadata);

CREATE INDEX IF NOT EXISTS social_media_transcripts_tags_idx
  ON social_media_transcripts
  USING gin (tags);

-- Common filters
CREATE INDEX IF NOT EXISTS social_media_transcripts_platform_idx
  ON social_media_transcripts (platform);

CREATE INDEX IF NOT EXISTS social_media_transcripts_provider_idx
  ON social_media_transcripts (provider);

CREATE INDEX IF NOT EXISTS social_media_transcripts_content_type_idx
  ON social_media_transcripts (content_type);

CREATE INDEX IF NOT EXISTS social_media_transcripts_created_at_idx
  ON social_media_transcripts (created_at DESC);

ALTER TABLE social_media_transcripts
  DROP CONSTRAINT IF EXISTS social_media_transcripts_provider_check;

ALTER TABLE social_media_transcripts
  ADD CONSTRAINT social_media_transcripts_provider_check
  CHECK (provider IN ('tokscript', 'elevenlabs', 'openrouter_vision', 'youtube_captions'));

-- Auto-update updated_at (reuse existing function if it exists, else create it)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_media_transcripts_updated_at ON social_media_transcripts;
CREATE TRIGGER social_media_transcripts_updated_at
  BEFORE UPDATE ON social_media_transcripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: service role only
ALTER TABLE social_media_transcripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON social_media_transcripts;
CREATE POLICY "Service role full access"
  ON social_media_transcripts
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Table: social_media_provider_tokens
-- OAuth token store for providers that need token refresh
-- ============================================================
CREATE TABLE IF NOT EXISTS social_media_provider_tokens (
  provider_id   TEXT        PRIMARY KEY CHECK (provider_id IN ('tokscript')),
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  client_id     TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  metadata      JSONB       DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE social_media_provider_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON social_media_provider_tokens;
CREATE POLICY "Service role full access"
  ON social_media_provider_tokens
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Table: social_media_oauth_state
-- Ephemeral PKCE state storage during OAuth callback flow
-- ============================================================
CREATE TABLE IF NOT EXISTS social_media_oauth_state (
  state           TEXT        PRIMARY KEY,
  provider_id     TEXT        NOT NULL CHECK (provider_id IN ('tokscript')),
  code_verifier   TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_media_oauth_state_created_at_idx
  ON social_media_oauth_state (created_at);

ALTER TABLE social_media_oauth_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON social_media_oauth_state;
CREATE POLICY "Service role full access"
  ON social_media_oauth_state
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Table: social_media_provider_preferences
-- Deployment-level provider preferences used before built-in defaults
-- ============================================================
CREATE TABLE IF NOT EXISTS social_media_provider_preferences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      TEXT        CHECK (platform IS NULL OR platform IN ('tiktok', 'instagram', 'youtube', 'unknown')),
  content_type  TEXT        CHECK (content_type IS NULL OR content_type IN ('video', 'photo_carousel', 'unknown')),
  provider      TEXT        NOT NULL CHECK (provider IN ('tokscript', 'elevenlabs', 'openrouter_vision', 'youtube_captions')),
  priority      INTEGER     NOT NULL DEFAULT 100,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE social_media_provider_preferences
  DROP CONSTRAINT IF EXISTS social_media_provider_preferences_provider_check;

ALTER TABLE social_media_provider_preferences
  ADD CONSTRAINT social_media_provider_preferences_provider_check
  CHECK (provider IN ('tokscript', 'elevenlabs', 'openrouter_vision', 'youtube_captions'));

CREATE UNIQUE INDEX IF NOT EXISTS social_media_provider_preferences_scope_idx
  ON social_media_provider_preferences (
    COALESCE(platform, '__any__'),
    COALESCE(content_type, '__any__')
  );

CREATE INDEX IF NOT EXISTS social_media_provider_preferences_priority_idx
  ON social_media_provider_preferences (priority DESC, updated_at DESC);

DROP TRIGGER IF EXISTS social_media_provider_preferences_updated_at ON social_media_provider_preferences;
CREATE TRIGGER social_media_provider_preferences_updated_at
  BEFORE UPDATE ON social_media_provider_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE social_media_provider_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON social_media_provider_preferences;
CREATE POLICY "Service role full access"
  ON social_media_provider_preferences
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RPC: match_social_media_transcripts
-- Semantic similarity search over social_media_transcripts
-- ============================================================
CREATE OR REPLACE FUNCTION match_social_media_transcripts(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 10,
  filter           JSONB   DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id            UUID,
  url           TEXT,
  platform      TEXT,
  provider      TEXT,
  content_type  TEXT,
  title         TEXT,
  author        TEXT,
  language      TEXT,
  transcript    TEXT,
  metadata      JSONB,
  tags          TEXT[],
  similarity    FLOAT,
  created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.url,
    t.platform,
    t.provider,
    t.content_type,
    t.title,
    t.author,
    t.language,
    t.transcript,
    t.metadata,
    t.tags,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM social_media_transcripts t
  WHERE
    t.embedding IS NOT NULL
    AND (1 - (t.embedding <=> query_embedding)) > match_threshold
    AND (NOT filter ? 'platform' OR t.platform = filter->>'platform')
    AND (NOT filter ? 'provider' OR t.provider = filter->>'provider')
    AND (NOT filter ? 'content_type' OR t.content_type = filter->>'content_type')
    AND (
      (filter - 'platform' - 'provider' - 'content_type') = '{}'::jsonb
      OR t.metadata @> (filter - 'platform' - 'provider' - 'content_type')
    )
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;