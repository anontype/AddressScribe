import test from "node:test";
import assert from "node:assert/strict";
import { getChain } from "../../src/config/chains.js";
import { scanChains } from "../../src/scanners/index.js";

const address = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";

function evmBlock(number) {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    timestamp: "0x65000000",
    transactions: [{
      hash: `0x${number.toString(16).padStart(64, "0")}`,
      from: address,
      to: recipient,
      value: "0x1",
      gas: "0x5208",
      gasUsed: "0x5208",
      gasPrice: "0x3b9aca00",
      input: "0x"
    }]
  };
}

function evmClient(chainId = 1, balance = "1000000000000000000") {
  return {
    call: async (method) => {
      if (method === "eth_chainId") return { result: `0x${chainId.toString(16)}` };
      if (method === "eth_blockNumber") return { result: "0x64" };
      if (method === "eth_gasPrice") return { result: "0x3b9aca00" };
      throw new Error("unexpected call");
    },
    batch: async (requests) => requests.map((request) => {
      if (request.method === "eth_getBlockByNumber") return { ok: true, result: evmBlock(Number(BigInt(request.params[0]))) };
      if (request.method === "eth_getCode") return { ok: true, result: "0x" };
      if (request.method === "eth_getBalance") return { ok: true, result: balance };
      throw new Error("unexpected batch method");
    })
  };
}

test("multichain mode merges the same EVM address across chains", async () => {
  const streamed = [];
  const result = await scanChains({
    mode: "multichain",
    chains: ["base", "optimism"],
    blocks: 2,
    concurrency: 2,
    limit: 20
  }, {
    env: {},
    clientFactory: (chain) => evmClient(chain.chainId),
    onResult: (chainResult) => streamed.push(chainResult.chain)
  });
  assert.deepEqual(streamed.sort(), ["base", "optimism"]);
  const wallet = result.wallets.find((item) => item.address === address);
  assert.ok(wallet);
  assert.deepEqual(wallet.chains.sort(), ["base", "optimism"]);
  assert.equal(wallet.chainCount, 2);
  assert.equal(result.results.length, 2);
});

test("balances mode enriches and sorts already discovered addresses", async () => {
  const result = await scanChains({
    mode: "balances",
    chains: ["ethereum"],
    blocks: 2,
    concurrency: 1,
    limit: 20
  }, {
    env: {},
    clientFactory: (chain) => evmClient(chain.chainId, "2000000000000000000")
  });
  assert.equal(result.wallets[0].address, address);
  assert.equal(result.wallets[0].nativeBalance, "2000000000000000000");
  assert.equal(result.wallets[0].nativeBalanceFormatted, "2");
  assert.equal(result.wallets[0].balanceConfidence, "rpc");
  assert.equal(result.results[0].gas.formatted, "1 gwei");
});

test("Solana runs through the same bounded scan contract", async () => {
  const wallet = "A11111111111111111111111111111111111";
  const solana = getChain("solana");
  const client = {
    call: async (method) => {
      if (method === "getSlot") return { result: 20 };
      if (method === "getRecentPrioritizationFees") return { result: [1000, 2000, 3000] };
      throw new Error("unexpected call");
    },
    batch: async (requests) => requests.map((request) => {
      if (request.method === "getBlock") return {
        ok: true,
        result: {
          slot: paramsValue(request.params[0]),
          blockhash: "blockhash",
          blockTime: 1700000000,
          transactions: [{
            transaction: { message: { accountKeys: [{ pubkey: wallet, signer: true, writable: true }] }, signatures: [] },
            meta: { err: null, fee: 5000 }
          }]
        }
      };
      if (request.method === "getMultipleAccounts") return {
        ok: true,
        result: { value: request.params[0].map(() => ({ owner: "11111111111111111111111111111111", executable: false })) }
      };
      throw new Error("unexpected batch method");
    })
  };
  const result = await scanChains({
    mode: "activity",
    chains: [solana.id],
    blocks: 2,
    concurrency: 1,
    limit: 20
  }, {
    env: {},
    clientFactory: () => client
  });
  assert.equal(result.wallets[0].address, wallet);
  assert.equal(result.wallets[0].chain, "solana");
  assert.equal(result.results[0].gas.unit, "micro-lamports/CU");
});

test("scanChains reports a chain-id mismatch as partial coverage", async () => {
  const result = await scanChains({
    mode: "activity",
    chains: ["ethereum"],
    blocks: 1,
    concurrency: 1,
    limit: 10
  }, {
    env: {},
    clientFactory: () => ({
      call: async (method) => {
        if (method === "eth_chainId") return { result: "0x539" };
        throw new Error("unexpected call");
      }
    })
  });
  assert.equal(result.results[0].coverage.reasons.includes("chain-mismatch"), true);
  assert.equal(result.results[0].candidates.length, 0);
  assert.equal(result.summary.failed, 1);
});

function paramsValue(value) {
  return value;
}
