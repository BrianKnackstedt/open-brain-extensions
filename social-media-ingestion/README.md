# Social Media Ingestion

## Why This Matters

You found a TikTok, Instagram Reel, YouTube video or Short, or hosted video with something worth remembering. A bookmark saves the location, but a transcript saves the idea. This extension connects Open Brain to social media transcription providers so your AI can reason over the actual content later.

## What It Does

Fetches and stores social media transcripts in dedicated Open Brain tables with semantic search support. Provider selection is automatic by default, and deployment-level preferences can override the built-in routing rules.

For YouTube, the extension now prefers TokScript first, then falls back to native caption tracks, and finally ElevenLabs. That keeps TokScript as the primary extractor while still preserving lower-cost and last-resort fallback paths.

**Provider selection:**

| URL type | Selected path |
|----------|---------------|
| TikTok photo carousel (`/photo/`) | TikTok slide scrape plus OpenRouter vision OCR first; TokScript if slide scraping returns no images |
| TikTok video | ElevenLabs Speech to Text `source_url` |
| YouTube Shorts / YouTube video | TokScript first; native YouTube captions if TokScript is unavailable or returns no usable transcript; ElevenLabs as final fallback |
| Instagram Reels | TokScript |
| Unknown hosted media URL | ElevenLabs Speech to Text `source_url` |

**Tables:**

- `social_media_transcripts` - Stores transcripts with embeddings, provider, platform, tags, metadata, language, and image URLs
- `social_media_provider_tokens` - Stores OAuth tokens for providers that need refresh, currently TokScript
- `social_media_oauth_state` - Ephemeral PKCE state during TokScript OAuth login
- `social_media_provider_preferences` - Stores deployment-level provider preferences that override default routing

When TokScript is attempted, the saved transcript metadata can include a `tokscript_debug` object with the tool name, normalized request arguments, outcome, and a truncated raw provider response or error payload to help diagnose fallback behavior later.

**MCP Tools:**

- `save_social_media_transcript` - Fetch and store a transcript from a supported social media URL
- `get_social_media_transcript_preview` - Fetch a transcript without saving it
- `search_social_media_transcripts` - Semantically search your saved transcript library
- `list_social_media_transcripts` - List saved transcripts, filterable by platform, provider, or content type
- `get_social_media_transcript_debug` - Inspect saved transcript metadata, including `tokscript_debug` payloads when present
- `set_default_provider_preference` - Save or update a deployment-level provider preference
- `list_default_provider_preferences` - List saved provider preferences in priority order
- `delete_default_provider_preference` - Remove a saved provider preference

For `search_social_media_transcripts` and `list_social_media_transcripts`, omit filter arguments or pass `all` to avoid filtering. `unknown` is treated as an exact stored metadata value, not a wildcard.

## Prerequisites

- Working Open Brain setup
- Supabase project configured
- Supabase CLI installed and linked to your project
- OpenRouter API key for embeddings and TikTok photo carousel vision OCR
- ElevenLabs API key for TikTok, hosted media, and final YouTube fallback transcription
- TokScript account for Instagram/Reels and YouTube fallback extraction when native captions are unavailable

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
SOCIAL MEDIA INGESTION -- CREDENTIAL TRACKER
---------------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________
  Project ref:           ____________

OPEN BRAIN / MCP
  MCP Access Key:        ____________
  MCP Connection URL:    ____________

OPENROUTER
  API Key:               ____________

ELEVENLABS
  API Key:               ____________

TOKSCRIPT
  Client ID:             ____________  (printed by bootstrap-oauth.ps1)

---------------------------------------------
```

## Steps

### 1. Set Up the Database Schema

Copy and paste the contents of `schema.sql` into your Supabase SQL Editor and click Run:

```text
https://supabase.com/dashboard/project/YOUR_PROJECT_REF/sql/new
```

This creates fresh `social_media_*` tables.

### 2. Deploy the MCP Server

1. Open a command prompt.
2. Browse to your Open Brain Supabase functions folder.
3. Run:

```bash
supabase functions new social-media-ingestion-mcp
```

4. Replace the generated `index.ts` with the `index.ts` from this extension.
5. Copy `deno.json` from this extension into the new function folder.
6. Deploy:

```bash
supabase functions deploy social-media-ingestion-mcp --no-verify-jwt
```

If you deploy under a different function name, set this secret so hosted OAuth redirects use the right path:

```bash
supabase secrets set SOCIAL_MEDIA_FUNCTION_NAME=<YOUR_FUNCTION_NAME>
```

### 3. Generate an ElevenLabs API Key

The extension uses ElevenLabs for automated TikTok and hosted media transcription, plus final YouTube fallback when native captions and TokScript do not produce a transcript.

1. Sign in to [ElevenLabs Developers](https://elevenlabs.io/app/developers/api-keys).
2. Create a new secret API key.
3. Name it something recognizable, such as `Open Brain Social Media Ingestion`.
4. If ElevenLabs offers endpoint or scope restrictions for the key, allow Speech to Text transcript creation. The extension only needs access to `POST /v1/speech-to-text` with `model_id=scribe_v2` and `source_url`.
5. If ElevenLabs offers a credit quota for the key, set a limit that fits your expected transcription usage.
6. Copy the key once and store it as `ELEVENLABS_API_KEY` in Supabase.

The key does not need Text to Speech, voice cloning, agents, dubbing, music, or other ElevenLabs product access for this extension. Do not use a single-use token; the Supabase function needs a normal secret API key sent in the `xi-api-key` header.

### 4. Set Required Secrets

From your linked Supabase project folder:

```bash
supabase secrets set ELEVENLABS_API_KEY=<YOUR_ELEVENLABS_API_KEY>
```

### 5. Authenticate with TokScript (one-time)

TokScript's OAuth server does not allow `supabase.co` redirect URIs during dynamic client registration. The included `bootstrap-oauth.ps1` script completes OAuth locally through `localhost`, then pushes the resulting tokens to your deployed function.

Run the script from this extension folder:

```powershell
.\bootstrap-oauth.ps1 -MCP_ACCESS_KEY "<YOUR_MCP_ACCESS_KEY>" -FunctionUrl "https://<PROJECT_REF>.supabase.co/functions/v1/social-media-ingestion-mcp"
```

The script will:

1. Register a new OAuth client with TokScript.
2. Open your browser to the TokScript login page.
3. Catch the callback on a local listener.
4. Exchange the code for tokens.
5. POST the tokens and client ID to your function via `?action=init_tokens`.

After the script finishes, also set the client ID as a Supabase secret:

```bash
supabase secrets set TOKSCRIPT_CLIENT_ID=<CLIENT_ID_PRINTED_BY_THE_SCRIPT>
```

TokScript tokens are refreshed automatically on provider calls.

### 6. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this extension to Claude Desktop, ChatGPT, Claude Code, or another MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `Social Media Ingestion` |
| URL | Your MCP Connection URL |

### 7. Test the Extension

Try these commands with your AI:

```text
Save the transcript from this video: https://www.tiktok.com/@creator/video/...
```

```text
Preview the transcript from this Reel without saving it: https://www.instagram.com/reel/...
```

```text
Search my saved social media transcripts for videos about morning routines
```

```text
List my saved social media transcripts
```

```text
Prefer TokScript for TikTok videos by default
```

```text
Prefer native YouTube captions for YouTube videos by default
```

Tool responses include `selected_provider` and `selection_reason` so you can see which automated path was used.

## Configuring Default Provider Preferences

Preferences are stored at the deployed MCP service level. This extension does not currently identify individual end users, so a saved preference applies to everyone using that deployment.

Use these prompts with your AI:

```text
Set the default provider preference for TikTok videos to TokScript
```

```text
Set the default provider preference for YouTube videos to native captions
```

```text
List my default provider preferences
```

```text
Delete the default provider preference for TikTok videos
```

Matching rules work like this:

- A preference can target a platform, a content type, or both.
- More specific matches win over broader matches.
- If specificity ties, the higher `priority` wins.
- If no saved preference matches, the built-in default routing rules are used.

## Troubleshooting

For common connection errors, 401s, and deployment problems, see [Common Troubleshooting](../../primitives/troubleshooting/).

**`ELEVENLABS_API_KEY is not configured`**

- Set `ELEVENLABS_API_KEY` as a Supabase secret.
- Redeploy or wait for the function runtime to pick up the new secret.

**ElevenLabs source URL fails**

- Confirm the URL is public and reachable.
- Try the same URL in ElevenLabs' Speech to Text UI.
- Check whether your ElevenLabs plan has enough Speech to Text credits.

**YouTube captions are not available**

- Some YouTube videos do not expose manual or auto-generated caption tracks.
- In that case the extension falls back to TokScript first, then ElevenLabs.
- If you want the cheapest path, prefer videos that already have YouTube captions enabled.

**`TokScript is not authenticated`**

- The `social_media_provider_tokens` table has no TokScript row.
- Run `bootstrap-oauth.ps1` to complete TokScript authentication.

**TokScript daily extraction limit reached**

- TokScript's free plan allows 5 extractions per day; the limit resets at midnight UTC.
- Upgrade to Pro or Premium at [tokscript.com/pricing](https://tokscript.com/pricing) for unlimited extractions.
- TikTok video URLs normally use ElevenLabs now; Instagram/Reels still use TokScript; YouTube only reaches TokScript after native captions fail.

**Schema rejects `youtube_captions` provider**

- Apply the latest `schema.sql` before deploying the updated function.
- Existing deployments need the provider check constraints refreshed so `youtube_captions` rows and preferences can be stored.

**TikTok photo carousel returns no slide text**

- TikTok may have blocked the page scrape.
- If slide scraping returns no images, the extension selects TokScript for fallback extraction.
- Ensure `OPENROUTER_API_KEY` is set, because vision OCR and embeddings use OpenRouter.

**Health check still shows the old service name**

- The old function deployment is still serving.
- Deploy the new function name or verify your MCP connector URL points at `social-media-ingestion-mcp`.

## Verification

After setup, run through these checks:

1. Health check returns `{ "status": "ok", "service": "Social Media Ingestion MCP" }`.
2. Auth rejection without `?key=` returns `401`.
3. `get_social_media_transcript_preview` with a TikTok video returns `selected_provider: "elevenlabs"`.
4. `get_social_media_transcript_preview` with a captioned YouTube URL returns `selected_provider: "youtube_captions"`.
5. `get_social_media_transcript_preview` with an Instagram Reel returns `selected_provider: "tokscript"`.
6. `save_social_media_transcript` inserts a row in `social_media_transcripts`.
7. Saving the same URL again returns `already_exists: true`.
8. `search_social_media_transcripts` returns semantic matches with similarity scores.
9. `list_social_media_transcripts` filters by platform, provider, and content type.
10. A TikTok `/photo/` URL stores `vision_extracted: true` when slide scraping succeeds.
11. `set_default_provider_preference` for TikTok video to TokScript changes `selected_provider` for a TikTok video preview.
12. `delete_default_provider_preference` removes the override and restores the built-in default selection.