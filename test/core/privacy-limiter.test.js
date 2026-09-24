import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, createTokenBucket } from "../../src/core/limiter.js";
import { redactData, redactUrl, sanitizeErrorText } from "../../src/core/privacy.js";

test("privacy helpers redact URL credentials and sensitive query values", () => {
  const value = redactUrl("https://alice:password@rpc.example/v3/private-key?apiKey=query-secret&region=eu");
  assert.equal(value.includes("alice"), false);
  assert.equal(value.includes("password"), false);
  assert.equal(value.includes("private-key"), false);
  assert.equal(value.includes("query-secret"), false);
  assert.equal(value.includes("region=eu"), false);
  assert.equal(redactUrl("https://rpc.example/public"), "https://rpc.example/public");
  assert.equal(redactUrl("https://rpc.example/v3/private-key/rpc"), "https://rpc.example/v3/<redacted>/rpc");
});

test("privacy sanitization is allowlist based", () => {
  const message = sanitizeErrorText(
    "request failed: apiKey=query-secret url=https://user:pass@rpc.example/v3/key?token=hidden requestId=req-1"
  );
  assert.equal(message.includes("query-secret"), false);
  assert.equal(message.includes("user:pass"), false);
  assert.equal(message.includes("hidden"), false);
  assert.equal(message.includes("req-1"), true);
  assert.equal(sanitizeErrorText("chainId=1 method=eth_blockNumber"), "chainId=1 method=eth_blockNumber");
  const data = redactData({ rpcUrl: "https://u:p@rpc.example/key?apiKey=secret", label: "safe" });
  assert.equal(JSON.stringify(data).includes("secret"), false);
  assert.equal(data.label, "safe");
});

test("TokenBucket validates options and refills at the configured rate", () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 2, refillRate: 1, clock: () => now });
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false);
  now = 1000;
  assert.equal(bucket.tryConsume(), true);
  assert.throws(() => new TokenBucket({ capacity: 0, refillRate: 1 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: Number.NaN }), TypeError);
  assert.throws(() => bucket.tryConsume(3), RangeError);
});

test("TokenBucket acquire waits using injected sleep and clock", async () => {
  let now = 0;
  const waits = [];
  const bucket = new TokenBucket({
    capacity: 1,
    refillRate: 2,
    tokens: 0,
    clock: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    }
  });
  assert.equal(await bucket.acquire(), true);
  assert.deepEqual(waits, [500]);
  assert.equal(bucket.tokens, 0);
});
