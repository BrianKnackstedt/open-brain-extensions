/**
 * Extension: Social Media Ingestion for Open Brain
 *
 * Fetches transcripts from social media URLs, stores them in generic
 * social_media_transcripts tables, and exposes semantic search over the saved
 * library. Provider selection is automatic.
 */

import "@supabase/functions-js/edge-runtime";

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const TOKSCRIPT_MCP_URL = "https://api.tokscript.com/mcp";
const TOKSCRIPT_TOKEN_URL =
  "https://api.tokscript.com/api/connector/oauth/token";
const TOKSCRIPT_AUTH_URL =
  "https://api.tokscript.com/api/connector/oauth/authorize";
const TOKSCRIPT_REGISTER_URL =
  "https://api.tokscript.com/api/connector/oauth/register";
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_FUNCTION_NAME = "social-media-ingestion-mcp";

const PROVIDER_IDS = [
  "tokscript",
  "elevenlabs",
  "openrouter_vision",
  "youtube_captions",
] as const;
const PLATFORM_IDS = ["tiktok", "instagram", "youtube", "unknown"] as const;
const CONTENT_TYPES = ["video", "photo_carousel", "unknown"] as const;

type ProviderId = typeof PROVIDER_IDS[number];
type Platform = typeof PLATFORM_IDS[number];
type ContentType = typeof CONTENT_TYPES[number];
type JsonObject = Record<string, unknown>;

const DEBUG_MAX_STRING_LENGTH = 2000;
const DEBUG_MAX_ARRAY_ITEMS = 20;
const DEBUG_MAX_OBJECT_KEYS = 40;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface TikTokPageData {
  imageUrls: string[];
  title?: string;
  author?: string;
}

interface ProviderTokenRow {
  access_token: string;
  refresh_token: string;
  client_id: string | null;
  expires_at: string;
}

interface SocialMediaTranscript {
  url: string;
  platform: Platform;
  provider: ProviderId;
  contentType: ContentType;
  title?: string | null;
  author?: string | null;
  duration?: number | null;
  transcript: string;
  imageUrls?: string[];
  language?: string | null;
  metadata?: JsonObject;
}

interface ProviderSelection {
  provider: ProviderId;
  platform: Platform;
  contentType: ContentType;
  reason: string;
}

interface ProviderSelectionContext {
  platform: Platform;
  contentType: ContentType;
}

interface ProviderSelectionRule {
  matches: (context: ProviderSelectionContext) => boolean;
  provider: ProviderId;
  reason: string;
}

interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
}

interface ProviderPreference {
  id: string;
  platform: Platform | null;
  contentType: ContentType | null;
  provider: ProviderId;
  priority: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedTranscript {
  transcript: SocialMediaTranscript;
  selectedProvider: ProviderId;
  selectionReason: string;
  visionUsed: boolean;
  visionImageUrls: string[];
  debugMetadata?: JsonObject;
}

interface TokScriptCallResult {
  result: unknown;
  debugMetadata: JsonObject;
}

class ProviderError extends Error {
  provider: ProviderId;
  code: string;
  isWarning: boolean;
  details?: JsonObject;

  constructor(
    provider: ProviderId,
    message: string,
    code: string,
    isWarning = false,
    details?: JsonObject,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.isWarning = isWarning;
    this.details = details;
  }
}

async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new ProviderError(
      "openrouter_vision",
      "OPENROUTER_API_KEY is required for embeddings.",
      "provider_unavailable",
    );
  }

  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding failed (${r.status}): ${msg}`);
  }

  const json = await r.json();
  return json.data[0].embedding as number[];
}

function firstStringValue(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function detectPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("instagram.com")) return "instagram";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    return "youtube";
  }
  return "unknown";
}

function detectContentType(
  url: string,
  platform = detectPlatform(url),
): ContentType {
  const lower = url.toLowerCase();
  if (platform === "tiktok" && lower.includes("/photo/")) {
    return "photo_carousel";
  }
  if (platform === "unknown") return "unknown";
  return "video";
}

const DEFAULT_PROVIDER_RULES: ProviderSelectionRule[] = [
  {
    matches: ({ platform, contentType }) =>
      platform === "tiktok" && contentType === "photo_carousel",
    provider: "openrouter_vision",
    reason:
      "TikTok photo carousels use slide scraping plus OpenRouter vision OCR first.",
  },
  {
    matches: ({ platform }) => platform === "instagram",
    provider: "tokscript",
    reason:
      "Instagram/Reels URLs use TokScript until ElevenLabs social URL coverage is verified.",
  },
  {
    matches: ({ platform }) => platform === "youtube",
    provider: "tokscript",
    reason:
      "YouTube URLs prefer TokScript first, then native caption tracks, then ElevenLabs.",
  },
  {
    matches: ({ platform }) => platform === "tiktok",
    provider: "elevenlabs",
    reason:
      "TikTok video URLs use ElevenLabs Speech to Text source_url transcription.",
  },
  {
    matches: () => true,
    provider: "elevenlabs",
    reason:
      "Unknown hosted media URLs use ElevenLabs source_url transcription.",
  },
];

function mapProviderPreference(row: {
  id: string;
  platform: Platform | null;
  content_type: ContentType | null;
  provider: ProviderId;
  priority: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}): ProviderPreference {
  return {
    id: row.id,
    platform: row.platform,
    contentType: row.content_type,
    provider: row.provider,
    priority: row.priority,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatPreferenceScope(preference: {
  platform: Platform | null;
  contentType: ContentType | null;
}): string {
  const parts: string[] = [];

  if (preference.platform) parts.push(`platform ${preference.platform}`);
  if (preference.contentType) {
    parts.push(`content type ${preference.contentType}`);
  }

  if (parts.length === 0) return "all supported URLs";
  return parts.join(" and ");
}

function buildPreferenceSelectionReason(preference: ProviderPreference): string {
  if (preference.reason?.trim()) return preference.reason.trim();
  return `Configured default provider preference matched ${formatPreferenceScope(preference)}.`;
}

function matchesProviderPreference(
  preference: ProviderPreference,
  context: ProviderSelectionContext,
): boolean {
  const platformMatches = !preference.platform ||
    preference.platform === context.platform;
  const contentTypeMatches = !preference.contentType ||
    preference.contentType === context.contentType;
  return platformMatches && contentTypeMatches;
}

function providerPreferenceSpecificity(preference: ProviderPreference): number {
  return Number(!!preference.platform) + Number(!!preference.contentType);
}

async function listProviderPreferences(): Promise<ProviderPreference[]> {
  const { data, error } = await supabase
    .from("social_media_provider_preferences")
    .select(
      "id, platform, content_type, provider, priority, reason, created_at, updated_at",
    )
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Provider preference list failed: ${error.message}`);
  }

  return (data ?? []).map((row) =>
    mapProviderPreference(row as {
      id: string;
      platform: Platform | null;
      content_type: ContentType | null;
      provider: ProviderId;
      priority: number;
      reason: string | null;
      created_at: string;
      updated_at: string;
    })
  );
}

async function getExactProviderPreference(
  platform: Platform | null,
  contentType: ContentType | null,
): Promise<ProviderPreference | null> {
  let query = supabase
    .from("social_media_provider_preferences")
    .select(
      "id, platform, content_type, provider, priority, reason, created_at, updated_at",
    );

  query = platform ? query.eq("platform", platform) : query.is("platform", null);
  query = contentType
    ? query.eq("content_type", contentType)
    : query.is("content_type", null);

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Provider preference lookup failed: ${error.message}`);
  }

  if (!data) return null;
  return mapProviderPreference(data as {
    id: string;
    platform: Platform | null;
    content_type: ContentType | null;
    provider: ProviderId;
    priority: number;
    reason: string | null;
    created_at: string;
    updated_at: string;
  });
}

async function findProviderPreference(
  context: ProviderSelectionContext,
): Promise<ProviderPreference | undefined> {
  const preferences = await listProviderPreferences();
  return preferences
    .filter((preference) => matchesProviderPreference(preference, context))
    .sort((left, right) => {
      const specificityDelta = providerPreferenceSpecificity(right) -
        providerPreferenceSpecificity(left);
      if (specificityDelta !== 0) return specificityDelta;

      const priorityDelta = right.priority - left.priority;
      if (priorityDelta !== 0) return priorityDelta;

      return right.updatedAt.localeCompare(left.updatedAt);
    })[0];
}

function selectDefaultProvider(
  context: ProviderSelectionContext,
): ProviderSelection {
  const match = DEFAULT_PROVIDER_RULES.find((rule) => rule.matches(context));

  if (!match) {
    throw new Error("No default provider rule matched the requested URL.");
  }

  return {
    provider: match.provider,
    platform: context.platform,
    contentType: context.contentType,
    reason: match.reason,
  };
}

async function selectProvider(url: string): Promise<ProviderSelection> {
  const platform = detectPlatform(url);
  const contentType = detectContentType(url, platform);
  const context: ProviderSelectionContext = { platform, contentType };
  const preferred = await findProviderPreference(context);

  if (preferred) {
    return {
      provider: preferred.provider,
      platform,
      contentType,
      reason: buildPreferenceSelectionReason(preferred),
    };
  }

  return selectDefaultProvider(context);
}

function responseJson(payload: JsonObject) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function responseError(err: unknown, fallbackProvider?: ProviderId) {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ProviderError) {
    const payload: JsonObject = {
      success: false,
      provider: err.provider,
      code: err.code,
    };
    payload[err.isWarning ? "warning" : "error"] = msg;
    if (err.isWarning) return responseJson(payload);
    return { ...responseJson(payload), isError: true };
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        provider: fallbackProvider,
        error: msg,
      }),
    }],
    isError: true,
  };
}

function getProviderWarning(
  payload: unknown,
  fallbackText?: string,
): string | null {
  const candidates: string[] = [];

  if (typeof fallbackText === "string" && fallbackText.trim()) {
    candidates.push(fallbackText.trim());
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const directMessage = firstNonEmptyString(
      record.error,
      record.message,
      record.detail,
      record.warning,
    );
    if (directMessage) candidates.unshift(directMessage);

    const nestedError = record.error;
    if (nestedError && typeof nestedError === "object") {
      const nestedRecord = nestedError as Record<string, unknown>;
      const nestedMessage = firstNonEmptyString(
        nestedRecord.message,
        nestedRecord.detail,
        nestedRecord.error,
      );
      if (nestedMessage) candidates.unshift(nestedMessage);
    }
  }

  for (const candidate of candidates) {
    if (
      /(daily extraction limit reached|rate limit|too many requests|quota|credits?.*(exhausted|depleted|used)|limit.*reached|usage.*limit|allowance.*reached)/i
        .test(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function isProviderLimitWarning(error: unknown): boolean {
  return error instanceof ProviderError && error.code === "provider_limit";
}

function truncateDebugString(value: string): string {
  if (value.length <= DEBUG_MAX_STRING_LENGTH) return value;
  return `${value.slice(0, DEBUG_MAX_STRING_LENGTH)}...[truncated]`;
}

function normalizeDebugValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "string") return truncateDebugString(value);

  if (depth >= 4) return truncateDebugString(JSON.stringify(value));

  if (Array.isArray(value)) {
    return value.slice(0, DEBUG_MAX_ARRAY_ITEMS).map((item) =>
      normalizeDebugValue(item, depth + 1)
    );
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, DEBUG_MAX_OBJECT_KEYS)
        .map(([key, nestedValue]) => [key, normalizeDebugValue(nestedValue, depth + 1)]),
    );
  }

  return truncateDebugString(String(value));
}

function buildTokScriptDebugMetadata(
  toolName: string,
  args: Record<string, unknown>,
  outcome: "success" | "warning" | "error",
  rawResponse?: unknown,
  error?: unknown,
): JsonObject {
  const debug: JsonObject = {
    tool: toolName,
    args: normalizeDebugValue(args),
    outcome,
    captured_at: new Date().toISOString(),
  };

  if (rawResponse !== undefined) {
    debug.raw_response = normalizeDebugValue(rawResponse);
  }

  if (error !== undefined) {
    debug.error = normalizeDebugValue(
      error instanceof Error ? error.message : error,
    );
  }

  return debug;
}

function getProviderDebugMetadata(error: unknown): JsonObject | undefined {
  if (!(error instanceof ProviderError) || !error.details) return undefined;
  return error.details;
}

function mergeDebugMetadata(
  base?: JsonObject,
  extra?: JsonObject,
): JsonObject | undefined {
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };
}

async function fetchTikTokPageData(tiktokUrl: string): Promise<TikTokPageData> {
  const r = await fetch(tiktokUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!r.ok) return { imageUrls: [] };

  const html = await r.text();
  const match = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return { imageUrls: [] };

  try {
    const data = JSON.parse(match[1]);
    const urls: string[] = [];
    let title: string | undefined;
    let author: string | undefined;

    const walk = (obj: unknown) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach(walk);
        return;
      }

      const record = obj as Record<string, unknown>;
      if (!title) {
        const candidate = firstStringValue(record, [
          "desc",
          "description",
          "title",
          "video_title",
        ]);
        if (candidate && !candidate.startsWith("http")) title = candidate;
      }
      if (!author) {
        author = firstStringValue(record.author, [
          "uniqueId",
          "username",
          "nickname",
          "name",
        ]) ??
          firstStringValue(record, ["uniqueId", "username", "authorName"]) ??
          (typeof record.author === "string" ? record.author : undefined);
      }
      if (Array.isArray(record.images)) {
        for (const img of record.images as Record<string, unknown>[]) {
          const imageUrl = img?.imageURL as { urlList?: unknown[] } | undefined;
          const urlStr = imageUrl?.urlList?.find((value) =>
            typeof value === "string"
          ) ??
            img?.url ??
            img?.downloadURL;
          if (typeof urlStr === "string") urls.push(urlStr);
        }
      }
      for (const value of Object.values(record)) walk(value);
    };

    walk(data);
    return { imageUrls: [...new Set(urls)], title, author };
  } catch {
    return { imageUrls: [] };
  }
}

async function visionDescribeImages(
  imageUrls: string[],
  isPhotoPost = false,
): Promise<string> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new ProviderError(
      "openrouter_vision",
      "OPENROUTER_API_KEY is required for TikTok photo carousel vision extraction.",
      "provider_unavailable",
    );
  }

  const introText = isPhotoPost
    ? `These are all ${imageUrls.length} slide(s) from a TikTok photo carousel post. For each slide: (1) extract ALL visible text exactly as written, (2) describe any diagrams, code, screenshots, or visual content, (3) summarize the key point. Label each as Slide 1, Slide 2, etc. Then provide a brief overall summary.`
    : "These are images from a social media post. Please describe what you see in each image in detail, extract any visible text exactly as written, and summarize the key information conveyed. Label each image as Image 1, Image 2, etc.";

  const content: Array<
    { type: string; text?: string; image_url?: { url: string } }
  > = [
    { type: "text", text: introText },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content }],
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new ProviderError(
      "openrouter_vision",
      `Vision extraction failed (${r.status}): ${msg}`,
      "provider_request_failed",
    );
  }

  const json = await r.json();
  return (json.choices?.[0]?.message?.content as string) ?? "";
}

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<
  { verifier: string; challenge: string }
> {
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

async function getValidTokScriptAccessToken(): Promise<string> {
  const { data, error } = await supabase
    .from("social_media_provider_tokens")
    .select("access_token, refresh_token, client_id, expires_at")
    .eq("provider_id", "tokscript")
    .single();

  if (error || !data) {
    throw new ProviderError(
      "tokscript",
      "TokScript is not authenticated. Run bootstrap-oauth.ps1 to connect TokScript.",
      "provider_auth",
    );
  }

  const row = data as ProviderTokenRow;
  const expiresAt = new Date(row.expires_at);
  const now = new Date();

  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const clientId = row.client_id ?? Deno.env.get("TOKSCRIPT_CLIENT_ID") ??
      null;
    if (!clientId) {
      throw new ProviderError(
        "tokscript",
        "TOKSCRIPT_CLIENT_ID is not configured.",
        "provider_auth",
      );
    }

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
      throw new ProviderError(
        "tokscript",
        `Token refresh failed (${r.status}): ${msg}`,
        "provider_auth",
      );
    }

    const tokens = await r.json();
    const newExpiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)
      .toISOString();

    await supabase.from("social_media_provider_tokens").upsert({
      provider_id: "tokscript",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? row.refresh_token,
      client_id: clientId,
      expires_at: newExpiry,
      metadata: { auth_type: "oauth_pkce" },
      updated_at: new Date().toISOString(),
    });

    return tokens.access_token as string;
  }

  return row.access_token;
}

async function callTokScript(
  toolName: string,
  args: Record<string, unknown>,
): Promise<TokScriptCallResult> {
  const token = await getValidTokScriptAccessToken();
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
    throw new ProviderError(
      "tokscript",
      `TokScript MCP error (${r.status}): ${msg}`,
      "provider_request_failed",
      false,
      {
        tokscript_debug: buildTokScriptDebugMetadata(
          toolName,
          args,
          "error",
          { status: r.status, body: msg },
        ),
      },
    );
  }

  const contentType = r.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await r.text();
    const lines = text.split("\n").filter((line) => line.startsWith("data: "));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i].slice(6));
        if (parsed.result) {
          return {
            result: parsed.result,
            debugMetadata: {
              tokscript_debug: buildTokScriptDebugMetadata(
                toolName,
                args,
                "success",
                parsed.result,
              ),
            },
          };
        }
      } catch {
        // Continue looking for a parseable result.
      }
    }
    throw new ProviderError(
      "tokscript",
      "No parseable result in TokScript SSE response.",
      "provider_response_invalid",
      false,
      {
        tokscript_debug: buildTokScriptDebugMetadata(
          toolName,
          args,
          "error",
          text,
        ),
      },
    );
  }

  const json = await r.json();
  if (json.error) {
    const warning = getProviderWarning(json.error, JSON.stringify(json.error));
    if (warning) {
      throw new ProviderError(
        "tokscript",
        warning,
        "provider_limit",
        true,
        {
          tokscript_debug: buildTokScriptDebugMetadata(
            toolName,
            args,
            "warning",
            json,
            warning,
          ),
        },
      );
    }
    throw new ProviderError(
      "tokscript",
      `TokScript tool error: ${JSON.stringify(json.error)}`,
      "provider_request_failed",
      false,
      {
        tokscript_debug: buildTokScriptDebugMetadata(
          toolName,
          args,
          "error",
          json,
        ),
      },
    );
  }
  return {
    result: json.result,
    debugMetadata: {
      tokscript_debug: buildTokScriptDebugMetadata(
        toolName,
        args,
        "success",
        json.result,
      ),
    },
  };
}

async function loadTokScriptTranscript(
  url: string,
  platform: Platform,
  contentType: ContentType,
): Promise<SocialMediaTranscript> {
  const toolName = platform === "youtube"
    ? "get_youtube_transcript"
    : "get_tiktok_transcript";
  const tokScriptCall = await callTokScript(toolName, {
    video_url: url,
  });
  return extractTokScriptTranscript(
    tokScriptCall.result,
    url,
    platform,
    contentType,
    toolName,
    tokScriptCall.debugMetadata,
  );
}

function extractTokScriptTranscript(
  result: unknown,
  url: string,
  platform: Platform,
  contentType: ContentType,
  toolName: string,
  debugMetadata?: JsonObject,
): SocialMediaTranscript {
  const res = result as { content?: Array<{ type: string; text: string }> };
  const text = res?.content?.[0]?.text ?? JSON.stringify(result);

  try {
    const parsed = JSON.parse(text);
    const warning = getProviderWarning(parsed, text);
    if (warning) {
      throw new ProviderError("tokscript", warning, "provider_limit", true);
    }

    const transcript = firstNonEmptyString(parsed.transcript, parsed.text);
    if (!transcript) {
      throw new ProviderError(
        "tokscript",
        "TokScript did not return transcript content for this URL.",
        "provider_empty_transcript",
        true,
      );
    }

    const imageUrls: string[] = [
      ...(parsed.images ?? []),
      ...(parsed.image_urls ?? []),
      ...(parsed.photos ?? []),
    ].filter((value: unknown) => typeof value === "string");
    if (parsed.thumbnail && typeof parsed.thumbnail === "string") {
      imageUrls.push(parsed.thumbnail);
    }

    return {
      url,
      platform,
      provider: "tokscript",
      contentType,
      title: parsed.title ?? parsed.video_title ?? null,
      author: parsed.author ?? parsed.username ?? null,
      duration: typeof parsed.duration === "number" ? parsed.duration : null,
      transcript,
      imageUrls: imageUrls.length > 0 ? [...new Set(imageUrls)] : undefined,
      metadata: mergeDebugMetadata(
        { tokscript_tool: toolName },
        debugMetadata,
      ),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const warning = getProviderWarning(result, text);
    if (warning) {
      throw new ProviderError("tokscript", warning, "provider_limit", true);
    }

    return {
      url,
      platform,
      provider: "tokscript",
      contentType,
      transcript: text,
      metadata: mergeDebugMetadata({
        tokscript_tool: toolName,
        response_format: "text",
      }, debugMetadata),
    };
  }
}

async function loadYouTubeCaptionsTranscript(
  url: string,
  platform: Platform,
  contentType: ContentType,
): Promise<SocialMediaTranscript> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    throw new ProviderError(
      "youtube_captions",
      "Could not determine the YouTube video id from this URL.",
      "provider_request_failed",
    );
  }

  const watchUrl = new URL(YOUTUBE_WATCH_URL);
  watchUrl.searchParams.set("v", videoId);
  watchUrl.searchParams.set("hl", "en");
  watchUrl.searchParams.set("persist_hl", "1");

  const r = await fetch(watchUrl.toString(), {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
  });

  if (!r.ok) {
    throw new ProviderError(
      "youtube_captions",
      `YouTube watch page request failed (${r.status}).`,
      "provider_request_failed",
    );
  }

  const html = await r.text();
  const playerResponse = extractYouTubePlayerResponse(html);
  const captions = asRecord(playerResponse.captions);
  const trackList = asRecord(captions?.playerCaptionsTracklistRenderer);
  const captionTracks = Array.isArray(trackList?.captionTracks)
    ? trackList.captionTracks.filter((track): track is YouTubeCaptionTrack => {
      return !!track && typeof track === "object" &&
        typeof (track as YouTubeCaptionTrack).baseUrl === "string";
    })
    : [];

  if (captionTracks.length === 0) {
    throw new ProviderError(
      "youtube_captions",
      "YouTube did not expose native caption tracks for this URL.",
      "provider_unavailable",
      true,
    );
  }

  const selectedTrack = chooseYouTubeCaptionTrack(captionTracks);
  const captionUrl = new URL(selectedTrack.baseUrl);
  captionUrl.searchParams.set("fmt", "json3");

  const captionResponse = await fetch(captionUrl.toString(), {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });

  if (!captionResponse.ok) {
    throw new ProviderError(
      "youtube_captions",
      `YouTube caption download failed (${captionResponse.status}).`,
      "provider_request_failed",
      true,
    );
  }

  const captionJson = await captionResponse.json();
  const transcript = extractYouTubeCaptionText(captionJson);
  if (!transcript) {
    throw new ProviderError(
      "youtube_captions",
      "YouTube returned caption metadata but no usable caption text.",
      "provider_empty_transcript",
      true,
    );
  }

  const videoDetails = asRecord(playerResponse.videoDetails);
  const lengthSeconds = firstNonEmptyString(videoDetails?.lengthSeconds);
  const trackName = getYouTubeCaptionTrackName(selectedTrack);

  return {
    url,
    platform,
    provider: "youtube_captions",
    contentType,
    title: firstNonEmptyString(videoDetails?.title) ?? null,
    author: firstNonEmptyString(videoDetails?.author) ?? null,
    duration: lengthSeconds ? Number(lengthSeconds) : null,
    language: selectedTrack.languageCode ?? null,
    transcript,
    metadata: {
      extraction_method: "youtube_native_captions",
      youtube_caption_language: selectedTrack.languageCode ?? null,
      youtube_caption_kind: selectedTrack.kind ?? null,
      youtube_caption_track: trackName,
    },
  };
}

async function loadElevenLabsTranscript(
  url: string,
  platform: Platform,
  contentType: ContentType,
): Promise<SocialMediaTranscript> {
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) {
    throw new ProviderError(
      "elevenlabs",
      "ELEVENLABS_API_KEY is not configured. Set it as a Supabase secret before using ElevenLabs-backed URLs.",
      "provider_unavailable",
    );
  }

  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("source_url", url);
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");
  form.append("diarize", "false");

  const r = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    const code = r.status === 401 || r.status === 403
      ? "provider_auth"
      : "provider_request_failed";
    throw new ProviderError(
      "elevenlabs",
      `ElevenLabs transcription failed (${r.status}): ${msg}`,
      code,
    );
  }

  const json = await r.json();
  const transcript = extractElevenLabsText(json);
  if (!transcript) {
    throw new ProviderError(
      "elevenlabs",
      "ElevenLabs did not return transcript text for this URL.",
      "provider_empty_transcript",
    );
  }

  const words = Array.isArray(json.words) ? json.words : [];
  const audioEventCount =
    words.filter((word: Record<string, unknown>) =>
      word?.type === "audio_event"
    ).length;
  const wordCount =
    words.filter((word: Record<string, unknown>) => word?.type === "word")
      .length;

  return {
    url,
    platform,
    provider: "elevenlabs",
    contentType,
    duration: inferDurationSeconds(words),
    transcript,
    language: typeof json.language_code === "string"
      ? json.language_code
      : null,
    metadata: {
      elevenlabs_model: "scribe_v2",
      language_probability: typeof json.language_probability === "number"
        ? json.language_probability
        : null,
      word_count: wordCount,
      audio_event_count: audioEventCount,
      timestamps_granularity: "word",
    },
  };
}

function extractElevenLabsText(
  json: Record<string, unknown>,
): string | undefined {
  const directText = firstNonEmptyString(json.text, json.transcript);
  if (directText) return directText;

  const transcripts = json.transcripts;
  if (transcripts && typeof transcripts === "object") {
    const values = Object.values(transcripts as Record<string, unknown>);
    const parts = values
      .map((value) => firstStringValue(value, ["text", "transcript"]))
      .filter((value): value is string => !!value);
    if (parts.length > 0) return parts.join("\n\n");
  }

  return undefined;
}

function inferDurationSeconds(
  words: Array<Record<string, unknown>>,
): number | null {
  const endTimes = words
    .map((word) => word.end)
    .filter((value): value is number => typeof value === "number");
  if (endTimes.length === 0) return null;
  return Math.ceil(Math.max(...endTimes));
}

function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    const directId = parsed.searchParams.get("v");
    if (directId) return directId;

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" || segments[0] === "embed") {
      return segments[1] ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

function extractYouTubePlayerResponse(html: string): Record<string, unknown> {
  const markers = [
    "ytInitialPlayerResponse = ",
    "var ytInitialPlayerResponse = ",
    "window['ytInitialPlayerResponse'] = ",
  ];

  for (const marker of markers) {
    const json = extractBalancedJsonAfter(html, marker);
    if (!json) continue;

    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  throw new ProviderError(
    "youtube_captions",
    "Could not locate YouTube player metadata for this URL.",
    "provider_response_invalid",
    true,
  );
}

function extractBalancedJsonAfter(
  text: string,
  marker: string,
): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function chooseYouTubeCaptionTrack(
  tracks: YouTubeCaptionTrack[],
): YouTubeCaptionTrack {
  const score = (track: YouTubeCaptionTrack): number => {
    const language = track.languageCode?.toLowerCase() ?? "";
    const isEnglish = language === "en" || language.startsWith("en-");
    const isAsr = track.kind === "asr";
    if (isEnglish && !isAsr) return 4;
    if (isEnglish) return 3;
    if (!isAsr) return 2;
    return 1;
  };

  return [...tracks].sort((left, right) => score(right) - score(left))[0];
}

function extractYouTubeCaptionText(payload: unknown): string | undefined {
  const json = asRecord(payload);
  const events = Array.isArray(json?.events) ? json.events : [];
  const lines = events
    .map((event) => {
      const record = asRecord(event);
      const segments = Array.isArray(record?.segs) ? record.segs : [];
      const line = segments
        .map((segment) => {
          const text = firstNonEmptyString(asRecord(segment)?.utf8);
          return text ? decodeHtmlEntities(text) : "";
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      return line;
    })
    .filter((line): line is string => !!line);

  if (lines.length === 0) return undefined;
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getYouTubeCaptionTrackName(track: YouTubeCaptionTrack): string | null {
  const name = firstNonEmptyString(
    track.name?.simpleText,
    ...(track.name?.runs?.map((run) => run.text) ?? []),
  );
  return name ?? null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

async function resolveTranscript(url: string): Promise<ResolvedTranscript> {
  const selection = await selectProvider(url);
  let scrapedData: TikTokPageData = { imageUrls: [] };

  if (selection.platform === "youtube") {
    return resolveYouTubeTranscript(url, selection);
  }

  if (selection.provider === "openrouter_vision") {
    scrapedData = await fetchTikTokPageData(url);
    if (scrapedData.imageUrls.length > 0) {
      const transcript = await visionDescribeImages(
        scrapedData.imageUrls,
        true,
      );
      return {
        transcript: {
          url,
          platform: selection.platform,
          provider: "openrouter_vision",
          contentType: selection.contentType,
          title: scrapedData.title ?? null,
          author: scrapedData.author ?? null,
          transcript,
          imageUrls: scrapedData.imageUrls,
          metadata: { extraction_method: "tiktok_slide_scrape_vision" },
        },
        selectedProvider: "openrouter_vision",
        selectionReason: selection.reason,
        visionUsed: true,
        visionImageUrls: scrapedData.imageUrls,
      };
    }

    const fallbackReason =
      "TikTok photo carousel slide scraping returned no image URLs, so TokScript was selected for extraction.";
    const ts = await loadTokScriptTranscript(
      url,
      selection.platform,
      selection.contentType,
    );
    return applyVisionSupplement(
      ts,
      true,
      scrapedData,
      "tokscript",
      fallbackReason,
    );
  }

  if (selection.provider === "tokscript") {
    const ts = await loadTokScriptTranscript(
      url,
      selection.platform,
      selection.contentType,
    );
    return applyVisionSupplement(
      ts,
      selection.contentType === "photo_carousel",
      scrapedData,
      selection.provider,
      selection.reason,
    );
  }

  const elevenLabsTranscript = await loadElevenLabsTranscript(
    url,
    selection.platform,
    selection.contentType,
  );
  return {
    transcript: elevenLabsTranscript,
    selectedProvider: selection.provider,
    selectionReason: selection.reason,
    visionUsed: false,
    visionImageUrls: [],
  };
}

async function resolveYouTubeTranscript(
  url: string,
  selection: ProviderSelection,
): Promise<ResolvedTranscript> {
  const fallbackReasons: string[] = [selection.reason];

  if (selection.provider === "tokscript") {
    try {
      const transcript = await loadTokScriptTranscript(
        url,
        selection.platform,
        selection.contentType,
      );
      return {
        transcript,
        selectedProvider: "tokscript",
        selectionReason: selection.reason,
        visionUsed: false,
        visionImageUrls: [],
        debugMetadata: transcript.metadata,
      };
    } catch (error) {
      const tokScriptDebugMetadata = getProviderDebugMetadata(error);
      fallbackReasons.push(
        `TokScript primary failed: ${formatProviderFallbackReason(error)}`,
      );

      if (!isProviderLimitWarning(error)) {
        fallbackReasons.push(
          "Falling through to secondary providers because TokScript returned no usable transcript payload.",
        );
      }

      if (tokScriptDebugMetadata) {
        fallbackReasons.push("TokScript raw response was captured in transcript metadata.");
      }

      selection.reason = fallbackReasons.join(" ");
      return resolveYouTubeSecondaryTranscript(
        url,
        selection,
        tokScriptDebugMetadata,
      );
    }
  }

  return resolveYouTubeSecondaryTranscript(url, selection);
}

async function resolveYouTubeSecondaryTranscript(
  url: string,
  selection: ProviderSelection,
  debugMetadata?: JsonObject,
): Promise<ResolvedTranscript> {
  const fallbackReasons = [selection.reason];

  if (selection.provider === "tokscript" || selection.provider === "youtube_captions") {
    try {
      const transcript = await loadYouTubeCaptionsTranscript(
        url,
        selection.platform,
        selection.contentType,
      );
      return {
        transcript,
        selectedProvider: "youtube_captions",
        selectionReason: fallbackReasons.join(" "),
        visionUsed: false,
        visionImageUrls: [],
        debugMetadata,
      };
    } catch (error) {
      fallbackReasons.push(
        `Native YouTube captions fallback failed: ${formatProviderFallbackReason(error)}`,
      );
    }
  }

  const transcript = await loadElevenLabsTranscript(
    url,
    selection.platform,
    selection.contentType,
  );
  return {
    transcript,
    selectedProvider: "elevenlabs",
    selectionReason: fallbackReasons.join(" "),
    visionUsed: false,
    visionImageUrls: [],
    debugMetadata,
  };
}

function formatProviderFallbackReason(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function applyVisionSupplement(
  transcript: SocialMediaTranscript,
  isPhotoPost: boolean,
  scrapedData: TikTokPageData,
  selectedProvider: ProviderId,
  selectionReason: string,
): Promise<ResolvedTranscript> {
  let finalTranscript = transcript.transcript;
  let visionUsed = false;
  let visionImageUrls: string[] = [];

  if (isPhotoPost || transcript.transcript.trim().length < 50) {
    visionImageUrls = scrapedData.imageUrls.length > 0
      ? scrapedData.imageUrls
      : transcript.imageUrls ?? [];
    if (visionImageUrls.length > 0) {
      finalTranscript = await visionDescribeImages(
        visionImageUrls,
        isPhotoPost,
      );
      visionUsed = true;
    }
  }

  return {
    transcript: {
      ...transcript,
      title: transcript.title ?? scrapedData.title ?? null,
      author: transcript.author ?? scrapedData.author ?? null,
      transcript: finalTranscript,
      imageUrls: transcript.imageUrls ?? visionImageUrls,
    },
    selectedProvider,
    selectionReason,
    visionUsed,
    visionImageUrls,
  };
}

async function fingerprintUrl(url: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildTranscriptMetadata(resolved: ResolvedTranscript): JsonObject {
  return {
    ...(resolved.transcript.metadata ?? {}),
    ...(resolved.debugMetadata ?? {}),
    selected_provider: resolved.selectedProvider,
    selection_reason: resolved.selectionReason,
    vision_extracted: resolved.visionUsed,
    image_count: resolved.visionImageUrls.length,
  };
}

const app = new Hono();
const FUNCTION_NAME = Deno.env.get("SOCIAL_MEDIA_FUNCTION_NAME") ??
  DEFAULT_FUNCTION_NAME;
const FUNCTION_BASE_URL = `${
  Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")
}/functions/v1/${FUNCTION_NAME}`;
const OAUTH_REDIRECT_URI = `${FUNCTION_BASE_URL}/callback`;

app.get("*", async (c) => {
  const action = c.req.query("action");
  const isCallback = c.req.path.endsWith("/callback");
  const hasCode = !!c.req.query("code");
  const hasState = !!c.req.query("state");

  if (action === "oauth_start") {
    const key = c.req.query("key") || c.req.header("x-access-key");
    const expected = Deno.env.get("MCP_ACCESS_KEY");
    if (!key || key !== expected) return c.json({ error: "Unauthorized" }, 401);

    let clientId = Deno.env.get("TOKSCRIPT_CLIENT_ID");
    if (!clientId) {
      const regRes = await fetch(TOKSCRIPT_REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Open Brain Social Media Ingestion",
          redirect_uris: [OAUTH_REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        }),
      });

      if (!regRes.ok) {
        const msg = await regRes.text().catch(() => "");
        return c.json(
          { error: `TokScript client registration failed: ${msg}` },
          500,
        );
      }

      const reg = await regRes.json();
      clientId = reg.client_id as string;
      return c.json({
        action_required: true,
        provider: "tokscript",
        message:
          "TokScript client registered. Add the client_id as a Supabase secret, then visit the oauth_start URL again.",
        client_id: clientId,
        command: `supabase secrets set TOKSCRIPT_CLIENT_ID=${clientId}`,
      });
    }

    const { verifier, challenge } = await generatePKCE();
    const state = generateState();

    await supabase.from("social_media_oauth_state").insert({
      state,
      provider_id: "tokscript",
      code_verifier: verifier,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: "mcp:access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    return Response.redirect(`${TOKSCRIPT_AUTH_URL}?${params.toString()}`);
  }

  if (isCallback && hasCode && hasState) {
    const code = c.req.query("code")!;
    const state = c.req.query("state")!;
    const { data: stateRow, error: stateErr } = await supabase
      .from("social_media_oauth_state")
      .select("provider_id, code_verifier, created_at")
      .eq("state", state)
      .single();

    if (stateErr || !stateRow) {
      return c.json({ error: "Invalid or expired OAuth state." }, 400);
    }
    if (stateRow.provider_id !== "tokscript") {
      return c.json({
        error: `Unsupported OAuth provider: ${stateRow.provider_id}`,
      }, 400);
    }

    const age = Date.now() - new Date(stateRow.created_at).getTime();
    if (age > 10 * 60 * 1000) {
      await supabase.from("social_media_oauth_state").delete().eq(
        "state",
        state,
      );
      return c.json({
        error: "OAuth state expired. Please start the flow again.",
      }, 400);
    }

    const clientId = Deno.env.get("TOKSCRIPT_CLIENT_ID");
    if (!clientId) {
      return c.json({ error: "TOKSCRIPT_CLIENT_ID is not configured." }, 500);
    }

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
      return c.json({ error: `TokScript token exchange failed: ${msg}` }, 500);
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)
      .toISOString();
    await supabase.from("social_media_provider_tokens").upsert({
      provider_id: "tokscript",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      expires_at: expiresAt,
      metadata: { auth_type: "oauth_pkce" },
      updated_at: new Date().toISOString(),
    });

    await supabase.from("social_media_oauth_state").delete().eq("state", state);
    return c.json({
      success: true,
      provider: "tokscript",
      message:
        "TokScript connected successfully. You can now use save_social_media_transcript.",
    });
  }

  return c.json({
    status: "ok",
    service: "Social Media Ingestion MCP",
    version: "1.0.0",
    providers: ["tokscript", "elevenlabs"],
  });
});

app.post("*", async (c) => {
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

  if (c.req.query("action") === "init_tokens") {
    const body = await c.req.json().catch(() => null);
    if (!body?.access_token || !body?.refresh_token) {
      return c.json(
        { error: "access_token and refresh_token are required" },
        400,
      );
    }

    const providerId = typeof body.provider_id === "string"
      ? body.provider_id
      : "tokscript";
    if (providerId !== "tokscript") {
      return c.json({
        error: "Only TokScript OAuth token bootstrap is supported.",
      }, 400);
    }

    const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000)
      .toISOString();
    const { error: upsertErr } = await supabase.from(
      "social_media_provider_tokens",
    ).upsert({
      provider_id: "tokscript",
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      client_id: typeof body.client_id === "string" ? body.client_id : null,
      expires_at: expiresAt,
      metadata: { auth_type: "oauth_pkce" },
      updated_at: new Date().toISOString(),
    });

    if (upsertErr) return c.json({ error: upsertErr.message }, 500);
    return c.json({
      success: true,
      provider: "tokscript",
      message: "TokScript tokens stored.",
    });
  }

  const server = new McpServer({
    name: "social-media-ingestion",
    version: "1.0.0",
  });

  server.tool(
    "save_social_media_transcript",
    "Fetch a transcript from a supported social media URL with automatic provider selection and save it to Open Brain.",
    {
      url: z.string().url().describe(
        "Full TikTok, Instagram/Reel, YouTube/Shorts, or hosted media URL",
      ),
      tags: z.array(z.string()).optional().describe(
        "Optional tags to attach to the transcript",
      ),
    },
    async ({ url, tags }) => {
      let selectedProvider: ProviderId | undefined;
      try {
        const fingerprint = await fingerprintUrl(url);
        const { data: existing } = await supabase
          .from("social_media_transcripts")
          .select("id, url, platform, provider, title, author, created_at")
          .eq("content_fingerprint", fingerprint)
          .single();

        if (existing) {
          return responseJson({
            success: true,
            already_exists: true,
            message: "Transcript already saved.",
            record: existing,
          });
        }

        const resolved = await resolveTranscript(url);
        selectedProvider = resolved.selectedProvider;
        const embedding = await getEmbedding(resolved.transcript.transcript);
        const metadata = buildTranscriptMetadata(resolved);

        const { data, error } = await supabase
          .from("social_media_transcripts")
          .insert({
            url: resolved.transcript.url,
            platform: resolved.transcript.platform,
            provider: resolved.transcript.provider,
            content_type: resolved.transcript.contentType,
            title: resolved.transcript.title ?? null,
            author: resolved.transcript.author ?? null,
            duration: resolved.transcript.duration ?? null,
            transcript: resolved.transcript.transcript,
            embedding,
            tags: tags ?? [],
            metadata,
            image_urls: resolved.transcript.imageUrls ?? [],
            language: resolved.transcript.language ?? null,
            content_fingerprint: fingerprint,
          })
          .select(
            "id, url, platform, provider, content_type, title, author, created_at",
          )
          .single();

        if (error) throw new Error(`DB insert failed: ${error.message}`);
        return responseJson({
          success: true,
          message: "Transcript saved to Open Brain.",
          selected_provider: resolved.selectedProvider,
          selection_reason: resolved.selectionReason,
          record: data,
        });
      } catch (err) {
        return responseError(err, selectedProvider);
      }
    },
  );

  server.tool(
    "get_social_media_transcript_preview",
    "Fetch a transcript from a supported social media URL with automatic provider selection without saving it.",
    {
      url: z.string().url().describe(
        "Full TikTok, Instagram/Reel, YouTube/Shorts, or hosted media URL",
      ),
    },
    async ({ url }) => {
      let selectedProvider: ProviderId | undefined;
      try {
        const resolved = await resolveTranscript(url);
        selectedProvider = resolved.selectedProvider;
        return responseJson({
          success: true,
          selected_provider: resolved.selectedProvider,
          selection_reason: resolved.selectionReason,
          platform: resolved.transcript.platform,
          provider: resolved.transcript.provider,
          content_type: resolved.transcript.contentType,
          title: resolved.transcript.title,
          author: resolved.transcript.author,
          duration: resolved.transcript.duration,
          language: resolved.transcript.language,
          transcript: resolved.transcript.transcript,
          image_urls: resolved.transcript.imageUrls ?? [],
          metadata: buildTranscriptMetadata(resolved),
        });
      } catch (err) {
        return responseError(err, selectedProvider);
      }
    },
  );

  server.tool(
    "search_social_media_transcripts",
    "Semantically search saved social media transcripts in Open Brain.",
    {
      query: z.string().describe(
        "Search query describing what the transcript should be about",
      ),
      limit: z.number().min(1).max(50).optional().default(10).describe(
        "Max results to return",
      ),
      threshold: z.number().min(0).max(1).optional().default(0.5).describe(
        "Minimum similarity score from 0 to 1",
      ),
      platform: z.enum(PLATFORM_IDS).optional().describe("Filter by platform"),
      provider: z.enum(PROVIDER_IDS).optional().describe(
        "Filter by selected provider",
      ),
      content_type: z.enum(CONTENT_TYPES).optional().describe(
        "Filter by content type",
      ),
    },
    async ({ query, limit, threshold, platform, provider, content_type }) => {
      try {
        const embedding = await getEmbedding(query);
        const filter = {
          ...(platform ? { platform } : {}),
          ...(provider ? { provider } : {}),
          ...(content_type ? { content_type } : {}),
        };
        const { data, error } = await supabase.rpc(
          "match_social_media_transcripts",
          {
            query_embedding: embedding,
            match_threshold: threshold,
            match_count: limit,
            filter,
          },
        );
        if (error) throw new Error(`Search failed: ${error.message}`);
        return responseJson({
          success: true,
          count: data.length,
          results: data,
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  server.tool(
    "list_social_media_transcripts",
    "List saved social media transcripts in Open Brain, optionally filtered by platform, provider, or content type.",
    {
      platform: z.enum(PLATFORM_IDS).optional().describe("Filter by platform"),
      provider: z.enum(PROVIDER_IDS).optional().describe(
        "Filter by selected provider",
      ),
      content_type: z.enum(CONTENT_TYPES).optional().describe(
        "Filter by content type",
      ),
      limit: z.number().min(1).max(100).optional().default(20).describe(
        "Max records to return",
      ),
    },
    async ({ platform, provider, content_type, limit }) => {
      try {
        let query = supabase
          .from("social_media_transcripts")
          .select(
            "id, url, platform, provider, content_type, title, author, duration, language, tags, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(limit ?? 20);

        if (platform) query = query.eq("platform", platform);
        if (provider) query = query.eq("provider", provider);
        if (content_type) query = query.eq("content_type", content_type);

        const { data, error } = await query;
        if (error) throw new Error(`List failed: ${error.message}`);
        return responseJson({
          success: true,
          count: data.length,
          transcripts: data,
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  server.tool(
    "get_social_media_transcript_debug",
    "Inspect saved transcript metadata and provider debug payloads, including TokScript raw response diagnostics when available.",
    {
      url: z.string().url().optional().describe(
        "Optional exact transcript URL to inspect.",
      ),
      limit: z.number().int().min(1).max(25).optional().default(10).describe(
        "Max records to return when url is omitted.",
      ),
      require_tokscript_debug: z.boolean().optional().default(true).describe(
        "When true, only return records whose metadata includes tokscript_debug.",
      ),
    },
    async ({ url, limit, require_tokscript_debug }) => {
      try {
        const fetchLimit = url ? 1 : Math.max(limit ?? 10, 10) * 3;
        let query = supabase
          .from("social_media_transcripts")
          .select(
            "id, url, platform, provider, content_type, title, author, created_at, metadata",
          )
          .order("created_at", { ascending: false })
          .limit(fetchLimit);

        if (url) query = query.eq("url", url);

        const { data, error } = await query;
        if (error) throw new Error(`Debug lookup failed: ${error.message}`);

        const records = (data ?? []).filter((row) => {
          if (!require_tokscript_debug) return true;
          const metadata = asRecord(row.metadata);
          return !!metadata && !!asRecord(metadata.tokscript_debug);
        }).slice(0, url ? 1 : (limit ?? 10));

        return responseJson({
          success: true,
          count: records.length,
          records,
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  server.tool(
    "set_default_provider_preference",
    "Set a deployment-level default provider preference used before the built-in routing rules.",
    {
      platform: z.enum(PLATFORM_IDS).optional().describe(
        "Optional platform to match. Omit to match any platform.",
      ),
      content_type: z.enum(CONTENT_TYPES).optional().describe(
        "Optional content type to match. Omit to match any content type.",
      ),
      provider: z.enum(PROVIDER_IDS).describe(
        "Preferred provider to use when this preference matches.",
      ),
      priority: z.number().int().min(0).max(1000).optional().default(100)
        .describe("Higher priority wins when multiple preferences match."),
      reason: z.string().optional().describe(
        "Optional reason returned when this preference is applied.",
      ),
    },
    async ({ platform, content_type, provider, priority, reason }) => {
      try {
        if (!platform && !content_type) {
          throw new Error(
            "At least one of platform or content_type must be provided.",
          );
        }

        const existing = await getExactProviderPreference(
          platform ?? null,
          content_type ?? null,
        );

        if (existing) {
          const { data, error } = await supabase
            .from("social_media_provider_preferences")
            .update({
              provider,
              priority: priority ?? 100,
              reason: reason ?? null,
            })
            .eq("id", existing.id)
            .select(
              "id, platform, content_type, provider, priority, reason, created_at, updated_at",
            )
            .single();

          if (error) {
            throw new Error(`Preference update failed: ${error.message}`);
          }

          const record = mapProviderPreference(data as {
            id: string;
            platform: Platform | null;
            content_type: ContentType | null;
            provider: ProviderId;
            priority: number;
            reason: string | null;
            created_at: string;
            updated_at: string;
          });

          return responseJson({
            success: true,
            message: "Default provider preference updated.",
            record,
          });
        }

        const { data, error } = await supabase
          .from("social_media_provider_preferences")
          .insert({
            platform: platform ?? null,
            content_type: content_type ?? null,
            provider,
            priority: priority ?? 100,
            reason: reason ?? null,
          })
          .select(
            "id, platform, content_type, provider, priority, reason, created_at, updated_at",
          )
          .single();

        if (error) throw new Error(`Preference insert failed: ${error.message}`);

        return responseJson({
          success: true,
          message: "Default provider preference saved.",
          record: mapProviderPreference(data as {
            id: string;
            platform: Platform | null;
            content_type: ContentType | null;
            provider: ProviderId;
            priority: number;
            reason: string | null;
            created_at: string;
            updated_at: string;
          }),
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  server.tool(
    "list_default_provider_preferences",
    "List deployment-level default provider preferences in priority order.",
    {
      limit: z.number().int().min(1).max(100).optional().default(20).describe(
        "Max records to return",
      ),
    },
    async ({ limit }) => {
      try {
        const { data, error } = await supabase
          .from("social_media_provider_preferences")
          .select(
            "id, platform, content_type, provider, priority, reason, created_at, updated_at",
          )
          .order("priority", { ascending: false })
          .order("updated_at", { ascending: false })
          .limit(limit ?? 20);

        if (error) {
          throw new Error(`Preference list failed: ${error.message}`);
        }

        return responseJson({
          success: true,
          count: data.length,
          preferences: (data ?? []).map((row) =>
            mapProviderPreference(row as {
              id: string;
              platform: Platform | null;
              content_type: ContentType | null;
              provider: ProviderId;
              priority: number;
              reason: string | null;
              created_at: string;
              updated_at: string;
            })
          ),
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  server.tool(
    "delete_default_provider_preference",
    "Delete a deployment-level default provider preference by its platform and content type scope.",
    {
      platform: z.enum(PLATFORM_IDS).optional().describe(
        "Platform scope of the preference to delete.",
      ),
      content_type: z.enum(CONTENT_TYPES).optional().describe(
        "Content type scope of the preference to delete.",
      ),
    },
    async ({ platform, content_type }) => {
      try {
        if (!platform && !content_type) {
          throw new Error(
            "At least one of platform or content_type must be provided.",
          );
        }

        const existing = await getExactProviderPreference(
          platform ?? null,
          content_type ?? null,
        );

        if (!existing) {
          return responseJson({
            success: true,
            deleted: false,
            message: "No matching default provider preference was found.",
          });
        }

        const { error } = await supabase
          .from("social_media_provider_preferences")
          .delete()
          .eq("id", existing.id);

        if (error) {
          throw new Error(`Preference delete failed: ${error.message}`);
        }

        return responseJson({
          success: true,
          deleted: true,
          message: "Default provider preference deleted.",
          record: existing,
        });
      } catch (err) {
        return responseError(err);
      }
    },
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
