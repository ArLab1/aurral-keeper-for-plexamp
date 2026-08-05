import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_BODY_BYTES = 12 * 1024 * 1024;

function decodeXml(value = "") {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function tagAttributes(xml, tagName) {
  const match = String(xml).match(new RegExp(`<${tagName}\\b([^>]*)>`, "i"));
  if (!match) return {};
  const attributes = {};
  for (const item of match[1].matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[item[1]] = decodeXml(item[2]);
  }
  return attributes;
}

export function parsePlexMetadata(body, contentType = "") {
  const text = String(body || "");
  if (contentType.includes("json") || text.trimStart().startsWith("{")) {
    const parsed = JSON.parse(text);
    return parsed?.MediaContainer?.Metadata?.[0] || parsed?.Metadata?.[0] || parsed;
  }
  const track = tagAttributes(text, "Track");
  const part = tagAttributes(text, "Part");
  return {
    ...track,
    file: part.file || null,
  };
}

export function parsePlexWebhook(contentType, body) {
  if (String(contentType).toLowerCase().includes("application/json")) {
    return JSON.parse(body.toString("utf8"));
  }

  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
  if (!boundary) throw new Error("Plex webhook is missing its multipart boundary");

  const marker = Buffer.from(`--${boundary}`);
  let cursor = 0;
  while (cursor < body.length) {
    const markerStart = body.indexOf(marker, cursor);
    if (markerStart < 0) break;
    const partStart = markerStart + marker.length;
    const nextMarker = body.indexOf(marker, partStart);
    if (nextMarker < 0) break;
    let part = body.subarray(partStart, nextMarker);
    if (part.subarray(0, 2).equals(Buffer.from("\r\n"))) part = part.subarray(2);
    if (part.subarray(-2).equals(Buffer.from("\r\n"))) part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString("utf8");
      if (/content-disposition:[^\r\n]*name="payload"/i.test(headers)) {
        return JSON.parse(part.subarray(headerEnd + 4).toString("utf8"));
      }
    }
    cursor = nextMarker;
  }
  throw new Error("Plex webhook did not contain a payload field");
}

export function classifyRating(payload, metadata, options = {}) {
  if (payload?.event !== "media.rate") return { action: "ignore", reason: "not-media-rate" };
  const rating = Number(metadata?.userRating ?? payload?.Metadata?.userRating);
  if (!Number.isFinite(rating)) return { action: "ignore", reason: "missing-rating" };
  if (rating < Number(options.minRating ?? 10)) {
    return { action: "ignore", reason: "rating-below-threshold", rating };
  }

  const library = String(
    metadata?.librarySectionTitle || payload?.Metadata?.librarySectionTitle || "",
  ).trim();
  const file = String(metadata?.file || "");
  const expectedLibrary = String(options.sourceLibrary || "Aurral").trim();
  const expectedPath = String(options.sourcePathFragment || "/aurral-weekly-flow/");
  if (library !== expectedLibrary && !file.includes(expectedPath)) {
    return { action: "ignore", reason: "outside-aurral-library", library };
  }

  const track = {
    artistName: String(metadata?.grandparentTitle || payload?.Metadata?.grandparentTitle || "").trim(),
    trackName: String(metadata?.title || payload?.Metadata?.title || "").trim(),
    albumName: String(metadata?.parentTitle || payload?.Metadata?.parentTitle || "").trim() || null,
  };
  if (!track.artistName || !track.trackName) {
    return { action: "ignore", reason: "missing-track-identity" };
  }
  return { action: "keep", rating, track };
}

async function secretFromEnv(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  const file = String(process.env[`${name}_FILE`] || "").trim();
  if (!file) throw new Error(`${name} or ${name}_FILE is required`);
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Webhook body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export class KeeperBridge {
  constructor(options) {
    this.fetch = options.fetch || globalThis.fetch;
    this.plexUrl = options.plexUrl.replace(/\/+$/, "");
    this.plexToken = options.plexToken;
    this.aurralUrl = options.aurralUrl.replace(/\/+$/, "");
    this.aurralApiKey = options.aurralApiKey;
    this.playlistName = options.playlistName || "Aurral Keepers";
    this.sourceLibrary = options.sourceLibrary || "Aurral";
    this.sourcePathFragment = options.sourcePathFragment || "/aurral-weekly-flow/";
    this.minRating = Number(options.minRating ?? 10);
    this.playlistId = null;
    this.ensurePromise = null;
    this.recent = new Map();
  }

  async request(url, options = {}) {
    const response = await this.fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return { response, text };
  }

  async getPlexMetadata(ratingKey) {
    if (!ratingKey) return {};
    const { response, text } = await this.request(
      `${this.plexUrl}/library/metadata/${encodeURIComponent(ratingKey)}`,
      {
        headers: {
          accept: "application/json",
          "x-plex-token": this.plexToken,
        },
      },
    );
    return parsePlexMetadata(text, response.headers.get("content-type") || "");
  }

  aurralHeaders() {
    return {
      "content-type": "application/json",
      "x-api-key": this.aurralApiKey,
    };
  }

  async findPlaylist() {
    const { text } = await this.request(`${this.aurralUrl}/api/playlists/status`, {
      headers: this.aurralHeaders(),
    });
    const status = JSON.parse(text);
    return (status.sharedPlaylists || []).find(
      (playlist) => String(playlist.name || "").trim() === this.playlistName,
    );
  }

  async waitForPlaylist(expectedId, attempts = 30) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const playlist = await this.findPlaylist();
      if (playlist?.id === expectedId || playlist?.name === this.playlistName) return playlist;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Aurral did not finish creating ${this.playlistName}`);
  }

  async ensurePlaylist() {
    if (this.playlistId) return this.playlistId;
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = (async () => {
      const existing = await this.findPlaylist();
      if (existing?.id) {
        this.playlistId = existing.id;
        return existing.id;
      }
      const { text } = await this.request(`${this.aurralUrl}/api/playlists/shared-playlists`, {
        method: "POST",
        headers: this.aurralHeaders(),
        body: JSON.stringify({ name: this.playlistName, tracks: [] }),
      });
      const created = JSON.parse(text);
      const playlist = await this.waitForPlaylist(created.playlistId);
      this.playlistId = playlist.id;
      return playlist.id;
    })();
    try {
      return await this.ensurePromise;
    } finally {
      this.ensurePromise = null;
    }
  }

  async keepTrack(track) {
    const playlistId = await this.ensurePlaylist();
    await this.request(
      `${this.aurralUrl}/api/playlists/shared-playlists/${encodeURIComponent(playlistId)}/tracks`,
      {
        method: "POST",
        headers: this.aurralHeaders(),
        body: JSON.stringify({ tracks: [track] }),
      },
    );
    return playlistId;
  }

  async process(payload) {
    if (payload?.event !== "media.rate") return { action: "ignore", reason: "not-media-rate" };
    const ratingKey = String(payload?.Metadata?.ratingKey || "").trim();
    const metadata = {
      ...(payload?.Metadata || {}),
      ...(await this.getPlexMetadata(ratingKey)),
    };
    const decision = classifyRating(payload, metadata, {
      minRating: this.minRating,
      sourceLibrary: this.sourceLibrary,
      sourcePathFragment: this.sourcePathFragment,
    });
    if (decision.action !== "keep") return decision;

    const dedupeKey = `${ratingKey}:${decision.rating}`;
    const now = Date.now();
    for (const [key, timestamp] of this.recent) {
      if (now - timestamp > 10 * 60 * 1000) this.recent.delete(key);
    }
    if (this.recent.has(dedupeKey)) {
      return { action: "ignore", reason: "recent-duplicate" };
    }

    const playlistId = await this.keepTrack(decision.track);
    this.recent.set(dedupeKey, now);
    return { action: "kept", playlistId, track: decision.track, rating: decision.rating };
  }
}

export async function loadConfig() {
  return {
    port: Number(process.env.PORT || 3010),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES),
    webhookSecret: await secretFromEnv("WEBHOOK_SECRET"),
    bridge: {
      plexUrl: process.env.PLEX_URL || "http://localhost:32400",
      plexToken: await secretFromEnv("PLEX_TOKEN"),
      aurralUrl: process.env.AURRAL_URL || "http://localhost:30073",
      aurralApiKey: await secretFromEnv("AURRAL_API_KEY"),
      playlistName: process.env.PLAYLIST_NAME || "Aurral Keepers",
      sourceLibrary: process.env.SOURCE_LIBRARY || "Aurral",
      sourcePathFragment: process.env.SOURCE_PATH_FRAGMENT || "/aurral-weekly-flow/",
      minRating: Number(process.env.MIN_RATING || 10),
    },
  };
}

export async function start(config = null) {
  config ||= await loadConfig();
  const bridge = new KeeperBridge(config.bridge);
  bridge.ensurePlaylist().then(
    (playlistId) => console.log(`Keepers playlist ready: ${playlistId}`),
    (error) => console.warn(`Keepers playlist initialization deferred: ${error.message}`),
  );

  const expectedPath = `/plex/${encodeURIComponent(config.webhookSecret)}`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return jsonResponse(res, 200, { ok: true, playlistName: bridge.playlistName });
      }
      if (req.method !== "POST" || url.pathname !== expectedPath) {
        return jsonResponse(res, 404, { error: "Not found" });
      }
      const body = await readRequestBody(req, config.maxBodyBytes);
      const payload = parsePlexWebhook(req.headers["content-type"] || "", body);
      const result = await bridge.process(payload);
      console.log(JSON.stringify({ event: payload?.event, account: payload?.Account?.title, ...result }));
      return jsonResponse(res, result.action === "kept" ? 200 : 202, result);
    } catch (error) {
      console.error(error.stack || error.message);
      return jsonResponse(res, error.statusCode || 500, { error: error.message });
    }
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Plexamp Aurral keeper listening on port ${config.port}`);
  });
  return { server, bridge };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
