import test from "node:test";
import assert from "node:assert/strict";
import { getRuntimeConfig } from "../../src/config/runtime.js";
import { readServerConfig } from "../../src/server.js";
import { redactData, sanitizeErrorText } from "../../src/core/privacy.js";
import { JsonRpcClient } from "../../src/core/rpc.js";

test("server env config is explicit, bounded, and fails closed off-loopback", () => {
  const defaults = readServerConfig({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.secure, false);
  assert.throws(() => readServerConfig({ ADDRESSSCRIBE_HOST: "0.0.0.0" }), /ADDRESSSCRIBE_TOKEN/);
  assert.throws(() => readServerConfig({ ADDRESSSCRIBE_HOST: "0.0.0.0", ADDRESSSCRIBE_TOKEN: "local-test-token" }), /HTTPS reverse proxy/);
  assert.throws(() => readServerConfig({ ADDRESSSCRIBE_RATE_LIMIT: "0" }), /ADDRESSSCRIBE_RATE_LIMIT/);
  assert.throws(() => readServerConfig({ ADDRESSSCRIBE_HOST: "bad host" }), /ADDRESSSCRIBE_HOST/);
  assert.equal(readServerConfig({ ADDRESSSCRIBE_HOST: "0.0.0.0", ADDRESSSCRIBE_TOKEN: "local-test-token", ADDRESSSCRIBE_ALLOW_INSECURE_LAN: "1" }).secure, true);
});

test("runtime env parsing rejects malformed values and redacts RPC credentials", () => {
  assert.throws(() => getRuntimeConfig({ env: { ADDRESSSCRIBE_CONCURRENCY: "not-a-number" } }), /integer/);
  const config = getRuntimeConfig({ chain: "base", env: { BASE_RPC_URL: "https://user:pass@rpc.example/private?token=hidden" } });
  assert.equal(config.rpcUrls[0].includes("pass"), true);
  assert.equal(JSON.stringify(config).includes("pass"), false);
  assert.equal(config.redactedRpcUrls.some((url) => url.includes("hidden")), false);
});

test("privacy redaction removes sensitive object fields and unlabeled credentials", () => {
  const value = redactData({ token: "hidden", credentials: "hidden", safe: "visible" });
  assert.equal(JSON.stringify(value).includes("hidden"), false);
  assert.equal(value.safe, "visible");
  const message = sanitizeErrorText("password=hidden Bearer hidden");
  assert.equal(message.includes("hidden"), false);
});

test("RPC options reject excessive endpoints and fractional bounds", () => {
  assert.throws(() => new JsonRpcClient(Array.from({ length: 17 }, (_, index) => `https://rpc-${index}.example`), { fetch: async () => ({}) }), /at most 16/);
  assert.throws(() => new JsonRpcClient("https://rpc.example", { maxRetries: 1.5, fetch: async () => ({}) }), /finite integers/);
});

test("RPC retry backoff stops promptly when aborted", async () => {
  const controller = new AbortController();
  let sleeps = 0;
  const client = new JsonRpcClient("https://abort.example", {
    maxRetries: 5,
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "{}" }),
    sleep: async () => { sleeps += 1; }
  });
  const pending = client.call("eth_blockNumber", [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.name === "AbortError");
  assert.ok(sleeps <= 1);
});
