import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, scoreCandidate, toJsonSafe } from "../../src/core/ranker.js";

test("ranking is deterministic for equal activity", () => {
  const first = rankCandidates([
    { chain: "evm", address: "0xbbbb", transactionCount: 2 },
    { chain: "evm", address: "0xaaaa", transactionCount: 2 },
    { chain: "solana", address: "b", transactionCount: 2 }
  ]);
  const second = rankCandidates([
    { chain: "solana", address: "b", transactionCount: 2 },
    { chain: "evm", address: "0xaaaa", transactionCount: 2 },
    { chain: "evm", address: "0xbbbb", transactionCount: 2 }
  ]);
  assert.deepEqual(first.map((item) => `${item.chain}:${item.address}`), second.map((item) => `${item.chain}:${item.address}`));
  assert.deepEqual(first.map((item) => item.address), ["0xaaaa", "0xbbbb", "b"]);
});

test("contracts are penalized and BigInts serialize as strings", () => {
  const eoa = scoreCandidate({ address: "0x1", transactionCount: 4, classification: "eoa", totalValue: 10n });
  const contract = scoreCandidate({ address: "0x2", transactionCount: 4, classification: "contract", totalValue: 10n });
  assert.ok(eoa > contract);
  const candidate = rankCandidates([{ address: "0x1", transactionCount: 1, totalFees: 12n }])[0];
  assert.equal(candidate.totalFees, "12");
  assert.equal(JSON.stringify(toJsonSafe({ value: 12n, nested: [3n] })), '{"nested":["3"],"value":"12"}');
  assert.equal("balance" in candidate, false);
  assert.equal("profitability" in candidate, false);
});
