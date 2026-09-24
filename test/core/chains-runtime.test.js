import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_REGISTRY,
  EVM_CHAINS,
  SVM_CHAINS,
  getChain,
  publicChain
} from "../../src/config/chains.js";
import { getRuntimeConfig, parseRpcOverrides } from "../../src/config/runtime.js";

test("registry is immutable, HTTP-only, and exposes EVM plus Solana metadata", () => {
  assert.equal(EVM_CHAINS.length, 36);
  assert.equal(SVM_CHAINS.length, 1);
  assert.equal(CHAIN_REGISTRY.length, 37);
  assert.equal(EVM_CHAINS.filter((chain) => chain.zeroEx.supported).length, 22);
  assert.equal(SVM_CHAINS[0].id, "solana");
  assert.equal(SVM_CHAINS[0].rangeUnit, "slots");
  assert.equal(SVM_CHAINS[0].gasUnit, "micro-lamports/CU");
  assert.equal(SVM_CHAINS[0].zeroEx.supported, true);
  assert.equal(SVM_CHAINS[0].zeroEx.swapApi, true);
  assert.equal(getChain("arc").zeroEx.supported, true);
  assert.equal(getChain("arc").zeroEx.gaslessApi, false);
  assert.equal(getChain("arc").gasDecimals, 18);
  assert.equal(getChain("arc").gasUnit, "USDC");
  assert.equal(getChain("tempo").gasDecimals, 6);
  assert.equal(getChain("tempo").gasUnit, "TIP-20");
  assert.equal(getChain("tempo").nativeBalance, false);
  assert.equal(getChain("tempo").gasToken, "TIP-20");
  assert.ok(Object.isFrozen(CHAIN_REGISTRY));
  assert.ok(Object.isFrozen(EVM_CHAINS[0].rpcUrls));
  assert.throws(() => EVM_CHAINS[0].rpcUrls.push("https://invalid.example"));
  for (const chain of CHAIN_REGISTRY) {
    assert.ok(chain.rpcUrls.length > 0);
    assert.ok(chain.rpcUrls.every((url) => /^https?:\/\//i.test(url)));
    assert.equal(chain.rpcUrls.some((url) => /^wss?:\/\//i.test(url)), false);
    assert.equal(chain.rpcUrls.some((url) => /[?&](?:api[-_]?key|apikey|access[-_]?token|auth|secret|password|private[-_]?key|token)=/i.test(url)), false);
    assert.equal(chain.explorerUrl === null || /^https:\/\//i.test(chain.explorerUrl), true);
    assert.equal(chain.readOnly, true);
    assert.equal(chain.capabilities.execution, "disabled");
  }
  const exposed = publicChain(getChain("base"));
  assert.equal(Object.hasOwn(exposed, "rpcUrls"), false);
  assert.equal(exposed.capabilities.discovery, "read-only");
});

test("runtime uses safe env names, applies JSON and slug RPC overrides, and stays bounded", () => {
  const forbidden = /PRIVATE_KEY|SEED|MNEMONIC/i;
  const values = {
    ADDRESSSCRIBE_CHAIN: "base",
    ADDRESSSCRIBE_BLOCKS: "10",
    ADDRESSSCRIBE_CONCURRENCY: "4",
    ADDRESSSCRIBE_TIMEOUT_MS: "1000",
    ADDRESSSCRIBE_OUTPUT: "jsonl",
    ADDRESSSCRIBE_STATE_FILE: "/tmp/state.json",
    BASE_RPC_URL: "https://user:secret@rpc.example/v3/private?apiKey=token",
    ADDRESSSCRIBE_RPC_URLS: JSON.stringify({ 1: "https://json.example/ethereum" })
  };
  const env = new Proxy(values, {
    get(target, key) {
      if (typeof key === "string" && forbidden.test(key)) throw new Error("forbidden environment name accessed");
      return target[key];
    }
  });
  const config = getRuntimeConfig({ env });
  assert.equal(config.chain, "base");
  assert.equal(config.blocks, 10);
  assert.equal(config.concurrency, 4);
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.output, "jsonl");
  assert.equal(config.stateFile, "/tmp/state.json");
  assert.equal(config.rpcUrls[0], "https://user:secret@rpc.example/v3/private?apiKey=token");
  assert.equal(config.redactedRpcUrls.some((url) => url.includes("secret") || url.includes("token")), false);
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.equal(config.readOnly, true);
  assert.equal(config.execution, false);
  assert.equal(config.browserPersistence, false);
  assert.equal(config.telemetry, false);
  assert.equal(config.cookies, false);
  assert.deepEqual(parseRpcOverrides({ base: ["https://base.example"] }), { base: ["https://base.example"] });
});

test("runtime selects Solana slots and keeps the state file opt-in", () => {
  const config = getRuntimeConfig({ chain: "solana", env: { ADDRESSSCRIBE_SLOTS: "50" } });
  assert.equal(config.kind, "svm");
  assert.equal(config.blocks, null);
  assert.equal(config.slots, 50);
  assert.equal(config.range.unit, "slots");
  assert.equal(config.stateFile, null);
  assert.equal(getChain("solana").rpcUrls[0], "https://solana-rpc.publicnode.com");
});

test("runtime rejects out-of-range values instead of silently clamping them", () => {
  assert.throws(() => getRuntimeConfig({ env: { ADDRESSSCRIBE_BLOCKS: "999" } }), /between 1 and 50/);
  assert.throws(() => getRuntimeConfig({ env: { ADDRESSSCRIBE_OUTPUT: "yaml" } }), /Output format/);
  assert.throws(() => getRuntimeConfig({ output: 1 }), /Output format must be a string/);
});
