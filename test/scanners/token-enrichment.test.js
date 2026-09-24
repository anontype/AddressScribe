import test from "node:test";
import assert from "node:assert/strict";
import { getChain } from "../../src/config/chains.js";
import { scanChains } from "../../src/scanners/index.js";
import { enrichTokenBalances, TOKEN_ENRICHMENT_LIMITS, validateTokenEnrichment } from "../../src/scanners/tokens.js";

const ethereum = getChain("ethereum");
const solana = getChain("solana");
const owner = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const mint = "A11111111111111111111111111111111111";

function candidate(address = owner) {
  return { address, activityScore: 10, transactionCount: 1, nativeBalance: null };
}

test("token enrichment reads EVM balanceOf values through a bounded batch", async () => {
  const client = {
    call: async () => { throw new Error("batch-only test client"); },
    batch: async (requests) => requests.map(() => ({ ok: true, result: "0x2a" }))
  };
  const result = await enrichTokenBalances({
    chain: ethereum,
    client,
    candidates: [candidate()],
    tokens: [{ chain: "ethereum", address: token, kind: "erc20", decimals: 0, symbol: "TEST" }]
  });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.candidates[0].tokenBalances[0].raw, "42");
  assert.equal(result.candidates[0].tokenBalances[0].formatted, "42");
  assert.equal(result.candidates[0].tokenBalances[0].confidence, "rpc");
});

test("token enrichment splits large work into bounded batches", async () => {
  const sizes = [];
  const client = {
    call: async () => { throw new Error("batch-only test client"); },
    batch: async (requests) => {
      sizes.push(requests.length);
      return requests.map(() => ({ ok: true, result: "0x1" }));
    }
  };
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(`0x${(index + 1).toString(16).padStart(40, "0")}`));
  const result = await enrichTokenBalances({ chain: ethereum, client, candidates, tokens: [{ chain: "ethereum", address: token, kind: "erc20", decimals: 0 }, { chain: "ethereum", address: "0x3333333333333333333333333333333333333333", kind: "erc20", decimals: 0 }] });
  assert.deepEqual(sizes, [20, 20]);
  assert.equal(result.candidates.length, 20);
  assert.equal(result.coverage.reasons.includes("token-wallet-cap"), true);
});

test("token enrichment falls back to single calls and reports unsupported methods", async () => {
  const calls = [];
  const fallbackClient = {
    call: async (method, params) => {
      calls.push({ method, params });
      return { result: "0x1" };
    }
  };
  const fallback = await enrichTokenBalances({
    chain: ethereum,
    client: fallbackClient,
    candidates: [candidate()],
    tokens: [{ chain: "ethereum", address: token, kind: "erc20", decimals: 0 }]
  });
  assert.equal(calls[0].method, "eth_call");
  assert.equal(fallback.candidates[0].tokenBalances[0].raw, "1");

  const unsupportedClient = {
    call: async () => { throw new Error("batch-only test client"); },
    batch: async () => {
      const error = new Error("method not supported");
      error.code = -32601;
      throw error;
    }
  };
  const unsupported = await enrichTokenBalances({
    chain: ethereum,
    client: unsupportedClient,
    candidates: [candidate()],
    tokens: [{ chain: "ethereum", address: token, kind: "erc721" }]
  });
  assert.equal(unsupported.candidates[0].tokenBalances[0].confidence, "unsupported");
  assert.equal(unsupported.coverage.reasons.includes("token-rpc-unsupported"), true);
});

test("token enrichment reads Solana token-account amounts", async () => {
  const client = {
    call: async (method) => {
      assert.equal(method, "getTokenAccountsByOwner");
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "5000000", decimals: 6 } } } } } }] };
    }
  };
  const result = await enrichTokenBalances({
    chain: solana,
    client,
    candidates: [candidate(mint)],
    tokens: [{ chain: "solana", address: mint, kind: "spl-token", decimals: 6, symbol: "USDC" }]
  });
  assert.equal(result.candidates[0].tokenBalances[0].raw, "5000000");
  assert.equal(result.candidates[0].tokenBalances[0].formatted, "5");
});

test("token enrichment validates addresses and caps the request", () => {
  const tokens = Array.from({ length: TOKEN_ENRICHMENT_LIMITS.tokens + 1 }, () => ({ chain: "ethereum", address: token, kind: "erc20" }));
  assert.throws(() => validateTokenEnrichment({ tokens }), /at most/);
  assert.throws(() => validateTokenEnrichment({ tokens: [{ chain: "ethereum", address: "bad" }] }), /not valid/);
  assert.throws(() => validateTokenEnrichment({ tokens: [{ chain: "ethereum", address: token, decimals: 999 }] }), /0 to 255/);
  assert.throws(() => validateTokenEnrichment({ tokens: [{ chain: "ethereum", address: token, secret: "no" }] }), /unsupported/);
  const normalized = validateTokenEnrichment({ tokens: [{ chain: "ethereum", address: token.toUpperCase(), kind: "nft" }] });
  assert.equal(normalized.tokens[0].address, token);
  assert.equal(normalized.tokens[0].kind, "erc721");
});

test("scanChains keeps token enrichment attached to discovered wallets", async () => {
  const client = {
    call: async (method) => {
      if (method === "eth_chainId") return { result: "0x1" };
      if (method === "eth_blockNumber") return { result: "0x1" };
      if (method === "eth_gasPrice") return { result: "0x1" };
      throw new Error("unexpected call");
    },
    batch: async (requests) => requests.map((request) => {
      if (request.method === "eth_getBlockByNumber") return { ok: true, result: { number: "0x1", hash: "0x" + "11".repeat(32), timestamp: "0x1", transactions: [{ hash: "0x" + "22".repeat(32), from: owner, to: token, value: "0x1", input: "0x" }] } };
      if (request.method === "eth_getCode") return { ok: true, result: "0x" };
      if (request.method === "eth_call") return { ok: true, result: "0x2a" };
      throw new Error("unexpected batch method");
    })
  };
  const result = await scanChains({
    mode: "activity",
    chains: ["ethereum"],
    blocks: 1,
    concurrency: 1,
    limit: 5,
    enrich: { tokens: [{ chain: "ethereum", address: token, kind: "erc20", decimals: 0 }] }
  }, { env: {}, clientFactory: () => client });
  assert.equal(result.wallets[0].tokenBalances.length, 1);
  assert.equal(result.wallets[0].tokenBalances[0].raw, "42");
  assert.equal(result.results[0].tokenEnrichment.complete, true);
});
