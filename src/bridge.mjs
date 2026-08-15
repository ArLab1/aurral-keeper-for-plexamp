import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Notifier } from "./notify.mjs";

const DEFAULT_MAX_BODY_BYTES = 12 * 1024 * 1024;
const DEFAULT_FLOW_JOB_LIMIT = 200;
const PLACEHOLDER_ALBUM_NAMES = new Set(["", "unknown album", "unknown", "various artists"]);
const DEFAULT_TRACKLIST_LOOKUPS = 12;
/** Secondary types that mean "not the studio album this song belongs to". */
const NON_STUDIO_TYPES = new Set([
  "compilation",
  "live",
  "remix",
  "dj-mix",
  "mixtape/street",
  "demo",
  "soundtrack",
  "interview",
  "audiobook",
  "spokenword",
]);

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

/**
 * Collapses a title to a comparable form: no diacritics, no punctuation, no
 * edition/remaster/feature suffixes. "Doll Domination (Deluxe Edition)" and
 * "doll domination" compare equal.
 */
export function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*[([][^)\]]*(feat\.?|featuring|with)\b[^)\]]*[)\]]/g, " ")
    .replace(/\s*[([](deluxe|expanded|remaster(ed)?|anniversary|special|bonus|explicit|clean)[^)\]]*[)\]]/g, " ")
    .replace(/\s*-\s*(deluxe|expanded|remaster(ed)?|anniversary|special|bonus|single|ep)\b.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function usableAlbumName(value) {
  const name = String(value || "").trim();
  if (!name) return null;
  return PLACEHOLDER_ALBUM_NAMES.has(name.toLowerCase()) ? null : name;
}

/**
 * Reduces a track path to the part Plex and Aurral agree on: everything after
 * the flow directory. Aurral reports
 * `/app/downloads/aurral-weekly-flow/<flow>/<artist>/<album>/<track>.m4a`,
 * Plex reports the same tail behind its own mount prefix.
 */
export function flowKeyFromPath(path, fragment = "/aurral-weekly-flow/") {
  const text = String(path || "");
  const index = text.lastIndexOf(fragment);
  if (index < 0) return null;
  const tail = text.slice(index + fragment.length).trim();
  return tail ? tail.toLowerCase() : null;
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
    albumName: usableAlbumName(metadata?.parentTitle || payload?.Metadata?.parentTitle),
  };
  if (!track.artistName || !track.trackName) {
    return { action: "ignore", reason: "missing-track-identity" };
  }
  return { action: "keep", rating, track, file: file || null };
}

async function secretFromEnv(name, { optional = false } = {}) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  const file = String(process.env[`${name}_FILE`] || "").trim();
  if (!file) {
    if (optional) return null;
    throw new Error(`${name} or ${name}_FILE is required`);
  }
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

/** Thin HTTP wrapper around the Aurral endpoints this bridge needs. */
export class AurralClient {
  constructor({ fetch: fetchImpl, baseUrl, apiKey, jobLimit = DEFAULT_FLOW_JOB_LIMIT }) {
    this.fetch = fetchImpl || globalThis.fetch;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.jobLimit = jobLimit;
  }

  headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    };
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}/api${path}`;
    const response = await this.fetch(url, { ...options, headers: this.headers() });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} /api${path} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async listFlows() {
    const status = await this.request("/playlists/status");
    return (status?.flows || []).filter((flow) => flow?.id);
  }

  async listJobs(flowId) {
    const jobs = await this.request(
      `/playlists/jobs/${encodeURIComponent(flowId)}?limit=${this.jobLimit}`,
    );
    return Array.isArray(jobs) ? jobs : [];
  }

  async getArtist(mbid) {
    return this.request(`/artists/${encodeURIComponent(mbid)}`);
  }

  async search(query) {
    return this.request(`/search/unified?q=${encodeURIComponent(query)}`);
  }

  async getReleaseGroup(mbid) {
    return this.request(`/artists/release-group/${encodeURIComponent(mbid)}`);
  }

  async getReleaseGroupTracks(mbid) {
    const tracks = await this.request(`/artists/release-group/${encodeURIComponent(mbid)}/tracks`);
    return Array.isArray(tracks) ? tracks : [];
  }

  async requestAlbum(album) {
    return this.request("/library/albums/request", {
      method: "POST",
      body: JSON.stringify(album),
    });
  }

  async searchAlbum(libraryAlbumId) {
    return this.request("/library/downloads/album/search", {
      method: "POST",
      body: JSON.stringify({ albumId: libraryAlbumId }),
    });
  }
}

/**
 * Indexes every flow job by its path tail and by artist+track name, so a rated
 * Plex file can be traced back to the MusicBrainz identity Aurral downloaded it
 * with. Refreshed on a TTL because a burst of ratings should not re-pull every
 * flow.
 */
export class FlowJobIndex {
  constructor(client, { ttlMs = 5 * 60 * 1000, now = () => Date.now(), pathFragment } = {}) {
    this.client = client;
    this.ttlMs = ttlMs;
    this.now = now;
    this.pathFragment = pathFragment || "/aurral-weekly-flow/";
    this.byPath = new Map();
    this.byName = new Map();
    this.loadedAt = 0;
    this.loading = null;
  }

  static nameKey(artistName, trackName) {
    return `${normalizeTitle(artistName)}${normalizeTitle(trackName)}`;
  }

  async refresh() {
    const byPath = new Map();
    const byName = new Map();
    const flows = await this.client.listFlows();
    for (const flow of flows) {
      let jobs = [];
      try {
        jobs = await this.client.listJobs(flow.id);
      } catch (error) {
        console.warn(`Could not read jobs for flow ${flow.id}: ${error.message}`);
        continue;
      }
      for (const job of jobs) {
        if (!job?.artistName || !job?.trackName) continue;
        const pathKey = flowKeyFromPath(job.finalPath || job.externalPath, this.pathFragment);
        if (pathKey && !byPath.has(pathKey)) byPath.set(pathKey, job);
        const nameKey = FlowJobIndex.nameKey(job.artistName, job.trackName);
        const existing = byName.get(nameKey);
        // Prefer the entry that carries the most identity.
        if (!existing || (!existing.albumMbid && job.albumMbid)) byName.set(nameKey, job);
      }
    }
    this.byPath = byPath;
    this.byName = byName;
    this.loadedAt = this.now();
  }

  async ensureFresh() {
    if (this.loadedAt && this.now() - this.loadedAt < this.ttlMs) return;
    this.loading ||= this.refresh().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  async find(track, file) {
    await this.ensureFresh();
    const pathKey = flowKeyFromPath(file, this.pathFragment);
    if (pathKey && this.byPath.has(pathKey)) return this.byPath.get(pathKey);
    return this.byName.get(FlowJobIndex.nameKey(track.artistName, track.trackName)) || null;
  }
}

function secondaryTypes(group) {
  const types = group?.["secondary-types"] ?? group?.secondaryTypes ?? [];
  const list = Array.isArray(types) ? types : [types];
  return list.filter(Boolean).map((type) => String(type).toLowerCase());
}

function primaryType(group) {
  return String(group?.["primary-type"] ?? group?.primaryType ?? "").toLowerCase();
}

/** A proper studio album: primary type Album, with nothing marking it as a repackage. */
export function isStudioAlbum(group) {
  if (primaryType(group) !== "album") return false;
  return !secondaryTypes(group).some((type) => NON_STUDIO_TYPES.has(type));
}

/** Studio album beats EP beats single beats compilation/live/etc. */
export function releaseRank(group) {
  if (isStudioAlbum(group)) return 3;
  if (secondaryTypes(group).some((type) => NON_STUDIO_TYPES.has(type))) return 0;
  if (primaryType(group) === "ep") return 2;
  if (primaryType(group) === "single") return 1;
  return 0;
}

/**
 * Aurral's flow metadata occasionally carries an artist mbid belonging to a
 * different artist, so the fetched identity is checked before its release
 * groups are trusted.
 */
export function artistIdentityMatches(artist, artistName, aliases = []) {
  const wanted = normalizeTitle(artistName);
  if (!wanted) return false;
  const known = [artist?.name, artist?.["sort-name"], ...(artist?.aliases || []), ...aliases]
    .map((name) => normalizeTitle(typeof name === "string" ? name : name?.name))
    .filter(Boolean);
  return known.some(
    (name) => name === wanted || name.includes(wanted) || wanted.includes(name),
  );
}

function releaseDate(group) {
  return String(group?.["first-release-date"] ?? group?.releaseDate ?? "9999");
}

/**
 * Finds the earliest studio album carrying this track, by reading tracklists.
 * Bounded by `limit` requests and memoized, because this runs per rating.
 */
async function studioAlbumWithTrack(client, groups, trackName, { limit, cache }) {
  const wanted = normalizeTitle(trackName);
  if (!wanted) return null;
  const candidates = groups
    .filter(isStudioAlbum)
    .sort((a, b) => releaseDate(a).localeCompare(releaseDate(b)))
    .slice(0, limit);

  for (const group of candidates) {
    let tracks = cache.get(group.id);
    if (!tracks) {
      tracks = await client.getReleaseGroupTracks(group.id).catch((error) => {
        console.warn(`Tracklist lookup failed for ${group.id}: ${error.message}`);
        return [];
      });
      cache.set(group.id, tracks);
    }
    if (tracks.some((entry) => normalizeTitle(entry?.title || entry?.trackName) === wanted)) {
      return group;
    }
  }
  return null;
}

/**
 * Walks the resolution ladder from a rated track to a release group Lidarr can
 * be asked for. Studio albums are preferred at every rung: Aurral's own
 * metadata often points at a compilation the song was licensed to, which is not
 * the album worth downloading. Returns null rather than guessing when nothing
 * matches confidently.
 */
export async function resolveAlbum(client, track, job, options = {}) {
  const limit = Number(options.maxTracklistLookups ?? DEFAULT_TRACKLIST_LOOKUPS);
  const cache = options.tracklistCache || new Map();
  const artistName = job?.artistName || track.artistName;
  const albumName = usableAlbumName(job?.albumName) || usableAlbumName(track.albumName);

  let artistMbid = job?.artistMbid || null;
  let groups = [];
  if (artistMbid) {
    const artist = await client.getArtist(artistMbid).catch((error) => {
      console.warn(`Artist lookup failed for ${artistMbid}: ${error.message}`);
      return null;
    });
    if (artist && !artistIdentityMatches(artist, artistName, job?.artistAliases)) {
      console.warn(
        `Discarding artist mbid ${artistMbid}: it is "${artist.name}", not "${artistName}"`,
      );
      artistMbid = null;
    } else {
      groups = artist?.["release-groups"] || [];
    }
  }

  const found = (group, source) => ({
    albumMbid: group.id,
    albumName: group.title,
    artistMbid,
    artistName,
    source,
  });

  // 1. The named album, when it is a studio album by this artist.
  const named = albumName
    ? groups.filter((group) => normalizeTitle(group.title) === normalizeTitle(albumName))
    : [];
  const namedStudio = named.find(isStudioAlbum);
  if (namedStudio) return found(namedStudio, "release-group");

  // 2. Aurral's own album mbid, when that release group is itself a studio
  //    album. Checked directly so a wrong artist mbid cannot hide a good album.
  if (job?.albumMbid) {
    const flowGroup =
      groups.find((group) => group.id === job.albumMbid) ||
      (await client.getReleaseGroup(job.albumMbid).catch((error) => {
        console.warn(`Release group lookup failed for ${job.albumMbid}: ${error.message}`);
        return null;
      }));
    if (flowGroup && isStudioAlbum(flowGroup)) {
      return found({ id: job.albumMbid, title: flowGroup.title || albumName }, "flow-job");
    }
  }

  // 3. Whichever studio album actually carries this track.
  const carrier = await studioAlbumWithTrack(client, groups, track.trackName, { limit, cache });
  if (carrier) return found(carrier, "track-on-album");

  // 4. Best non-studio release by this artist: the named one, then the best search hit.
  const rankedNamed = named.slice().sort((a, b) => releaseRank(b) - releaseRank(a))[0];
  if (rankedNamed) return found(rankedNamed, "release-group-alt");

  const query = [artistName, track.trackName || albumName].filter(Boolean).join(" ");
  const results = await client.search(query).catch((error) => {
    console.warn(`Search failed for "${query}": ${error.message}`);
    return null;
  });
  const wantedArtist = normalizeTitle(artistName);
  const candidate = (results?.catalog?.albums || [])
    .filter((album) => {
      if (!album?.id) return false;
      return artistMbid
        ? album.artistMbid === artistMbid
        : normalizeTitle(album.artistName) === wantedArtist;
    })
    .sort((a, b) => releaseRank(b) - releaseRank(a))[0];
  if (candidate) {
    return {
      albumMbid: candidate.id,
      albumName: candidate.title,
      artistMbid: artistMbid || candidate.artistMbid || null,
      artistName,
      source: "search",
    };
  }

  // 5. Last resort: whatever Aurral downloaded it from, compilation or not.
  if (job?.albumMbid) {
    return {
      albumMbid: job.albumMbid,
      albumName: albumName || job.trackName,
      artistMbid,
      artistName,
      source: "flow-job-fallback",
    };
  }

  return null;
}

export class KeeperBridge {
  constructor(options) {
    this.fetch = options.fetch || globalThis.fetch;
    this.plexUrl = options.plexUrl.replace(/\/+$/, "");
    this.plexToken = options.plexToken;
    this.sourceLibrary = options.sourceLibrary || "Aurral";
    this.sourcePathFragment = options.sourcePathFragment || "/aurral-weekly-flow/";
    this.minRating = Number(options.minRating ?? 10);
    this.triggerSearch = options.triggerSearch !== false;
    this.aurral = options.aurral || new AurralClient({
      fetch: this.fetch,
      baseUrl: options.aurralUrl,
      apiKey: options.aurralApiKey,
    });
    this.flowJobs = options.flowJobs || new FlowJobIndex(this.aurral, {
      ttlMs: Number(options.flowJobCacheMs ?? 5 * 60 * 1000),
      pathFragment: this.sourcePathFragment,
    });
    this.maxTracklistLookups = Number(options.maxTracklistLookups ?? DEFAULT_TRACKLIST_LOOKUPS);
    this.tracklistCache = new Map();
    this.recent = new Map();
  }

  async getPlexMetadata(ratingKey) {
    if (!ratingKey) return {};
    const url = `${this.plexUrl}/library/metadata/${encodeURIComponent(ratingKey)}`;
    const response = await this.fetch(url, {
      headers: {
        accept: "application/json",
        "x-plex-token": this.plexToken,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GET /library/metadata/${ratingKey} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return parsePlexMetadata(text, response.headers.get("content-type") || "");
  }

  /** True the first time an album is seen in the dedupe window. */
  claim(albumMbid) {
    const now = Date.now();
    for (const [key, timestamp] of this.recent) {
      if (now - timestamp > 10 * 60 * 1000) this.recent.delete(key);
    }
    if (this.recent.has(albumMbid)) return false;
    this.recent.set(albumMbid, now);
    return true;
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

    const job = await this.flowJobs.find(decision.track, decision.file).catch((error) => {
      console.warn(`Flow job lookup failed: ${error.message}`);
      return null;
    });
    const album = await resolveAlbum(this.aurral, decision.track, job, {
      maxTracklistLookups: this.maxTracklistLookups,
      tracklistCache: this.tracklistCache,
    });
    if (!album) {
      return { action: "ignore", reason: "unresolved-album", track: decision.track };
    }

    if (!this.claim(album.albumMbid)) {
      return { action: "ignore", reason: "recent-duplicate", albumMbid: album.albumMbid };
    }

    let response;
    try {
      response = await this.aurral.requestAlbum({
        albumMbid: album.albumMbid,
        albumName: album.albumName,
        artistMbid: album.artistMbid,
        artistName: album.artistName,
        triggerSearch: this.triggerSearch,
      });
    } catch (error) {
      this.recent.delete(album.albumMbid);
      throw error;
    }

    const libraryAlbumId = response?.album?.id ?? null;
    const search = await this.ensureSearched(response, libraryAlbumId);

    return {
      action: "requested",
      rating: decision.rating,
      albumMbid: album.albumMbid,
      albumName: album.albumName,
      artistName: album.artistName,
      resolvedBy: album.source,
      queued: Boolean(response?.queued),
      libraryAlbumId,
      ...search,
    };
  }

  /**
   * Aurral only honours `triggerSearch` for an album already in the library;
   * adding one and searching for it are two steps, which is why the UI's button
   * reads "Add to Lidarr" and only then "Search Album". Requesting alone leaves
   * the album monitored with nothing downloaded, so the search is kicked off
   * explicitly. A failure here is logged, not thrown: the album is already
   * monitored, and re-rating retries.
   */
  async ensureSearched(response, libraryAlbumId) {
    if (!this.triggerSearch) return { searched: false, searchSkipped: "disabled" };
    if (response?.triggeredSearch) return { searched: true };
    if (!libraryAlbumId) {
      return { searched: false, searchSkipped: response?.queued ? "queued" : "no-album-id" };
    }
    try {
      await this.aurral.searchAlbum(libraryAlbumId);
      return { searched: true };
    } catch (error) {
      console.warn(`Search trigger failed for album ${libraryAlbumId}: ${error.message}`);
      return { searched: false, searchError: error.message };
    }
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
      aurralUrl: process.env.AURRAL_URL || "http://localhost:3000",
      aurralApiKey: await secretFromEnv("AURRAL_API_KEY"),
      sourceLibrary: process.env.SOURCE_LIBRARY || "Aurral",
      sourcePathFragment: process.env.SOURCE_PATH_FRAGMENT || "/aurral-weekly-flow/",
      minRating: Number(process.env.MIN_RATING || 10),
      flowJobCacheMs: Number(process.env.FLOW_JOB_CACHE_MS || 5 * 60 * 1000),
      maxTracklistLookups: Number(process.env.MAX_TRACKLIST_LOOKUPS || DEFAULT_TRACKLIST_LOOKUPS),
      triggerSearch: String(process.env.TRIGGER_SEARCH || "true").toLowerCase() !== "false",
    },
    notify: {
      url: await secretFromEnv("NOTIFY_URL", { optional: true }),
      level: String(process.env.NOTIFY_LEVEL || "warn").trim().toLowerCase(),
      format: process.env.NOTIFY_FORMAT ? String(process.env.NOTIFY_FORMAT).trim().toLowerCase() : null,
      username: process.env.NOTIFY_USERNAME || "Aurral Keeper",
    },
  };
}

export async function start(config = null) {
  config ||= await loadConfig();
  const bridge = new KeeperBridge(config.bridge);
  bridge.flowJobs.ensureFresh().then(
    () => console.log(`Flow job index ready: ${bridge.flowJobs.byPath.size} tracks`),
    (error) => console.warn(`Flow job index deferred: ${error.message}`),
  );

  const notifier = new Notifier({ fetch: bridge.fetch, ...(config.notify || {}) });
  if (notifier.enabled()) {
    console.log(`Notifications enabled: ${notifier.format} format, level ${notifier.level}`);
  }

  const expectedPath = `/plex/${encodeURIComponent(config.webhookSecret)}`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return jsonResponse(res, 200, {
          ok: true,
          sourceLibrary: bridge.sourceLibrary,
          minRating: bridge.minRating,
          flowTracksIndexed: bridge.flowJobs.byPath.size,
        });
      }
      if (req.method !== "POST" || url.pathname !== expectedPath) {
        return jsonResponse(res, 404, { error: "Not found" });
      }
      const body = await readRequestBody(req, config.maxBodyBytes);
      const payload = parsePlexWebhook(req.headers["content-type"] || "", body);
      const result = await bridge.process(payload);
      console.log(JSON.stringify({ event: payload?.event, account: payload?.Account?.title, ...result }));
      notifier.notify(result);
      return jsonResponse(res, result.action === "requested" ? 200 : 202, result);
    } catch (error) {
      console.error(error.stack || error.message);
      notifier.notify(null, error);
      return jsonResponse(res, error.statusCode || 500, { error: error.message });
    }
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Aurral Keeper for Plexamp listening on port ${config.port}`);
  });
  return { server, bridge, notifier };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
