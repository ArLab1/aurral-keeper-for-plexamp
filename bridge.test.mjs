import assert from "node:assert/strict";
import test from "node:test";

import {
  AurralClient,
  FlowJobIndex,
  KeeperBridge,
  classifyRating,
  flowKeyFromPath,
  artistIdentityMatches,
  isStudioAlbum,
  normalizeTitle,
  releaseRank,
  parsePlexMetadata,
  parsePlexWebhook,
  resolveAlbum,
} from "./bridge.mjs";

const PLEX_FILE = "/Media/downloads/aurral/aurral-weekly-flow/flow-1/Massive Attack/Mezzanine/Teardrop.m4a";
const AURRAL_FILE = "/app/downloads/aurral-weekly-flow/flow-1/Massive Attack/Mezzanine/Teardrop.m4a";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake Aurral + Plex. `overrides` replaces individual responses so each test
 * only states what it cares about.
 */
function makeFetch(overrides = {}, calls = []) {
  const flows = overrides.flows ?? [{ id: "flow-1", name: "Discover Weekly", enabled: true }];
  const jobs = overrides.jobs ?? [];
  const artist = overrides.artist ?? null;
  const tracklists = overrides.tracklists ?? {};
  const search = overrides.search ?? { catalog: { albums: [] } };
  const plexMetadata = overrides.plexMetadata ?? {
    ratingKey: "42",
    userRating: 10,
    librarySectionTitle: "Aurral",
    grandparentTitle: "Massive Attack",
    parentTitle: "Mezzanine",
    title: "Teardrop",
    file: PLEX_FILE,
  };

  return async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/library/metadata/")) {
      return jsonResponse({ MediaContainer: { Metadata: [plexMetadata] } });
    }
    if (url.endsWith("/api/playlists/status")) return jsonResponse({ flows });
    if (url.includes("/api/playlists/jobs/")) return jsonResponse(jobs);
    const tracklist = url.match(/\/api\/artists\/release-group\/([^/]+)\/tracks$/);
    if (tracklist) return jsonResponse(tracklists[tracklist[1]] ?? []);
    const group = url.match(/\/api\/artists\/release-group\/([^/]+)$/);
    if (group) {
      const detail = (overrides.releaseGroups ?? {})[group[1]];
      return detail ? jsonResponse(detail) : new Response("not found", { status: 404 });
    }
    if (url.includes("/api/artists/")) {
      return artist ? jsonResponse(artist) : new Response("not found", { status: 404 });
    }
    if (url.includes("/api/search/unified")) return jsonResponse(search);
    if (url.endsWith("/api/library/albums/request")) {
      return jsonResponse(overrides.requestResult ?? { album: { id: 77 }, artist: { id: 9 } });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeBridge(overrides = {}, calls = []) {
  return new KeeperBridge({
    fetch: makeFetch(overrides, calls),
    plexUrl: "http://plex",
    plexToken: "plex-token",
    aurralUrl: "http://aurral",
    aurralApiKey: "aurral-key",
  });
}

const RATE_PAYLOAD = { event: "media.rate", Metadata: { ratingKey: "42", userRating: 10 } };

test("parses Plex multipart webhooks even with an image part", () => {
  const boundary = "plex-boundary";
  const payload = { event: "media.rate", Metadata: { ratingKey: "42", userRating: 10 } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="thumb.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  assert.deepEqual(
    parsePlexWebhook(`multipart/form-data; boundary=${boundary}`, body),
    payload,
  );
});

test("parses Plex XML metadata", () => {
  const metadata = parsePlexMetadata(
    '<MediaContainer><Track title="Roads &amp; Bridges" grandparentTitle="Portishead" parentTitle="Dummy" userRating="10" librarySectionTitle="Aurral"><Media><Part file="/Media/downloads/aurral/aurral-weekly-flow/id/track.flac" /></Media></Track></MediaContainer>',
    "application/xml",
  );
  assert.equal(metadata.title, "Roads & Bridges");
  assert.equal(metadata.grandparentTitle, "Portishead");
  assert.equal(metadata.file, "/Media/downloads/aurral/aurral-weekly-flow/id/track.flac");
});

test("normalizes titles across editions, features and diacritics", () => {
  assert.equal(normalizeTitle("Agnetha Fältskog"), "agnetha faltskog");
  assert.equal(normalizeTitle("Doll Domination (Deluxe Edition)"), normalizeTitle("doll domination"));
  assert.equal(normalizeTitle("Curious (feat. Toro y Moi)"), "curious");
  assert.equal(normalizeTitle("Untrue - Remastered"), "untrue");
});

test("matches Plex and Aurral paths on their shared tail", () => {
  assert.equal(flowKeyFromPath(PLEX_FILE), flowKeyFromPath(AURRAL_FILE));
  assert.equal(flowKeyFromPath("/Media/music/Burial/Untrue/Archangel.flac"), null);
  assert.equal(flowKeyFromPath(null), null);
});

test("keeps only highly-rated tracks from the Aurral library", () => {
  const payload = { event: "media.rate", Metadata: { userRating: 10 } };
  const kept = classifyRating(payload, {
    userRating: 10,
    librarySectionTitle: "Aurral",
    grandparentTitle: "Burial",
    parentTitle: "Untrue",
    title: "Archangel",
    file: AURRAL_FILE,
  });
  assert.equal(kept.action, "keep");
  assert.deepEqual(kept.track, { artistName: "Burial", albumName: "Untrue", trackName: "Archangel" });
  assert.equal(kept.file, AURRAL_FILE);

  assert.equal(
    classifyRating(payload, {
      userRating: 8,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Burial",
      title: "Archangel",
    }).reason,
    "rating-below-threshold",
  );
  assert.equal(
    classifyRating(payload, {
      userRating: 10,
      librarySectionTitle: "Music",
      file: "/Media/music/Burial/Untrue/Archangel.flac",
      grandparentTitle: "Burial",
      title: "Archangel",
    }).reason,
    "outside-aurral-library",
  );
});

test("treats placeholder album tags as no album at all", () => {
  const kept = classifyRating(RATE_PAYLOAD, {
    userRating: 10,
    librarySectionTitle: "Aurral",
    grandparentTitle: "Swing Republic",
    parentTitle: "Unknown Album",
    title: "Crazy in Love",
  });
  assert.equal(kept.track.albumName, null);
});

test("requests the flow job's album when it is a studio album", async () => {
  const calls = [];
  const bridge = makeBridge({
    jobs: [{
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      artistMbid: "artist-mbid",
      albumMbid: "album-mbid",
      finalPath: AURRAL_FILE,
    }],
    artist: {
      name: "Massive Attack",
      "release-groups": [
        { id: "album-mbid", title: "Mezzanine", "primary-type": "Album", "secondary-types": [] },
      ],
    },
  }, calls);

  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.action, "requested");
  assert.equal(result.albumMbid, "album-mbid");
  assert.equal(result.libraryAlbumId, 77);

  const request = calls.find((call) => call.url.endsWith("/api/library/albums/request"));
  assert.deepEqual(JSON.parse(request.options.body), {
    albumMbid: "album-mbid",
    albumName: "Mezzanine",
    artistMbid: "artist-mbid",
    artistName: "Massive Attack",
    triggerSearch: true,
  });
});

test("matches the flow job by artist and track when the path does not line up", async () => {
  const bridge = makeBridge({
    plexMetadata: {
      ratingKey: "42",
      userRating: 10,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Massive Attack",
      parentTitle: "Mezzanine",
      title: "Teardrop",
      file: "/Media/some/other/place/Teardrop.m4a",
    },
    jobs: [{
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumMbid: "album-mbid",
      artistMbid: "artist-mbid",
      finalPath: null,
    }],
    artist: {
      name: "Massive Attack",
      "release-groups": [
        { id: "album-mbid", title: "Mezzanine", "primary-type": "Album", "secondary-types": [] },
      ],
    },
  });
  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.action, "requested");
  assert.equal(result.albumMbid, "album-mbid");
  // Only the name-matched job supplies artistMbid, so an artist-backed source
  // proves the job was found without help from the path.
  assert.equal(result.resolvedBy, "release-group");
});

test("falls back to the artist release groups when the job has no album mbid", async () => {
  const bridge = makeBridge({
    jobs: [{
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine (Deluxe Edition)",
      artistMbid: "artist-mbid",
      albumMbid: null,
      finalPath: AURRAL_FILE,
    }],
    artist: {
      id: "artist-mbid",
      name: "Massive Attack",
      "release-groups": [
        { id: "rg-live", title: "Mezzanine", "primary-type": "Live" },
        { id: "rg-album", title: "Mezzanine", "primary-type": "Album" },
        { id: "rg-other", title: "Blue Lines", "primary-type": "Album" },
      ],
    },
  });

  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.action, "requested");
  assert.equal(result.resolvedBy, "release-group");
  assert.equal(result.albumMbid, "rg-album");
});

test("classifies studio albums apart from compilations and repackages", () => {
  assert.equal(isStudioAlbum({ "primary-type": "Album", "secondary-types": [] }), true);
  assert.equal(isStudioAlbum({ "primary-type": "Album", "secondary-types": ["Compilation"] }), false);
  assert.equal(isStudioAlbum({ "primary-type": "Album", "secondary-types": ["Live"] }), false);
  assert.equal(isStudioAlbum({ "primary-type": "EP", "secondary-types": [] }), false);
  assert.ok(
    releaseRank({ "primary-type": "Album", "secondary-types": [] }) >
      releaseRank({ "primary-type": "EP", "secondary-types": [] }),
  );
  assert.ok(
    releaseRank({ "primary-type": "Single", "secondary-types": [] }) >
      releaseRank({ "primary-type": "Album", "secondary-types": ["Compilation"] }),
  );
});

test("prefers the studio album carrying the track over the flow job's compilation", async () => {
  const calls = [];
  const bridge = makeBridge({
    jobs: [{
      artistName: "Alessia Cara",
      trackName: "Make It To Christmas",
      albumName: "Xmas Pop",
      artistMbid: "artist-mbid",
      albumMbid: "va-compilation",
      finalPath: AURRAL_FILE,
    }],
    plexMetadata: {
      ratingKey: "42",
      userRating: 10,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Alessia Cara",
      parentTitle: "Xmas Pop",
      title: "Make It To Christmas",
      file: PLEX_FILE,
    },
    artist: {
      name: "Alessia Cara",
      "release-groups": [
        { id: "rg-comp", title: "Broken Heart", "primary-type": "Album", "secondary-types": ["Compilation"] },
        { id: "rg-late", title: "In the Meantime", "primary-type": "Album", "secondary-types": [], "first-release-date": "2021-09-24" },
        { id: "rg-early", title: "Know-It-All", "primary-type": "Album", "secondary-types": [], "first-release-date": "2015-03-11" },
      ],
    },
    tracklists: {
      "rg-early": [{ title: "Here" }, { title: "Seventeen" }],
      "rg-late": [{ title: "Make It to Christmas" }, { title: "Sweet Dream" }],
    },
  }, calls);

  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.resolvedBy, "track-on-album");
  assert.equal(result.albumMbid, "rg-late");
  assert.equal(result.albumName, "In the Meantime");
  // Compilations are never asked for while a studio album carries the track.
  const request = calls.find((call) => call.url.endsWith("/api/library/albums/request"));
  assert.equal(JSON.parse(request.options.body).albumMbid, "rg-late");
});

test("stops after the tracklist lookup budget and reuses cached tracklists", async () => {
  const calls = [];
  const groups = Array.from({ length: 8 }, (_, i) => ({
    id: `rg-${i}`,
    title: `Album ${i}`,
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": `200${i}-01-01`,
  }));
  const bridge = new KeeperBridge({
    fetch: makeFetch({
      jobs: [{
        artistName: "Massive Attack",
        trackName: "Teardrop",
        albumName: null,
        artistMbid: "artist-mbid",
        albumMbid: null,
        finalPath: AURRAL_FILE,
      }],
      artist: { name: "Massive Attack", "release-groups": groups },
      tracklists: { "rg-2": [{ title: "Teardrop" }] },
    }, calls),
    plexUrl: "http://plex",
    plexToken: "plex-token",
    aurralUrl: "http://aurral",
    aurralApiKey: "aurral-key",
    maxTracklistLookups: 2,
  });

  // Budget of 2 stops before rg-2, so the track is never found there.
  const first = await bridge.process(RATE_PAYLOAD);
  assert.notEqual(first.albumMbid, "rg-2");
  const lookups = calls.filter((call) => call.url.includes("/tracks")).length;
  assert.equal(lookups, 2);

  await bridge.process({ ...RATE_PAYLOAD, Metadata: { ratingKey: "43", userRating: 10 } });
  assert.equal(calls.filter((call) => call.url.includes("/tracks")).length, 2);
});

test("falls back to the flow job's album when nothing better exists", async () => {
  const bridge = makeBridge({
    jobs: [{
      artistName: "Various Friends",
      trackName: "Obscure Cut",
      albumName: "Some Compilation",
      artistMbid: "artist-mbid",
      albumMbid: "comp-mbid",
      finalPath: AURRAL_FILE,
    }],
    artist: { "release-groups": [] },
    releaseGroups: {
      "comp-mbid": { title: "Some Compilation", "primary-type": "Album", "secondary-types": ["Compilation"] },
    },
  });
  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.resolvedBy, "flow-job-fallback");
  assert.equal(result.albumMbid, "comp-mbid");
});

test("discards an artist mbid that resolves to a different artist", async () => {
  const calls = [];
  const bridge = makeBridge({
    jobs: [{
      artistName: "Ke$ha",
      trackName: "Tik Tok",
      albumName: "Animal",
      artistMbid: "wrong-artist-mbid",
      albumMbid: "animal-mbid",
      finalPath: AURRAL_FILE,
    }],
    plexMetadata: {
      ratingKey: "42",
      userRating: 10,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Ke$ha",
      parentTitle: "Animal",
      title: "Tik Tok",
      file: PLEX_FILE,
    },
    // The mbid belongs to a-ha, whose discography must not be requested.
    artist: {
      name: "a-ha",
      "release-groups": [
        { id: "hunting-high", title: "Hunting High and Low", "primary-type": "Album", "secondary-types": [] },
      ],
    },
    releaseGroups: {
      "animal-mbid": { title: "Animal", "primary-type": "Album", "secondary-types": [] },
    },
  }, calls);

  const result = await bridge.process(RATE_PAYLOAD);
  assert.equal(result.albumMbid, "animal-mbid");
  // The album stands on its own merits once the release group is inspected.
  assert.equal(result.resolvedBy, "flow-job");
  const request = JSON.parse(
    calls.find((call) => call.url.endsWith("/api/library/albums/request")).options.body,
  );
  assert.equal(request.artistMbid, null);
  assert.equal(request.artistName, "Ke$ha");
});

test("keeps an artist mbid when the name matches through an alias", () => {
  assert.equal(artistIdentityMatches({ name: "Massive Attack" }, "Massive Attack"), true);
  assert.equal(artistIdentityMatches({ name: "a-ha" }, "Ke$ha"), false);
  assert.equal(
    artistIdentityMatches({ name: "Beyoncé", aliases: [{ name: "Beyonce Knowles" }] }, "Beyonce Knowles"),
    true,
  );
});

test("falls back to search and rejects hits by another artist", async () => {
  const client = new AurralClient({
    fetch: makeFetch({
      artist: { "release-groups": [] },
      search: {
        catalog: {
          albums: [
            { id: "wrong", title: "Mezzanine", artistMbid: "someone-else", artistName: "Tribute Band" },
            { id: "right", title: "Mezzanine", artistMbid: "artist-mbid", artistName: "Massive Attack" },
          ],
        },
      },
    }),
    baseUrl: "http://aurral",
    apiKey: "key",
  });

  const album = await resolveAlbum(
    client,
    { artistName: "Massive Attack", trackName: "Teardrop", albumName: "Mezzanine" },
    { artistName: "Massive Attack", artistMbid: "artist-mbid", albumName: null, albumMbid: null },
  );
  assert.equal(album.albumMbid, "right");
  assert.equal(album.source, "search");
});

test("ignores the rating when no album can be resolved", async () => {
  const bridge = makeBridge({
    jobs: [],
    plexMetadata: {
      ratingKey: "42",
      userRating: 10,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Nobody",
      parentTitle: "Unknown Album",
      title: "Nothing",
      file: PLEX_FILE,
    },
  });
  const result = await bridge.process(RATE_PAYLOAD);
  assert.deepEqual(result, {
    action: "ignore",
    reason: "unresolved-album",
    track: { artistName: "Nobody", trackName: "Nothing", albumName: null },
  });
});

test("requests an album only once per dedupe window", async () => {
  const calls = [];
  const bridge = makeBridge({
    jobs: [
      {
        artistName: "Massive Attack",
        trackName: "Teardrop",
        albumMbid: "album-mbid",
        artistMbid: "artist-mbid",
        albumName: "Mezzanine",
        finalPath: AURRAL_FILE,
      },
      {
        artistName: "Massive Attack",
        trackName: "Angel",
        albumMbid: "album-mbid",
        artistMbid: "artist-mbid",
        albumName: "Mezzanine",
        finalPath: AURRAL_FILE.replace("Teardrop", "Angel"),
      },
    ],
  }, calls);

  const first = await bridge.process(RATE_PAYLOAD);
  const second = await bridge.process(RATE_PAYLOAD);
  assert.equal(first.action, "requested");
  assert.deepEqual(second, { action: "ignore", reason: "recent-duplicate", albumMbid: "album-mbid" });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/library/albums/request")).length, 1);
});

test("a failed request does not poison the dedupe window", async () => {
  let attempts = 0;
  const bridge = new KeeperBridge({
    fetch: async (url, options) => {
      if (url.endsWith("/api/library/albums/request")) {
        attempts += 1;
        if (attempts === 1) return new Response("lidarr offline", { status: 502 });
        return jsonResponse({ queued: true });
      }
      return makeFetch({
        jobs: [{
          artistName: "Massive Attack",
          trackName: "Teardrop",
          albumMbid: "album-mbid",
          artistMbid: "artist-mbid",
          albumName: "Mezzanine",
          finalPath: AURRAL_FILE,
        }],
      })(url, options);
    },
    plexUrl: "http://plex",
    plexToken: "plex-token",
    aurralUrl: "http://aurral",
    aurralApiKey: "aurral-key",
  });

  await assert.rejects(() => bridge.process(RATE_PAYLOAD), /502/);
  const retry = await bridge.process(RATE_PAYLOAD);
  assert.equal(retry.action, "requested");
  assert.equal(retry.queued, true);
});

test("reuses the flow job index until its TTL expires", async () => {
  const calls = [];
  const client = new AurralClient({
    fetch: makeFetch({ jobs: [{ artistName: "A", trackName: "B", finalPath: AURRAL_FILE }] }, calls),
    baseUrl: "http://aurral",
    apiKey: "key",
  });
  let clock = 1000;
  const index = new FlowJobIndex(client, { ttlMs: 500, now: () => clock });

  await index.find({ artistName: "A", trackName: "B" }, AURRAL_FILE);
  await index.find({ artistName: "A", trackName: "B" }, AURRAL_FILE);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/playlists/status")).length, 1);

  clock += 600;
  await index.find({ artistName: "A", trackName: "B" }, AURRAL_FILE);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/playlists/status")).length, 2);
});
