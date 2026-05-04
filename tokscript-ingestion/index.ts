/**
 * Extension: TikTok Ingestion via TokScript MCP
 *
 * Fetches video transcripts from TikTok, Instagram Reels, and YouTube Shorts
 * via the TokScript MCP API, stores them in tokscript_transcripts, and exposes
 * semantic search over the stored library.
 *
 * Routes:
 *   GET  /oauth/start     — Begin TokScript OAuth flow (visit in browser once)
 *   GET  /oauth/callback  — OAuth redirect target; exchanges code for tokens
 *   POST /*               — MCP server endpoint (key-gated)
 *   GET  /*               — Health check
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKSCRIPT_MCP_URL = "https://api.tokscript.com/mcp";
const TOKSCRIPT_TOKEN_URL = "https://api.tokscript.com/api/connector/oauth/token";
const TOKSCRIPT_AUTH_URL = "https://api.tokscript.com/api/connector/oauth/authorize";
const TOKSCRIPT_REGISTER_URL = "https://api.tokscript.com/api/connector/oauth/register";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// ---------------------------------------------------------------------------
// Supabase client (module-level, reused across requests)
// ---------------------------------------------------------------------------

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------------------------------------------------------------------------
// Helpers: embeddings
// ---------------------------------------------------------------------------

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text.slice(0, 8000), // guard against oversized transcripts
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding failed (${r.status}): ${msg}`);
  }
  const json = await r.json();
  return json.data[0].embedding as number[];
}

// ---------------------------------------------------------------------------
// Helpers: vision description for photo posts (OpenRouter)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers: fetch all TikTok carousel slide URLs from the page HTML
// ---------------------------------------------------------------------------

async function fetchTikTokSlides(tiktokUrl: string): Promise<string[]> {
  // TikTok embeds all slide image URLs in __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON
  const r = await fetch(tiktokUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!r.ok) return [];

  const html = await r.text();

  // Extract the rehydration JSON blob
  const match = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  try {
    const data = JSON.parse(match[1]);
    const urls: string[] = [];
    const walk = (obj: unknown) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      const o = obj as Record<string, unknown>;
      if (Array.isArray(o.images)) {
        for (const img of o.images as Record<string, unknown>[]) {
          const urlStr = (img?.imageURL as Record<string, unknown>)?.urlList?.[0] ?? img?.url ?? img?.downloadURL;
          if (typeof urlStr === "string") urls.push(urlStr);
        }
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(data);
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers: vision description for photo posts (OpenRouter)
// ---------------------------------------------------------------------------

async function visionDescribeImages(imageUrls: string[], isPhotoPost = false): Promise<string> {
  const introText = isPhotoPost
    ? `These are all ${imageUrls.length} slide(s) from a TikTok photo carousel post. For each slide: (1) extract ALL visible text exactly as written, (2) describe any diagrams, code, screenshots, or visual content, (3) summarize the key point. Label each as Slide 1, Slide 2, etc. Then provide a brief overall summary.`
    : "These are images from a social media post. Please describe what you see in each image in detail, extract any visible text exactly as written, and summarize the key information conveyed. Label each image as Image 1, Image 2, etc.";

  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: introText },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content }],
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Vision description failed (${r.status}): ${msg}`);
  }

  const json = await r.json();
  return (json.choices?.[0]?.message?.content as string) ?? "";
}

// ---------------------------------------------------------------------------
// Helpers: PKCE
// ---------------------------------------------------------------------------

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64urlEncode(verifierBytes.buffer);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64urlEncode(challengeBytes);
  return { verifier, challenge };
}

function generateState(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

// ---------------------------------------------------------------------------
// Helpers: TokScript OAuth token management
// ---------------------------------------------------------------------------

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

async function getValidAccessToken(): Promise<string> {
  const { data, error } = await supabase
    .from("tokscript_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("id", 1)
    .single();

  if (error || !data) {
    throw new Error(
      "TokScript not authenticated. Visit /oauth/start to connect your account.",
    );
  }

  const row = data as TokenRow;
  const expiresAt = new Date(row.expires_at);
  const now = new Date();

  // Refresh if expiry is within 5 minutes
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const clientId = Deno.env.get("TOKSCRIPT_CLIENT_ID");
    if (!clientId) throw new Error("TOKSCRIPT_CLIENT_ID not configured.");

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: clientId,
    });

    const r = await fetch(TOKSCRIPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new Error(`Token refresh failed (${r.status}): ${msg}`);
    }

    const tokens = await r.json();
    const newExpiry = new Date(
      Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ).toISOString();

    await supabase.from("tokscript_tokens").upsert({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? row.refresh_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    });

    return tokens.access_token as string;
  }

  return row.access_token;
}

// ---------------------------------------------------------------------------
// Helpers: TokScript MCP caller
// ---------------------------------------------------------------------------

interface TokScriptTranscript {
  url: string;
  platform: string;
  title?: string;
  author?: string;
  duration?: number;
  transcript: string;
  imageUrls?: string[];
}

async function callTokScript(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const token = await getValidAccessToken();

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const r = await fetch(TOKSCRIPT_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`TokScript MCP error (${r.status}): ${msg}`);
  }

  const contentType = r.headers.get("content-type") ?? "";

  // Handle SSE responses (TokScript may stream)
  if (contentType.includes("text/event-stream")) {
    const text = await r.text();
    // Extract last complete JSON result line
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i].slice(6));
        if (parsed.result) return parsed.result;
      } catch {
        // continue
      }
    }
    throw new Error("No parseable result in TokScript SSE response.");
  }

  const json = await r.json();
  if (json.error) {
    throw new Error(`TokScript tool error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

function extractTranscriptFromResult(
  result: unknown,
  url: string,
): TokScriptTranscript {
  // TokScript returns { content: [{ type: "text", text: "..." }] }
  const res = result as { content?: Array<{ type: string; text: string }> };
  const text = res?.content?.[0]?.text ?? JSON.stringify(result);

  // Try to parse structured JSON from the text content
  try {
    const parsed = JSON.parse(text);
    // Collect image URLs — include thumbnail so photo posts always have at least the cover slide
    const imageUrls: string[] = [
      ...(parsed.images ?? []),
      ...(parsed.image_urls ?? []),
      ...(parsed.photos ?? []),
    ].filter((u: unknown) => typeof u === "string");
    if (parsed.thumbnail && typeof parsed.thumbnail === "string") {
      imageUrls.push(parsed.thumbnail);
    }

    return {
      url,
      platform: detectPlatform(url),
      title: parsed.title ?? parsed.video_title ?? null,
      author: parsed.author ?? parsed.username ?? null,
      duration: parsed.duration ?? null,
      transcript: parsed.transcript ?? parsed.text ?? text,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };
  } catch {
    return {
      url,
      platform: detectPlatform(url),
      transcript: text,
    };
  }
}

function detectPlatform(url: string): string {
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  return "tiktok";
}

// ---------------------------------------------------------------------------
// Helpers: content fingerprint (SHA-256 of URL)
// ---------------------------------------------------------------------------

async function fingerprintUrl(url: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

// Redirect URI uses a /callback path suffix — TokScript rejects both query params and bare URLs.
// Supabase routes /functions/v1/tokscript-ingestion-mcp/* to the same function, so the path is reachable.
const FUNCTION_BASE_URL =
  `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/tokscript-ingestion-mcp`;
const OAUTH_REDIRECT_URI = `${FUNCTION_BASE_URL}/callback`;

// ---------------------------------------------------------------------------
// OAuth + health check (GET)
//
//   ?action=oauth_start&key=  — begin OAuth flow (key-gated)
//   path ends /callback       — TokScript callback (receives ?code=&state=)
//   (neither)                 — health check
// ---------------------------------------------------------------------------

app.get("*", async (c) => {
  const action = c.req.query("action");
  const isCallback = c.req.path.endsWith("/callback");
  const hasCode = !!c.req.query("code");
  const hasState = !!c.req.query("state");

  // ------------------------------------------------------------------
  // OAuth start: ?action=oauth_start&key=<MCP_ACCESS_KEY>
  // ------------------------------------------------------------------
  if (action === "oauth_start") {
    const key = c.req.query("key") || c.req.header("x-access-key");
    const expected = Deno.env.get("MCP_ACCESS_KEY");
    if (!key || key !== expected) return c.json({ error: "Unauthorized" }, 401);

    const redirectUri = OAUTH_REDIRECT_URI;

    // Dynamic client registration if no client_id yet
    let clientId = Deno.env.get("TOKSCRIPT_CLIENT_ID");
    if (!clientId) {
      const regRes = await fetch(TOKSCRIPT_REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Open Brain TikTok Ingestion",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        }),
      });

      if (!regRes.ok) {
        const msg = await regRes.text().catch(() => "");
        return c.json({ error: `Client registration failed: ${msg}` }, 500);
      }

      const reg = await regRes.json();
      clientId = reg.client_id as string;

      return c.json({
        action_required: true,
        message: "Client registered. Add the client_id as a Supabase secret, then visit the oauth_start URL again.",
        client_id: clientId,
        command: `supabase secrets set TOKSCRIPT_CLIENT_ID=${clientId}`,
      });
    }

    const { verifier, challenge } = await generatePKCE();
    const state = generateState();

    await supabase.from("tokscript_oauth_state").insert({
      state,
      code_verifier: verifier,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp:access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    return Response.redirect(`${TOKSCRIPT_AUTH_URL}?${params.toString()}`);
  }

  // ------------------------------------------------------------------
  // OAuth callback: TokScript redirects to /callback?code=...&state=...
  // ------------------------------------------------------------------
  if (isCallback && hasCode && hasState) {
    const code = c.req.query("code")!;
    const state = c.req.query("state")!

    const { data: stateRow, error: stateErr } = await supabase
      .from("tokscript_oauth_state")
      .select("code_verifier, created_at")
      .eq("state", state)
      .single();

    if (stateErr || !stateRow) {
      return c.json({ error: "Invalid or expired OAuth state." }, 400);
    }

    const age = Date.now() - new Date(stateRow.created_at).getTime();
    if (age > 10 * 60 * 1000) {
      await supabase.from("tokscript_oauth_state").delete().eq("state", state);
      return c.json({ error: "OAuth state expired. Please start the flow again." }, 400);
    }

    const clientId = Deno.env.get("TOKSCRIPT_CLIENT_ID");
    if (!clientId) return c.json({ error: "TOKSCRIPT_CLIENT_ID not configured." }, 500);

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: clientId,
      code_verifier: stateRow.code_verifier,
    });

    const tokenRes = await fetch(TOKSCRIPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const msg = await tokenRes.text().catch(() => "");
      return c.json({ error: `Token exchange failed: ${msg}` }, 500);
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(
      Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ).toISOString();

    await supabase.from("tokscript_tokens").upsert({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    await supabase.from("tokscript_oauth_state").delete().eq("state", state);

    return c.json({
      success: true,
      message: "TokScript connected successfully. You can now use save_tokscript_transcript in your AI.",
    });
  }

  // Health check (no action)
  return c.json({ status: "ok", service: "TokScript Ingestion MCP", version: "1.0.0" });
});

// ---------------------------------------------------------------------------
// MCP server (POST)
// ---------------------------------------------------------------------------

app.post("*", async (c) => {
  // Claude Desktop connectors don't always send the Accept header
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const key = c.req.query("key") || c.req.header("x-access-key");
  const expected = Deno.env.get("MCP_ACCESS_KEY");
  if (!key || key !== expected) return c.json({ error: "Unauthorized" }, 401);

  // ------------------------------------------------------------------
  // Token bootstrap: POST ?action=init_tokens  { access_token, refresh_token, expires_in }
  // Called by bootstrap-oauth.ps1 after completing the local OAuth flow.
  // ------------------------------------------------------------------
  if (c.req.query("action") === "init_tokens") {
    const body = await c.req.json().catch(() => null);
    if (!body?.access_token || !body?.refresh_token) {
      return c.json({ error: "access_token and refresh_token are required" }, 400);
    }
    const expiresAt = new Date(
      Date.now() + (body.expires_in ?? 3600) * 1000,
    ).toISOString();
    const { error: upsertErr } = await supabase.from("tokscript_tokens").upsert({
      id: 1,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });
    if (upsertErr) return c.json({ error: upsertErr.message }, 500);
    return c.json({ success: true, message: "TokScript tokens stored. You can now use the MCP tools." });
  }

  const server = new McpServer({ name: "tokscript-ingestion", version: "1.0.0" });

  // ------------------------------------------------------------------
  // Tool: save_tokscript_transcript
  // ------------------------------------------------------------------
  server.tool(
    "save_tokscript_transcript",
    "Fetch the transcript for a TikTok, Instagram Reel, or YouTube Shorts video via TokScript and save it to Open Brain.",
    {
      url: z.string().url().describe("Full video URL (TikTok, Instagram Reel, or YouTube Shorts)"),
      tags: z.array(z.string()).optional().describe("Optional tags to attach to the transcript"),
    },
    async ({ url, tags }) => {
      try {
        const fingerprint = await fingerprintUrl(url);

        // Dedup: return existing record if already saved
        const { data: existing } = await supabase
          .from("tokscript_transcripts")
          .select("id, title, author, created_at")
          .eq("content_fingerprint", fingerprint)
          .single();

        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                already_exists: true,
                message: "Transcript already saved.",
                record: existing,
              }, null, 2),
            }],
          };
        }

        // Fetch from TokScript
        const result = await callTokScript("get_tiktok_transcript", { video_url: url });
        const ts = extractTranscriptFromResult(result, url);

        // Vision for photo posts — scrape all slides from TikTok page first, fall back to TokScript thumbnail
        const isPhotoPost = url.includes("/photo/");
        let finalTranscript = ts.transcript;
        let visionUsed = false;
        if (isPhotoPost || (!ts.transcript || ts.transcript.trim().length < 50)) {
          let imageUrls = isPhotoPost ? await fetchTikTokSlides(url) : [];
          if (imageUrls.length === 0) imageUrls = ts.imageUrls ?? [];
          if (imageUrls.length > 0) {
            finalTranscript = await visionDescribeImages(imageUrls, isPhotoPost);
            visionUsed = true;
          }
        }

        // Generate embedding
        const embedding = await getEmbedding(finalTranscript);

        const { data, error } = await supabase
          .from("tokscript_transcripts")
          .insert({
            url: ts.url,
            platform: ts.platform,
            title: ts.title ?? null,
            author: ts.author ?? null,
            duration: ts.duration ?? null,
            transcript: finalTranscript,
            embedding,
            tags: tags ?? [],
            metadata: visionUsed ? { vision_extracted: true, image_count: ts.imageUrls?.length } : {},
            content_fingerprint: fingerprint,
          })
          .select("id, url, platform, title, author, created_at")
          .single();

        if (error) throw new Error(`DB insert failed: ${error.message}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "Transcript saved to Open Brain.",
              record: data,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // Tool: get_tokscript_transcript_preview
  // ------------------------------------------------------------------
  server.tool(
    "get_tokscript_transcript_preview",
    "Fetch the transcript for a TikTok, Instagram Reel, or YouTube Shorts video without saving it.",
    {
      url: z.string().url().describe("Full video URL"),
    },
    async ({ url }) => {
      try {
        const result = await callTokScript("get_tiktok_transcript", { video_url: url });
        const ts = extractTranscriptFromResult(result, url);

        // Vision for photo posts — scrape all slides from TikTok page first, fall back to TokScript thumbnail
        const isPhotoPost = url.includes("/photo/");
        let finalTranscript = ts.transcript;
        let visionUsed = false;
        if (isPhotoPost || (!ts.transcript || ts.transcript.trim().length < 50)) {
          let imageUrls = isPhotoPost ? await fetchTikTokSlides(url) : [];
          if (imageUrls.length === 0) imageUrls = ts.imageUrls ?? [];
          if (imageUrls.length > 0) {
            finalTranscript = await visionDescribeImages(imageUrls, isPhotoPost);
            visionUsed = true;
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              platform: ts.platform,
              title: ts.title,
              author: ts.author,
              duration: ts.duration,
              transcript: finalTranscript,
              vision_extracted: visionUsed,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // Tool: search_tokscript_transcripts
  // ------------------------------------------------------------------
  server.tool(
    "search_tokscript_transcripts",
    "Semantically search saved TikTok/Instagram/YouTube transcripts in Open Brain.",
    {
      query: z.string().describe("Search query — what the transcript should be about"),
      limit: z.number().min(1).max(50).optional().default(10).describe("Max results to return"),
      threshold: z.number().min(0).max(1).optional().default(0.5).describe("Minimum similarity score (0–1)"),
      platform: z.enum(["tiktok", "instagram", "youtube"]).optional().describe("Filter by platform"),
    },
    async ({ query, limit, threshold, platform }) => {
      try {
        const embedding = await getEmbedding(query);

        const filter = platform ? { platform } : {};
        const { data, error } = await supabase.rpc("match_tokscript_transcripts", {
          query_embedding: embedding,
          match_threshold: threshold,
          match_count: limit,
          filter,
        });

        if (error) throw new Error(`Search failed: ${error.message}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              count: data.length,
              results: data,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // Tool: list_tokscript_transcripts
  // ------------------------------------------------------------------
  server.tool(
    "list_tokscript_transcripts",
    "List saved transcripts in Open Brain, optionally filtered by platform.",
    {
      platform: z.enum(["tiktok", "instagram", "youtube"]).optional().describe("Filter by platform"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max records to return"),
    },
    async ({ platform, limit }) => {
      try {
        let query = supabase
          .from("tokscript_transcripts")
          .select("id, url, platform, title, author, duration, tags, created_at")
          .order("created_at", { ascending: false })
          .limit(limit ?? 20);

        if (platform) {
          query = query.eq("platform", platform);
        }

        const { data, error } = await query;
        if (error) throw new Error(`List failed: ${error.message}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              count: data.length,
              transcripts: data,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
