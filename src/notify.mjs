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
