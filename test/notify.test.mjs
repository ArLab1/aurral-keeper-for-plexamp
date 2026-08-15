import assert from "node:assert/strict";
import test from "node:test";

import { LEVELS, buildNotification } from "../src/notify.mjs";

const REQUESTED = {
  action: "requested",
  rating: 10,
  albumMbid: "abc-123",
  albumName: "Mezzanine",
  artistName: "Massive Attack",
  resolvedBy: "track-on-album",
  queued: false,
  libraryAlbumId: 7,
  searched: true,
};

test("levels run from debug to error", () => {
  assert.deepEqual(LEVELS, ["debug", "info", "warn", "error"]);
});

test("a requested album is info, titled and described from the album", () => {
  const notification = buildNotification(REQUESTED);
  assert.equal(notification.level, "info");
  assert.equal(notification.title, "Album requested");
  assert.equal(notification.description, "**Mezzanine** — Massive Attack");
  assert.deepEqual(notification.fields, {
    rating: 10,
    resolvedBy: "track-on-album",
    searched: true,
  });
});

test("a requested album whose search failed is a warning", () => {
  const notification = buildNotification({
    ...REQUESTED,
    searched: false,
    searchError: "Lidarr timed out",
  });
  assert.equal(notification.level, "warn");
  assert.equal(notification.title, "Album requested, search failed");
  assert.equal(notification.fields.searchError, "Lidarr timed out");
});

test("an unresolved album is a warning describing the track", () => {
  const notification = buildNotification({
    action: "ignore",
    reason: "unresolved-album",
    track: { artistName: "Boards of Canada", trackName: "Roygbiv", albumName: null },
  });
  assert.equal(notification.level, "warn");
  assert.equal(notification.title, "No album matched");
  assert.equal(notification.description, "**Roygbiv** — Boards of Canada");
});

test("every other ignore is debug, with the reason in the title", () => {
  for (const reason of [
    "not-media-rate",
    "missing-rating",
    "rating-below-threshold",
    "outside-aurral-library",
    "missing-track-identity",
    "recent-duplicate",
  ]) {
    const notification = buildNotification({ action: "ignore", reason });
    assert.equal(notification.level, "debug", reason);
    assert.equal(notification.title, `Ignored: ${reason}`);
  }
});

test("an ignore carries only the context it actually has", () => {
  const notification = buildNotification({
    action: "ignore",
    reason: "outside-aurral-library",
    library: "Music",
  });
  assert.deepEqual(notification.fields, { library: "Music" });
});

test("a thrown error is an error, truncated to 500 characters", () => {
  const notification = buildNotification(null, new Error("x".repeat(900)));
  assert.equal(notification.level, "error");
  assert.equal(notification.title, "Webhook failed");
  assert.equal(notification.description.length, 500);
});
