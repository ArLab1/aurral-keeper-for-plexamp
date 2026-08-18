import assert from "node:assert/strict";
import test from "node:test";

import { start, loadConfig } from "../src/bridge.mjs";

const WEBHOOK_SECRET = "test-secret";
const NOTIFY_URL = "http://notify.test/hook";

/**
 * Routes fake fetch calls: anything aimed at the notify URL goes through
 * `notifyImpl`, everything else (Plex, Aurral) gets an innocuous empty-ish
 * response so the flow-job warmup and any `process()` calls succeed quietly.
 */
function makeFetch(notifyImpl) {
  return async (url, options) => {
    const href = String(url);
    if (href.startsWith(NOTIFY_URL)) return notifyImpl(href, options);
    if (href.includes("/api/playlists/status")) {
      return new Response(JSON.stringify({ flows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

function baseConfig(fetchImpl, notifyOverrides = {}) {
  return {
    port: 0,
    maxBodyBytes: 12 * 1024 * 1024,
    webhookSecret: WEBHOOK_SECRET,
    bridge: {
      fetch: fetchImpl,
      plexUrl: "http://plex.test",
      plexToken: "plex-token",
      aurralUrl: "http://aurral.test",
      aurralApiKey: "aurral-key",
    },
    notify: {
      url: NOTIFY_URL,
      level: "debug",
      format: "generic",
      username: "Aurral Keeper",
      ...notifyOverrides,
    },
  };
}

async function startOn(config) {
  const { server, notifier } = await start(config);
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
  });
  const port = server.address().port;
  return { server, notifier, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const IGNORED_PAYLOAD = { event: "media.play", Metadata: { ratingKey: "1" } };

test("loadConfig normalizes a mixed-case NOTIFY_LEVEL and NOTIFY_FORMAT instead of crash-looping", async () => {
  const saved = {
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    PLEX_TOKEN: process.env.PLEX_TOKEN,
    AURRAL_API_KEY: process.env.AURRAL_API_KEY,
    NOTIFY_URL: process.env.NOTIFY_URL,
    NOTIFY_LEVEL: process.env.NOTIFY_LEVEL,
    NOTIFY_FORMAT: process.env.NOTIFY_FORMAT,
  };
  process.env.WEBHOOK_SECRET = "secret";
  process.env.PLEX_TOKEN = "plex-token";
  process.env.AURRAL_API_KEY = "aurral-key";
  process.env.NOTIFY_URL = NOTIFY_URL;
  process.env.NOTIFY_LEVEL = "  WARN  ";
  process.env.NOTIFY_FORMAT = " Generic ";

  try {
    const config = await loadConfig();
    assert.equal(config.notify.level, "warn");
    assert.equal(config.notify.format, "generic");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a notification delivery that rejects still returns the normal status, and the process survives", async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  const fetchImpl = makeFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const { server, baseUrl } = await startOn(baseConfig(fetchImpl));

  try {
    const response = await fetch(`${baseUrl}/plex/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(IGNORED_PAYLOAD),
    });
    assert.equal(response.status, 202);
    await response.text();

    // Give the unawaited notify() promise a turn to surface any rejection.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await closeServer(server);
  }
});

test("a notification delivery that hangs does not delay the HTTP response", async () => {
  let resolveNotify;
  const notifyStarted = new Promise((resolve) => {
    resolveNotify = resolve;
  });
  let notifyResolved = false;
  const pending = new Promise((resolve) => {
    notifyStarted.then(() => {
      // Held open until the test explicitly releases it, below.
      pending.release = () => {
        notifyResolved = true;
        resolve(new Response(null, { status: 204 }));
      };
    });
  });
  const fetchImpl = makeFetch(async () => {
    resolveNotify();
    return pending;
  });
  const { server, baseUrl } = await startOn(baseConfig(fetchImpl));

  try {
    const response = await fetch(`${baseUrl}/plex/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(IGNORED_PAYLOAD),
    });
    assert.equal(response.status, 202);
    await response.text();

    // The response above already arrived; the notify fetch must still be
    // in flight, proving the response did not wait on it.
    assert.equal(notifyResolved, false);
    pending.release();
    await pending;
  } finally {
    await closeServer(server);
  }
});

test("a request that makes the handler throw still posts an error-level notification", async () => {
  const calls = [];
  const fetchImpl = makeFetch(async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 204 });
  });
  const { server, baseUrl } = await startOn(baseConfig(fetchImpl));

  try {
    const response = await fetch(`${baseUrl}/plex/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Malformed JSON: parsePlexWebhook throws inside the request handler's
      // try block, before bridge.process ever runs.
      body: "{not valid json",
    });
    assert.equal(response.status, 500);
    await response.text();

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.level, "error");
    assert.equal(body.title, "Webhook failed");
  } finally {
    await closeServer(server);
  }
});
