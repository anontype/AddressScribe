import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcClient } from "../../src/core/rpc.js";

function response(payload, status = 200, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    text: async () => JSON.stringify(payload)
  };
}

test("JsonRpcClient retries transport and 5xx failures with bounded backoff", async () => {
  const waits = [];
  let calls = 0;
  const client = new JsonRpcClient("https://rpc.example", {
    maxRetries: 1,
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      calls += 1;
      return calls === 1 ? response({}, 503) : response({ jsonrpc: "2.0", id: 1, result: "0x1" });
    }
  });
  assert.equal(await client.request("eth_blockNumber"), "0x1");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [100]);
  assert.equal(client.health(0).status, "healthy");
  assert.equal(client.health(0).failures, 1);
});

test("JsonRpcClient honors Retry-After for 5xx but does not fail over on 4xx", async () => {
  const waits = [];
  let calls = 0;
  const client = new JsonRpcClient(["https://first.example", "https://second.example"], {
    maxRetries: 1,
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      calls += 1;
      return calls === 1 ? response({}, 502, { "retry-after": "2" }) : response({}, 400);
    }
  });
  await assert.rejects(() => client.request("eth_chainId"), (error) => error.code === "RpcHttpError");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("JsonRpcClient stops and reports 429 without trying another endpoint", async () => {
  let calls = 0;
  const client = new JsonRpcClient(["https://limited.example", "https://backup.example"], {
    maxRetries: 4,
    sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      return response({}, 429, { "retry-after": "30" });
    }
  });
  await assert.rejects(() => client.request("eth_chainId"), (error) => {
    assert.equal(error.name, "RpcRateLimitError");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 30000);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(client.health(0).status, "rate-limited");
  assert.equal(client.health(1).status, "unknown");
});

test("JsonRpcClient batch correlates IDs and preserves per-call errors", async () => {
  const client = new JsonRpcClient("https://batch.example", {
    fetch: async (_url, init) => {
      const requests = JSON.parse(init.body);
      return response([
        { jsonrpc: "2.0", id: requests[1].id, result: "ok" },
        { jsonrpc: "2.0", id: requests[0].id, error: { code: -32000, message: "bad params", data: { field: "x" } } }
      ]);
    }
  });
  const results = await client.requestBatch([
    { method: "eth_chainId" },
    { method: "eth_blockNumber", params: ["latest"] }
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, -32000);
  assert.equal(results[0].error.data.field, "x");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].result, "ok");
  assert.notEqual(results[0].id, results[1].id);
});

test("JsonRpcClient enforces response size and redacts endpoint errors", async () => {
  const secret = "super-secret";
  const client = new JsonRpcClient(`https://user:${secret}@rpc.example/v3/${secret}?apiKey=${secret}`, {
    maxRetries: 0,
    maxResponseBytes: 8,
    fetch: async () => response({ jsonrpc: "2.0", id: 1, result: "0123456789" })
  });
  await assert.rejects(() => client.request("eth_chainId"), (error) => error.code === "response_too_large");
  assert.equal(client.endpoints[0].includes(secret), false);
  assert.equal(client.health(0).url.includes(secret), false);

  const transportClient = new JsonRpcClient(`https://user:${secret}@rpc.example`, {
    maxRetries: 0,
    fetch: async () => {
      throw new Error(`failed ${secret} https://user:${secret}@rpc.example`);
    }
  });
  await assert.rejects(() => transportClient.request("eth_chainId"));
  assert.equal(transportClient.health(0).url.includes(secret), false);
});

test("JsonRpcClient times out without waiting for a fetch that never settles", async () => {
  const client = new JsonRpcClient("https://timeout.example", {
    maxRetries: 0,
    timeoutMs: 5,
    fetch: async () => new Promise(() => undefined)
  });
  const started = Date.now();
  await assert.rejects(() => client.request("eth_chainId"));
  assert.ok(Date.now() - started < 1000);
});
