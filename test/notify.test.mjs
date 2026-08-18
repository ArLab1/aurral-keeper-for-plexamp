import assert from "node:assert/strict";
import test from "node:test";

import { LEVELS, buildNotification, formatDiscord, formatGeneric, Notifier, detectFormat } from "../src/notify.mjs";

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

test("an unresolved album is a warning describing the track, with no fields", () => {
  const notification = buildNotification({
    action: "ignore",
    reason: "unresolved-album",
    track: { artistName: "Boards of Canada", trackName: "Roygbiv", albumName: null },
  });
  assert.equal(notification.level, "warn");
  assert.equal(notification.title, "No album matched");
  assert.equal(notification.description, "**Roygbiv** — Boards of Canada");
  assert.deepEqual(notification.fields, {});
});

test("a requested album with a null album name has no literal null in the description", () => {
  const notification = buildNotification({ ...REQUESTED, albumName: null });
  assert.equal(notification.description, "**** — Massive Attack");
  assert.equal(notification.description.includes("null"), false);
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

test("a Discord embed carries the level's color and inline fields", () => {
  const body = formatDiscord(buildNotification(REQUESTED), { username: "Keeper" });
  assert.equal(body.username, "Keeper");
  assert.equal(body.embeds.length, 1);
  const [embed] = body.embeds;
  assert.equal(embed.title, "Album requested");
  assert.equal(embed.description, "**Mezzanine** — Massive Attack");
  assert.equal(embed.color, 0x57f287);
  assert.deepEqual(embed.fields, [
    { name: "Rating", value: "10", inline: true },
    { name: "Resolved by", value: "track-on-album", inline: true },
    { name: "Searched", value: "true", inline: true },
  ]);
});

test("each level gets its own Discord color", () => {
  const colorOf = (notification) => formatDiscord(notification).embeds[0].color;
  assert.equal(colorOf({ level: "debug", title: "t", description: "", fields: {} }), 0x99aab5);
  assert.equal(colorOf({ level: "info", title: "t", description: "", fields: {} }), 0x57f287);
  assert.equal(colorOf({ level: "warn", title: "t", description: "", fields: {} }), 0xfee75c);
  assert.equal(colorOf({ level: "error", title: "t", description: "", fields: {} }), 0xed4245);
});

test("an unmapped field key is used as its own label", () => {
  const body = formatDiscord({
    level: "info",
    title: "t",
    description: "",
    fields: { somethingNew: 3 },
  });
  assert.deepEqual(body.embeds[0].fields, [
    { name: "somethingNew", value: "3", inline: true },
  ]);
});

test("an embed with nothing to say omits description and fields", () => {
  const [embed] = formatDiscord({ level: "debug", title: "t", description: "", fields: {} }).embeds;
  assert.equal("description" in embed, false);
  assert.equal("fields" in embed, false);
});

test("the generic body is the canonical notification", () => {
  const notification = buildNotification(REQUESTED);
  assert.deepEqual(formatGeneric(notification), {
    level: "info",
    title: "Album requested",
    description: "**Mezzanine** — Massive Attack",
    fields: { rating: 10, resolvedBy: "track-on-album", searched: true },
  });
});

function recordingFetch(calls, response = new Response(null, { status: 204 })) {
  return async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
}

test("a discord.com URL formats as Discord, anything else as generic", () => {
  assert.equal(detectFormat("https://discord.com/api/webhooks/1/abc"), "discord");
  assert.equal(detectFormat("https://discordapp.com/api/webhooks/1/abc"), "discord");
  assert.equal(detectFormat("https://ptb.discord.com/api/webhooks/1/abc"), "discord");
  assert.equal(detectFormat("https://home.lan/api/webhook/xyz"), "generic");
  assert.equal(detectFormat("not a url"), "generic");
  assert.equal(detectFormat("https://notdiscord.com/hook"), "generic");
});

test("an explicit format overrides the URL host", () => {
  const notifier = new Notifier({ url: "https://discord.com/api/webhooks/1/a", format: "generic" });
  assert.equal(notifier.format, "generic");
});

test("a notifier without a URL is disabled and never fetches", async () => {
  const calls = [];
  const notifier = new Notifier({ fetch: recordingFetch(calls) });
  assert.equal(notifier.enabled(), false);
  await notifier.notify(REQUESTED);
  assert.equal(calls.length, 0);
});

test("the default threshold suppresses debug and passes warn", async () => {
  const calls = [];
  const notifier = new Notifier({
    fetch: recordingFetch(calls),
    url: "https://discord.com/api/webhooks/1/a",
  });
  assert.equal(notifier.level, "warn");
  await notifier.notify({ action: "ignore", reason: "recent-duplicate" });
  assert.equal(calls.length, 0);
  await notifier.notify({ action: "ignore", reason: "unresolved-album", track: {} });
  assert.equal(calls.length, 1);
});

test("a POST carries the URL, JSON content type, and a Discord body", async () => {
  const calls = [];
  const notifier = new Notifier({
    fetch: recordingFetch(calls),
    url: "https://discord.com/api/webhooks/1/a",
    level: "info",
    username: "Keeper",
  });
  await notifier.notify(REQUESTED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/webhooks/1/a");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.username, "Keeper");
  assert.equal(body.embeds[0].title, "Album requested");
});

test("NOTIFY_LEVEL=debug lets ignores through, as the canonical object", async () => {
  const calls = [];
  const notifier = new Notifier({
    fetch: recordingFetch(calls),
    url: "https://home.lan/hook",
    level: "debug",
  });
  await notifier.notify({ action: "ignore", reason: "recent-duplicate", albumMbid: "abc-123" });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    level: "debug",
    title: "Ignored: recent-duplicate",
    description: "",
    fields: { albumMbid: "abc-123" },
  });
});

test("a rejected fetch does not throw", async () => {
  const notifier = new Notifier({
    fetch: recordingFetch([], new Error("connect ECONNREFUSED")),
    url: "https://home.lan/hook",
    level: "info",
  });
  await notifier.notify(REQUESTED);
});

test("a 404 from a deleted webhook does not throw", async () => {
  const notifier = new Notifier({
    fetch: recordingFetch([], new Response("gone", { status: 404 })),
    url: "https://discord.com/api/webhooks/1/a",
    level: "info",
  });
  await notifier.notify(REQUESTED);
});

test("an unusable level or format is rejected at construction", () => {
  assert.throws(() => new Notifier({ url: "https://home.lan/hook", level: "verbose" }), /NOTIFY_LEVEL/);
  assert.throws(() => new Notifier({ url: "https://home.lan/hook", format: "slack" }), /NOTIFY_FORMAT/);
});

test("an unparseable NOTIFY_URL throws at construction without leaking the value", () => {
  assert.throws(
    () => new Notifier({ url: "not a url", level: "info" }),
    (error) => {
      assert.match(error.message, /NOTIFY_URL/);
      assert.equal(error.message.includes("not a url"), false);
      return true;
    },
  );
});

test("a result that throws while being read does not throw", async () => {
  const notifier = new Notifier({
    fetch: recordingFetch([]),
    url: "https://home.lan/hook",
    level: "debug",
  });
  await notifier.notify({ get action() { throw new Error("hostile"); } });
});
