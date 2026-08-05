import assert from "node:assert/strict";
import test from "node:test";

import {
  KeeperBridge,
  classifyRating,
  parsePlexMetadata,
  parsePlexWebhook,
} from "./bridge.mjs";

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

test("keeps only highly-rated tracks from the Aurral library", () => {
  const payload = { event: "media.rate", Metadata: { userRating: 10 } };
  assert.deepEqual(
    classifyRating(payload, {
      userRating: 10,
      librarySectionTitle: "Aurral",
      grandparentTitle: "Burial",
      parentTitle: "Untrue",
      title: "Archangel",
    }),
    {
      action: "keep",
      rating: 10,
      track: { artistName: "Burial", albumName: "Untrue", trackName: "Archangel" },
    },
  );
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

test("creates the static playlist once and appends the rated track", async () => {
  const calls = [];
  let created = false;
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/library/metadata/42")) {
      return new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [{
            ratingKey: "42",
            userRating: 10,
            librarySectionTitle: "Aurral",
            grandparentTitle: "Massive Attack",
            parentTitle: "Mezzanine",
            title: "Teardrop",
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/playlists/status")) {
      return new Response(JSON.stringify({
        sharedPlaylists: created ? [{ id: "keepers-id", name: "Aurral Keepers" }] : [],
      }), { status: 200 });
    }
    if (url.endsWith("/api/playlists/shared-playlists")) {
      created = true;
      return new Response(JSON.stringify({ playlistId: "keepers-id", queued: true }), { status: 200 });
    }
    if (url.endsWith("/api/playlists/shared-playlists/keepers-id/tracks")) {
      return new Response(JSON.stringify({ success: true, queued: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const bridge = new KeeperBridge({
    fetch: fakeFetch,
    plexUrl: "http://plex",
    plexToken: "plex-token",
    aurralUrl: "http://aurral",
    aurralApiKey: "aurral-key",
  });
  const result = await bridge.process({
    event: "media.rate",
    Metadata: { ratingKey: "42", userRating: 10 },
  });
  assert.equal(result.action, "kept");
  assert.equal(result.playlistId, "keepers-id");
  const append = calls.find((call) => call.url.endsWith("/keepers-id/tracks"));
  assert.deepEqual(JSON.parse(append.options.body), {
    tracks: [{ artistName: "Massive Attack", albumName: "Mezzanine", trackName: "Teardrop" }],
  });
});
