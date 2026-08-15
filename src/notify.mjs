/** Ascending severity. A notification posts when its level is at or above the configured one. */
export const LEVELS = ["debug", "info", "warn", "error"];

const MAX_DESCRIPTION = 500;

/** Drops absent values so neither formatter has to filter. */
function presentFields(entries) {
  const fields = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) continue;
    fields[key] = value;
  }
  return fields;
}

/**
 * Maps a `KeeperBridge.process` result — or an error that escaped the request
 * handler — onto the canonical notification every formatter consumes. This is
 * the single place severity is decided.
 */
export function buildNotification(result, error = null) {
  if (error) {
    return {
      level: "error",
      title: "Webhook failed",
      description: String(error?.message || error).slice(0, MAX_DESCRIPTION),
      fields: {},
    };
  }

  if (result?.action === "requested") {
    const failed = Boolean(result.searchError);
    return {
      level: failed ? "warn" : "info",
      title: failed ? "Album requested, search failed" : "Album requested",
      description: `**${result.albumName}** — ${result.artistName}`,
      fields: presentFields({
        rating: result.rating,
        resolvedBy: result.resolvedBy,
        searched: result.searched,
        searchError: result.searchError,
      }),
    };
  }

  if (result?.reason === "unresolved-album") {
    const track = result.track || {};
    return {
      level: "warn",
      title: "No album matched",
      description: `**${track.trackName || ""}** — ${track.artistName || ""}`,
      fields: presentFields({ rating: result.rating }),
    };
  }

  return {
    level: "debug",
    title: `Ignored: ${result?.reason || "unknown"}`,
    description: "",
    fields: presentFields({
      rating: result?.rating,
      library: result?.library,
      albumMbid: result?.albumMbid,
    }),
  };
}

const LEVEL_COLORS = {
  debug: 0x99aab5,
  info: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
};

/** Display names for the field keys `buildNotification` emits. */
const FIELD_LABELS = {
  rating: "Rating",
  resolvedBy: "Resolved by",
  searched: "Searched",
  searchError: "Search error",
  library: "Library",
  albumMbid: "Album MBID",
};

export function formatDiscord(notification, { username = "Aurral Keeper" } = {}) {
  const embed = {
    title: notification.title,
    color: LEVEL_COLORS[notification.level] ?? LEVEL_COLORS.debug,
  };
  if (notification.description) embed.description = notification.description;
  const entries = Object.entries(notification.fields || {});
  if (entries.length) {
    embed.fields = entries.map(([key, value]) => ({
      name: FIELD_LABELS[key] || key,
      value: String(value),
      inline: true,
    }));
  }
  return { username, embeds: [embed] };
}

/**
 * The canonical notification, posted as-is. Stable and self-describing, which
 * is what a Home Assistant webhook or a hand-written receiver needs. `username`
 * is a Discord concept and has no home here.
 */
export function formatGeneric(notification) {
  return notification;
}

const FORMATTERS = { discord: formatDiscord, generic: formatGeneric };
const DISCORD_HOSTS = /(^|\.)(discord\.com|discordapp\.com)$/;
const DEFAULT_TIMEOUT_MS = 5000;

/** Picks a wire format from the URL, so a Discord webhook needs no extra config. */
export function detectFormat(url) {
  try {
    return DISCORD_HOSTS.test(new URL(url).hostname.toLowerCase()) ? "discord" : "generic";
  } catch {
    return "generic";
  }
}

/**
 * Fire-and-forget delivery. Every failure is logged and swallowed: a deleted
 * Discord webhook or a network blip must not turn into a 500 for Plex.
 */
export class Notifier {
  constructor({
    fetch: fetchImpl,
    url = null,
    level = "warn",
    format = null,
    username = "Aurral Keeper",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!LEVELS.includes(level)) {
      throw new Error(`NOTIFY_LEVEL must be one of: ${LEVELS.join(", ")}`);
    }
    const resolved = format || (url ? detectFormat(url) : "generic");
    if (!FORMATTERS[resolved]) {
      throw new Error(`NOTIFY_FORMAT must be one of: ${Object.keys(FORMATTERS).join(", ")}`);
    }
    this.fetch = fetchImpl || globalThis.fetch;
    this.url = url || null;
    this.level = level;
    this.format = resolved;
    this.username = username;
    this.timeoutMs = timeoutMs;
  }

  enabled() {
    return Boolean(this.url);
  }

  async notify(result, error = null) {
    if (!this.enabled()) return;
    try {
      const notification = buildNotification(result, error);
      if (LEVELS.indexOf(notification.level) < LEVELS.indexOf(this.level)) return;
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(FORMATTERS[this.format](notification, { username: this.username })),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        console.warn(`Notification returned ${response.status}`);
      }
    } catch (sendError) {
      console.warn(`Notification failed: ${sendError.message}`);
    }
  }
}
