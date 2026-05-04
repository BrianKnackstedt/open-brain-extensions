# TokScript Ingestion

## Why This Matters

You found a video — a TikTok, an Instagram Reel, a YouTube Short — with something worth remembering. You want to save what it actually said, not just a bookmark, so your AI can reason over it later alongside everything else you know. This extension connects Open Brain to TokScript, a transcript extraction service that supports all three platforms. Every saved transcript gets embedded for semantic search, so you can ask your agent "what have I saved about morning routines?" and get real answers.

## What It Does

Fetches and stores video transcripts from TikTok, Instagram Reels, and YouTube Shorts via [TokScript](https://tokscript.com). Transcripts are saved in dedicated tables with semantic search support — fully isolated from the main `thoughts` table.

For **TikTok photo carousel posts** (URLs containing `/photo/`), the extension automatically scrapes all slide image URLs from the TikTok page and runs vision OCR via Gemini 2.0 Flash, extracting text from every slide. The combined result is stored as the transcript with `vision_extracted: true` in metadata.

**Tables:**
- `tokscript_transcripts` — Stores transcripts with embeddings, tags, and metadata
- `tokscript_tokens` — Single-row OAuth token store (auto-refreshed)
- `tokscript_oauth_state` — Ephemeral PKCE state during the OAuth login flow

**MCP Tools:**
- `save_tokscript_transcript` — Fetch and store a transcript from any supported video URL
- `get_tokscript_transcript_preview` — Fetch a transcript without saving it
- `search_tokscript_transcripts` — Semantically search your saved transcript library
- `list_tokscript_transcripts` — List saved transcripts, filterable by platform

## Prerequisites

- Working Open Brain setup
- Supabase project configured
- Supabase CLI installed and linked to your project
- [TokScript account](https://tokscript.com/pricing) — free plan included (5 extractions/day); paid plan for unlimited access

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

> **Already have your Supabase credentials from the Setup Guide?** You just need the same Project URL and Secret key.

```text
TOKSCRIPT INGESTION -- CREDENTIAL TRACKER
------------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________
  Project ref:           ____________

TOKSCRIPT
  Client ID:             ____________  (generated during Step 3)
  MCP Access Key:        ____________  (same key as Open Brain)
  MCP Connection URL:    ____________

------------------------------------------
```

## Steps

### 1. Set Up the Database Schema

Copy and paste the contents of `schema.sql` into your Supabase SQL Editor and click Run:

```
https://supabase.com/dashboard/project/YOUR_PROJECT_REF/sql/new
```

### 2. Deploy the MCP Server

1. Open a command prompt
2. Browse to your open-brain folder
3. Run:

```bash
supabase functions new tokscript-ingestion-mcp
```

4. Replace the generated `index.ts` with the `index.ts` from this extension
5. Copy `deno.json` from this extension into the new function folder
6. Deploy:

```bash
supabase functions deploy tokscript-ingestion-mcp --no-verify-jwt
```

### 3. Authenticate with TokScript (one-time)

TokScript's OAuth server does not allow `supabase.co` redirect URIs during dynamic client registration. The included `bootstrap-oauth.ps1` script handles this by completing the OAuth flow locally (via `localhost`) and then pushing the resulting tokens directly to your deployed function.

Run the script from the extension folder:

```powershell
.\bootstrap-oauth.ps1 -MCP_ACCESS_KEY "<YOUR_MCP_ACCESS_KEY>"
```

The script will:
1. Register a new OAuth client with TokScript
2. Open your browser to the TokScript login page
3. Catch the callback on a local listener
4. Exchange the code for tokens
5. POST the tokens to your function via `?action=init_tokens`

Save the `Client ID` printed at the end — you will need it if you ever re-run setup.

> Tokens are refreshed automatically on every tool call — you will not need to repeat this step.

### 4. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this extension to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `TokScript Ingestion` |
| URL | Your **MCP Connection URL** from the credential tracker |

### 5. Test the Extension

Try these commands with Claude:

```
Save the transcript from this video: https://www.tiktok.com/@creator/video/...
```

```
Preview the transcript from this video without saving it: https://www.instagram.com/reel/...
```

```
Search my saved transcripts for videos about morning routines
```

```
List my saved transcripts
```

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Extension-specific issues:**

**"TokScript not authenticated" error**
- The `tokscript_tokens` table is empty — run `bootstrap-oauth.ps1` to complete authentication
- Verify the function deployed successfully: `GET .../tokscript-ingestion-mcp` should return `{ "status": "ok" }`

**Token refresh fails**
- Your TokScript subscription may have lapsed or the refresh token was revoked
- Re-run `bootstrap-oauth.ps1` to get fresh tokens

**"Daily extraction limit reached" error**
- TokScript's free plan allows **5 extractions per day**; the limit resets at midnight UTC
- Upgrade to Pro or Premium at [tokscript.com/pricing](https://tokscript.com/pricing) for unlimited extractions
- Photo carousel posts count as one extraction regardless of slide count

**Transcript returns empty or unexpected content**
- The video may have no captions or may be private
- Use `get_tokscript_transcript_preview` first to inspect the raw TokScript response before saving

**Photo carousel returns only one slide / no text extracted**
- TikTok's page HTML may be blocking the scrape (bot detection); the extension falls back to the thumbnail only
- Check `metadata.vision_extracted` — if `false`, TikTok blocked the page fetch; try again or save manually
- Ensure `OPENROUTER_API_KEY` is set as a Supabase secret (vision OCR uses OpenRouter → Gemini 2.0 Flash)

## Verification

After setup, run through these checks:

1. **Health check** — `GET https://<ref>.supabase.co/functions/v1/tokscript-ingestion-mcp` returns `{ "status": "ok", "service": "TokScript Ingestion MCP" }`
2. **Auth rejection** — Same URL without `?key=` returns `401`
3. **Save a transcript** — Ask your AI to run `save_tokscript_transcript` with a real video URL; confirm a row appears in the `tokscript_transcripts` table
4. **Dedup guard** — Save the same URL again; response should include `"already_exists": true`
5. **Semantic search** — Run `search_tokscript_transcripts` with a relevant query; confirm results are returned with similarity scores
6. **Token refresh** — Clear `access_token` in the `tokscript_tokens` row; the next tool call should auto-refresh and succeed
7. **Photo carousel vision** — Run `get_tokscript_transcript_preview` with a TikTok `/photo/` URL; response should include `"vision_extracted": true` and per-slide text
