import test from "node:test";
import assert from "node:assert/strict";
import { createServer, fixedWindowLimiter } from "../src/server.js";

async function start(options = {}) {
  const server = createServer({
    host: "127.0.0.1",
    env: {},
    scanChains: async (request, context) => {
      await context.onResult?.({
        chain: request.chains[0],
        family: "evm",
        symbol: "ETH",
        coverage: { status: "complete", complete: true, partial: false, reasons: [] },
        candidates: [{ address: "0x1111111111111111111111111111111111111111", activityScore: 50, transactionCount: 2 }]
      });
      return {
        schema: "addressscribe/scan/v1",
        summary: { chains: 1, complete: 1, partial: 0, failed: 0, wallets: 1 },
        wallets: [{ address: "0x1111111111111111111111111111111111111111", activityScore: 50, transactionCount: 2 }],
        results: []
      };
    },
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

const body = {
  mode: "activity",
  chains: ["ethereum"],
  blocks: 2,
  concurrency: 1,
  limit: 50
};

test("server exposes a locked-down static shell and health endpoint", async () => {
  const app = await start();
  try {
    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const health = await fetch(`${app.base}/api/health`).then((response) => response.json());
    assert.equal(health.name, "AddressScribe");
    assert.equal(health.privacy.privateKeyAccess, false);
    assert.equal(health.features.zeroExQuote, false);
    const icon = await fetch(`${app.base}/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    const chains = await fetch(`${app.base}/api/chains`).then((response) => response.json());
    assert.equal(chains.chains.length, 37);
    assert.equal(Object.hasOwn(chains.chains[0], "rpcUrls"), false);
  } finally {
    await app.close();
  }
});

test("server streams chain progress as NDJSON", async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/scan/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "started");
    assert.equal(events[1].type, "chain");
    assert.equal(events.at(-1).type, "complete");
  } finally {
    await app.close();
  }
});

test("server validates scan limits before scanning", async () => {
  let calls = 0;
  const app = await start({ scanChains: async () => { calls += 1; } });
  try {
    const response = await fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, blocks: 51 })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_blocks");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("server validates optional enrichment flags before scanning", async () => {
  let calls = 0;
  const app = await start({ scanChains: async () => { calls += 1; return { wallets: [], results: [] }; } });
  try {
    const invalidEnrichment = await fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, enrich: { tokens: [{ chain: "ethereum", address: "bad" }] } })
    });
    assert.equal(invalidEnrichment.status, 400);
    assert.equal((await invalidEnrichment.json()).error.code, "invalid_enrichment");
    const invalidReceipts = await fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, includeReceipts: "yes" })
    });
    assert.equal(invalidReceipts.status, 400);
    assert.equal((await invalidReceipts.json()).error.code, "invalid_receipts");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("server exposes optional read-only 0x price data without exposing the API key", async () => {
  let upstreamRequest;
  const app = await start({
    zeroExApiKey: "test-0x-api-key-123456",
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return { ok: true, text: async () => JSON.stringify({ price: "123.45", totalNetworkFee: "7", secret: "must-not-leak" }) };
    }
  });
  try {
    const response = await fetch(`${app.base}/api/quote?chainId=1&sellToken=0x1111111111111111111111111111111111111111&buyToken=0x2222222222222222222222222222222222222222&sellAmount=1000`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.quote.price, "123.45");
    assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
    assert.equal(upstreamRequest.options.headers["0x-api-key"], "test-0x-api-key-123456");
    assert.equal(upstreamRequest.options.headers["0x-version"], "v2");
  } finally {
    await app.close();
  }
});

test("0x quote endpoint is disabled without a server-side key", async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/quote?chainId=1&sellToken=0x1111111111111111111111111111111111111111&buyToken=0x2222222222222222222222222222222222222222&sellAmount=1000`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "quote_unavailable");
  } finally {
    await app.close();
  }
});

test("non-loopback mode requires a constant-time token check", async () => {
  const app = await start({ host: "0.0.0.0", token: "test-token-value", allowInsecureLan: true });
  try {
    const denied = await fetch(`${app.base}/api/chains`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${app.base}/api/chains`, { headers: { "X-AddressScribe-Token": "test-token-value" } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get("strict-transport-security"), /includeSubDomains/);
  } finally {
    await app.close();
  }
});

test("server does not expose upstream error secrets", async () => {
  const secret = "super-secret-value";
  const app = await start({ scanChains: async () => { throw new Error(`apiKey=${secret}`); } });
  try {
    const response = await fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(text.includes(secret), false);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await app.close();
  }
});

test("server rate limits protected endpoints with bounded headers", async () => {
  let now = 1000000;
  const app = await start({ rateLimit: 1, rateWindowMs: 60000, clock: () => now });
  try {
    const first = await fetch(`${app.base}/api/chains`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("ratelimit-limit"), "1");
    assert.equal(first.headers.get("ratelimit-remaining"), "0");
    assert.equal(first.headers.get("ratelimit-reset"), "60");
    const second = await fetch(`${app.base}/api/chains`);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "60");
    assert.equal(second.headers.get("content-security-policy").includes("default-src 'self'"), true);
  } finally {
    now += 60000;
    await app.close();
  }
});

test("fixed-window limiter evicts old keys instead of growing without bound", () => {
  let now = 0;
  const consume = fixedWindowLimiter(1, 60000, () => now, 1);
  assert.equal(consume("a").allowed, true);
  assert.equal(consume("b").allowed, true);
  assert.equal(consume("a").allowed, true);
  now = 60000;
  assert.equal(consume("a").allowed, true);
});

test("server times out and aborts an uncooperative scan", async () => {
  let release;
  let aborted = false;
  const app = await start({
    scanTimeoutMs: 100,
    scanChains: async (_request, { signal }) => new Promise((resolve) => {
      release = resolve;
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ schema: "addressscribe/scan/v1", wallets: [], results: [] });
      }, { once: true });
    })
  });
  try {
    const response = await fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "scan_timeout");
    assert.equal(aborted, true);
  } finally {
    release?.();
    await app.close();
  }
});

test("server graceful close aborts active scans and resolves", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  const app = await start({
    scanChains: async (_request, { signal }) => new Promise((resolve) => {
      started();
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ schema: "addressscribe/scan/v1", wallets: [], results: [] });
      }, { once: true });
    })
  });
  try {
    const request = fetch(`${app.base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    await startedPromise;
    const closePromise = app.server.gracefulClose(1000);
    const response = await request;
    await closePromise;
    assert.equal(aborted, true);
    assert.equal(response.status, 503);
    assert.equal(app.server.listening, false);
  } finally {
    await app.server.gracefulClose(1000);
  }
});
