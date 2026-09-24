import test from "node:test";
import assert from "node:assert/strict";
import { getChain } from "../../src/config/chains.js";
import { scanEvm } from "../../src/scanners/evm.js";

const chain = getChain("ethereum");
const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const contract = "0x3333333333333333333333333333333333333333";

function block(number, transactions) {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${String(number).repeat(64).slice(0, 64)}`,
    timestamp: `0x${(1700000000 + number).toString(16)}`,
    transactions
  };
}

function transaction(number, from, to) {
  return {
    hash: `0x${String(number).repeat(64).slice(0, 64)}`,
    from,
    to,
    value: "0x10",
    gas: "0x2",
    gasUsed: "0x1",
    gasPrice: "0x3",
    input: "0xabcdef010203"
  };
}

test("EVM scanner batches public activity and excludes contracts", async () => {
  const calls = [];
  const client = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "eth_getBlockByNumber") {
        const number = Number(BigInt(params[0]));
        return block(number, [transaction(number, sender, recipient), transaction(number + 10, sender, contract)]);
      }
      if (method === "eth_getCode") return params[0] === contract ? "0x6000" : "0x";
      throw new Error("unexpected method");
    }
  };
  const result = await scanEvm({ chain, client, fromBlock: 1, toBlock: 1, concurrency: 2 });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.coverage.partial, false);
  assert.deepEqual(result.candidates.map((item) => item.address), [sender, recipient]);
  assert.equal(result.candidates[0].totalValue, "32");
  assert.equal(result.candidates[0].totalFees, "6");
  assert.deepEqual(result.candidates[0].methods, ["0xabcdef01"]);
  assert.equal(result.candidates[0].evidence[0].blockNumber, "1");
  assert.equal(result.blockEvidence[0].blockNumber, "1");
  assert.equal(calls.filter((call) => call.method === "eth_getCode").length, 3);
  assert.equal(calls.some((call) => /send|sign|generate/i.test(call.method)), false);
});

test("EVM scanner keeps unknown classification and reports partial coverage", async () => {
  const client = {
    call: async (method, params) => {
      if (method === "eth_getBlockByNumber") return block(Number(BigInt(params[0])), [transaction(1, sender, recipient)]);
      if (method === "eth_getCode") throw new Error("method unavailable");
      throw new Error("unexpected method");
    }
  };
  const result = await scanEvm({ chain, client, fromBlock: 1, toBlock: 1 });
  assert.equal(result.coverage.partial, true);
  assert.ok(result.coverage.reasons.includes("unknown-classification"));
  assert.ok(result.candidates.every((candidate) => candidate.classification === "unknown"));
  assert.ok(result.candidates.every((candidate) => candidate.coverage.partial));
});

test("EVM self-transfer does not create a self-counterparty or volume", async () => {
  const client = {
    call: async (method) => {
      if (method === "eth_getBlockByNumber") return block(1, [transaction(1, sender, sender)]);
      if (method === "eth_getCode") return "0x";
      throw new Error("unexpected method");
    }
  };
  const result = await scanEvm({ chain, client, fromBlock: 1, toBlock: 1 });
  const wallet = result.candidates.find((item) => item.address === sender);
  assert.equal(wallet.uniqueCounterpartyCount, 0);
  assert.equal(wallet.totalValue, "0");
  assert.equal(wallet.sentTransactionCount, 0);
  assert.equal(wallet.receivedTransactionCount, 0);
});

test("EVM classification marks unclassified tail candidates as partial", async () => {
  const third = "0x4444444444444444444444444444444444444444";
  const client = {
    call: async (method, params) => {
      if (method === "eth_getBlockByNumber") return block(1, [transaction(1, sender, recipient), transaction(2, sender, third)]);
      if (method === "eth_getCode") {
        if (params[0] === sender) return "0x";
        throw new Error("classification unavailable");
      }
      throw new Error("unexpected method");
    }
  };
  const result = await scanEvm({ chain, client, fromBlock: 1, toBlock: 1, maxCodeChecks: 1 });
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.reasons.includes("unknown-classification"), true);
  assert.ok(result.candidates.some((item) => item.classification === "unknown"));
});

test("EVM scanner enforces range, transaction, and concurrency caps", async () => {
  let active = 0;
  let maximumActive = 0;
  let blockCalls = 0;
  const client = {
    call: async (method, params) => {
      if (method === "eth_getBlockByNumber") {
        blockCalls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return block(Number(BigInt(params[0])), [transaction(Number(BigInt(params[0])), sender, recipient)]);
      }
      return "0x";
    }
  };
  const result = await scanEvm({ chain, client, fromBlock: 1, toBlock: 5, maxBlocks: 2, maxTransactions: 1, concurrency: 2 });
  assert.equal(blockCalls, 2);
  assert.ok(maximumActive <= 2);
  assert.equal(result.coverage.cappedBlocks, true);
  assert.equal(result.coverage.cappedTransactions, true);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.stats.transactions, "1");
});
