import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointCorruptedError, CheckpointStore } from "../../src/core/checkpoint-store.js";
import { exportCsv, exportJson } from "../../src/core/exporter.js";
import { applyCheckpointComparison } from "../../src/cli.js";

test("checkpoint store writes only cursor/hash/coverage atomically with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-finder-"));
  const path = join(directory, "checkpoint.json");
  try {
    const store = new CheckpointStore(path);
    await store.save({
      cursor: { nextSlot: 12n },
      hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      coverage: { scannedSlots: 12 },
      rpcUrl: "https://example.invalid",
      address: "0x1111111111111111111111111111111111111111"
    });
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ["coverage", "cursor", "hash"]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(text.includes("example.invalid"), false);
    assert.equal(text.includes("1111111111111111111111111111111111111111"), false);
    assert.deepEqual(await store.load(), parsed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint store reports corrupted JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-finder-"));
  const path = join(directory, "checkpoint.json");
  try {
    await writeFile(path, "{broken", "utf8");
    const store = new CheckpointStore(path);
    await assert.rejects(() => store.load(), CheckpointCorruptedError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint key validation does not reject ordinary words containing key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-finder-"));
  const path = join(directory, "checkpoint.json");
  try {
    const store = new CheckpointStore(path);
    await store.save({ cursor: "ok", hash: "hash", coverage: { monkey: "safe", keyboard: "safe", accountKeys: "safe" } });
    assert.deepEqual((await store.load()).coverage, { accountKeys: "safe", keyboard: "safe", monkey: "safe" });
    await assert.rejects(() => store.save({ cursor: { rpcUrl: "https://rpc.example" }, hash: "hash", coverage: {} }));
    await assert.rejects(() => store.save({ cursor: { walletAddress: "opaque" }, hash: "hash", coverage: {} }));
    await assert.rejects(() => store.save({ cursor: { secretKey: "opaque" }, hash: "hash", coverage: {} }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint keeps safe range lineage hashes for both chain families", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-finder-"));
  const path = join(directory, "checkpoint.json");
  try {
    const store = new CheckpointStore(path);
    await store.save({
      cursor: { chain: "solana", headBlockhash: "A11111111111111111111111111111111111111", next: "21" },
      hash: null,
      coverage: { reorgDetected: false }
    });
    assert.equal((await store.load()).cursor.headBlockhash, "A11111111111111111111111111111111111111");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint mode cannot be widened", () => {
  assert.throws(() => new CheckpointStore("/tmp/addressscribe-checkpoint.json", { mode: 0o644 }), /0600/);
});

test("checkpoint comparison marks an overlapping hash change as a reorg", () => {
  const result = {
    results: [{ chain: "ethereum", coverage: { status: "complete", complete: true, partial: false, reasons: [] }, blockEvidence: [{ blockNumber: "10", blockHash: "0xnew" }] }],
    summary: { complete: 1, partial: 0 }
  };
  applyCheckpointComparison(result, { cursor: { chains: [{ chain: "ethereum", to: "10", headHash: "0xold" }] } });
  assert.equal(result.results[0].coverage.reasons.includes("reorg-detected"), true);
  assert.equal(result.summary.partial, 1);
});

test("JSON and CSV exporters are allowlisted, escaped, and deterministic", () => {
  const candidate = {
    chain: "evm",
    address: 'addr,"x"',
    totalFees: 10n,
    evidence: [{ method: 'a,b"c' }],
    raw: { secret: "must-not-export" },
    balance: 999,
    profitability: "high"
  };
  const csv = exportCsv([candidate, { ...candidate, address: "0x0000000000000000000000000000000000000000" }], [
    "address",
    "totalFees",
    "evidence"
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "address,totalFees,evidence");
  assert.ok(lines.some((line) => line.includes('"addr,""x"""')));
  assert.equal(csv.includes("raw"), false);
  assert.equal(csv.includes("balance"), false);
  assert.equal(csv.includes("profitability"), false);
  const json = exportJson([candidate, { ...candidate, address: "0x0000000000000000000000000000000000000000" }], [
    "address",
    "totalFees"
  ]);
  assert.equal(json, exportJson([{ ...candidate, address: "0x0000000000000000000000000000000000000000" }, candidate], [
    "address",
    "totalFees"
  ]));
  assert.equal(json.includes("10n"), false);
  assert.equal(json.includes("raw"), false);
});
