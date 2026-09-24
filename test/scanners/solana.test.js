import test from "node:test";
import assert from "node:assert/strict";
import { getChain } from "../../src/config/chains.js";
import { KNOWN_PROGRAM_IDS, scanSolana } from "../../src/scanners/solana.js";

const chain = getChain("solana");
const payer = "A11111111111111111111111111111111111";
const signer = "B11111111111111111111111111111111111";
const failedPayer = "C11111111111111111111111111111111111";
const program = [...KNOWN_PROGRAM_IDS][0];

function transaction(payerAddress, signerAddress, error, fee) {
  return {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: payerAddress, signer: true, writable: true },
          { pubkey: signerAddress, signer: true, writable: false },
          { pubkey: program, signer: false, writable: true }
        ]
      },
      signatures: []
    },
    meta: { err: error, fee }
  };
}

function clientFor(blockTransactions) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "getBlock") return { slot: params[0], blockhash: "blockhash", blockTime: 1700000000, transactions: blockTransactions };
      if (method === "getMultipleAccounts") return { value: params[0].map(() => ({ owner: "11111111111111111111111111111111", executable: false })) };
      throw new Error("unexpected method");
    }
  };
}

test("Solana scanner records signer, fee payer, success, and failure", async () => {
  const client = clientFor([
    transaction(payer, signer, null, 5000),
    transaction(failedPayer, signer, { InstructionError: 0 }, 7000)
  ]);
  const result = await scanSolana({ chain, client, fromSlot: 20, toSlot: 20, concurrency: 2 });
  assert.equal(result.coverage.partial, false);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates.some((candidate) => candidate.address === program), false);
  const successful = result.candidates.find((candidate) => candidate.address === payer);
  const failed = result.candidates.find((candidate) => candidate.address === failedPayer);
  assert.equal(successful.successfulTransactionCount, 1);
  assert.equal(successful.failedTransactionCount, 0);
  assert.equal(successful.totalFees, "5000");
  assert.equal(failed.failedTransactionCount, 1);
  assert.equal(failed.totalFees, "7000");
  assert.equal(result.totals.fees, "12000");
  assert.equal(result.totals.failedFees, "7000");
  const blockCall = client.calls.find((call) => call.method === "getBlock");
  assert.equal(blockCall.params[1].encoding, "jsonParsed");
  assert.equal(typeof blockCall.params[0], "number");
  assert.ok(result.candidates.every((candidate) => candidate.evidence.length > 0));
});

test("Solana classification is bounded to groups of 100", async () => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const signers = Array.from({ length: 101 }, (_, index) => {
    let value = index + 1;
    let suffix = "";
    while (value > 0) {
      suffix = alphabet[value % alphabet.length] + suffix;
      value = Math.floor(value / alphabet.length);
    }
    return `D${suffix.padStart(39, "1")}`;
  });
  const blockTransactions = signers.map((address) => ({
    transaction: { message: { accountKeys: [{ pubkey: address, signer: true, writable: true }] }, signatures: [] },
    meta: { err: null, fee: 1 }
  }));
  const batchSizes = [];
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") return { slot: params[0], blockhash: "hash", blockTime: 1, transactions: blockTransactions };
      throw new Error("method unavailable");
    },
    batch: async (requests) => {
      if (requests.every((request) => request.method === "getMultipleAccounts")) batchSizes.push(requests.length);
      return requests.map((request) => {
        if (request.method === "getBlock") {
          return {
            ok: true,
            result: { slot: request.params[0], blockhash: "hash", blockTime: 1, transactions: blockTransactions }
          };
        }
        return {
          ok: true,
          result: { value: request.params[0].map(() => ({ owner: "11111111111111111111111111111111", executable: false })) }
        };
      });
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 20, toSlot: 20, maxCandidates: 101, maxAccountChecks: 101 });
  assert.deepEqual(batchSizes, [1, 1]);
  assert.equal(result.candidates.length, 101);
  assert.equal(result.coverage.partial, false);
});

test("Solana scanner marks missing classification as partial", async () => {
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") return { slot: params[0], blockhash: "hash", blockTime: 1, transactions: [transaction(payer, signer, null, 1)] };
      throw new Error("method unavailable");
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 20, toSlot: 20 });
  assert.equal(result.coverage.partial, true);
  assert.ok(result.candidates.every((candidate) => candidate.classification === "unknown"));
});

test("Solana scanner preserves token-account classification", async () => {
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") return { slot: params[0], blockhash: "hash", blockTime: 1, transactions: [transaction(payer, signer, null, 1)] };
      if (method === "getMultipleAccounts") return { value: [{ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false }] };
      throw new Error("unexpected method");
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 20, toSlot: 20 });
  assert.equal(result.candidates[0].classification, "token-account");
  assert.equal(result.candidates[0].coverage.complete, true);
});

test("Solana scanner filters vote transactions and reports skipped slots", async () => {
  const voteTransaction = {
    ...transaction(payer, signer, null, 25),
    transaction: {
      ...transaction(payer, signer, null, 25).transaction,
      message: {
        ...transaction(payer, signer, null, 25).transaction.message,
        instructions: [
          { programId: "ComputeBudget111111111111111111111111111111" },
          { programId: "Vote111111111111111111111111111111111111111" }
        ]
      }
    }
  };
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") {
        if (params[0] === 19) return null;
        return { slot: params[0], blockhash: "hash", blockTime: 1, transactions: [transaction(payer, signer, null, 1), voteTransaction] };
      }
      if (method === "getMultipleAccounts") return { value: params[0].map(() => ({ owner: "11111111111111111111111111111111", executable: false })) };
      throw new Error("unexpected method");
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 19, toSlot: 20 });
  assert.equal(result.coverage.reasons.includes("skipped-slots"), true);
  assert.equal(result.coverage.voteTransactionsSkipped, "1");
  assert.equal(result.candidates.some((candidate) => candidate.address === payer), true);
  assert.equal(result.stats.transactions, "1");
});

test("Solana scanner records slot lineage and marks a parent mismatch", async () => {
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") {
        if (params[0] === 20) return { slot: 20, blockhash: "A11111111111111111111111111111111111", previousBlockhash: "B11111111111111111111111111111111111", blockTime: 1, transactions: [] };
        return { slot: 21, blockhash: "C11111111111111111111111111111111111", previousBlockhash: "D11111111111111111111111111111111111", blockTime: 2, transactions: [] };
      }
      throw new Error("unexpected method");
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 20, toSlot: 21 });
  assert.equal(result.coverage.reorgDetected, true);
  assert.equal(result.coverage.reasons.includes("reorg-detected"), true);
  assert.equal(result.blockEvidence[0].previousBlockhash, "B11111111111111111111111111111111111");
  assert.equal(result.range.head.blockhash, "C11111111111111111111111111111111111");
});

test("Solana scanner enforces slot and transaction caps", async () => {
  let calls = 0;
  const client = {
    call: async (method, params) => {
      if (method === "getBlock") {
        calls += 1;
        return {
          slot: params[0],
          blockhash: "hash",
          blockTime: 1,
          transactions: [transaction(payer, signer, null, 1), transaction(failedPayer, signer, {}, 2)]
        };
      }
      return { value: params[0].map(() => ({ owner: "11111111111111111111111111111111", executable: false })) };
    }
  };
  const result = await scanSolana({ chain, client, fromSlot: 18, toSlot: 20, maxSlots: 1, maxTransactions: 1 });
  assert.equal(calls, 1);
  assert.equal(result.coverage.cappedSlots, true);
  assert.equal(result.coverage.cappedTransactions, true);
  assert.equal(result.stats.transactions, "1");
  assert.equal(result.coverage.partial, true);
});
