#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CHAIN_REGISTRY, publicChain } from "./config/chains.js";
import { CheckpointStore } from "./core/checkpoint-store.js";
import { scanChains } from "./scanners/index.js";
import { sanitizeErrorText } from "./core/privacy.js";
import { startServer } from "./server.js";

const options = {
  help: { type: "boolean", short: "h" },
  chain: { type: "string", short: "c", multiple: true },
  token: { type: "string", multiple: true },
  receipts: { type: "boolean", default: false },
  traces: { type: "boolean", default: false },
  mode: { type: "string", default: "activity" },
  blocks: { type: "string", short: "b", default: "2" },
  concurrency: { type: "string", default: "4" },
  limit: { type: "string", short: "n", default: "50" },
  format: { type: "string", short: "f", default: "json" },
  output: { type: "string", short: "o" },
  stateFile: { type: "string" },
  host: { type: "string" },
  port: { type: "string", short: "p" },
  allowInsecureLan: { type: "boolean", default: false },
  json: { type: "boolean", default: false }
};

function usage() {
  return `AddressScribe — read-only public chain finder

Commands:
  addressscribe chains [--json]
  addressscribe scan [--chain <id>] [--mode activity|balances|multichain]
  addressscribe serve [--host 127.0.0.1] [--port 4173] [--allow-insecure-lan]

Scan options:
  -c, --chain <id>       Chain id or "all"; repeat for multiple chains
      --token <spec>     Optional token: chain:address[:kind[:decimals]]
      --receipts         Read EVM transaction receipts when the RPC supports them
      --traces           Read EVM internal calls when the RPC supports trace_block
  -b, --blocks <number>  Recent blocks or slots, 1..50
      --concurrency <n>  Parallel chains, 1..8
  -n, --limit <number>   Maximum wallets, 1..100
  -f, --format <type>    json, jsonl, csv or none
  -o, --output <path>    Write to a file instead of stdout
      --state-file <path> Save safe scan range metadata

Privacy:
  Read-only RPC only. No wallet input, key generation, signing or telemetry.
`;
}

function integer(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
}

function selectedChains(values) {
  if (!values?.length) return ["ethereum"];
  if (values.includes("all")) return CHAIN_REGISTRY.map((chain) => chain.id);
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

function selectedTokens(values) {
  return (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean).map((value) => {
    const [chain, address, kind, decimals] = value.split(":");
    if (!chain || !address) throw new RangeError("Token must use chain:address[:kind[:decimals]]");
    return { chain, address, ...(kind ? { kind } : {}), ...(decimals ? { decimals } : {}) };
  });
}

function csvValue(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(result) {
  const fields = ["address", "chain", "activityScore", "transactionCount", "internalTransactionCount", "internalValue", "nativeBalanceFormatted", "classification", "coverage", "tokenBalances", "tokenEnrichment"];
  const lines = [fields.join(",")];
  for (const wallet of result.wallets) {
    const chainNames = Array.isArray(wallet.chains) && wallet.chains.length ? wallet.chains.join("+") : (wallet.chainDetails?.[0]?.chain ?? wallet.chain);
    const balances = Array.isArray(wallet.nativeBalances) && wallet.nativeBalances.length
      ? wallet.nativeBalances.map((item) => `${item.formatted ?? "?"} ${item.symbol}`).join(";")
      : (wallet.nativeBalanceFormatted ?? wallet.chainDetails?.[0]?.nativeBalanceFormatted);
    const symbol = wallet.symbol ?? wallet.chainDetails?.[0]?.symbol;
    lines.push([wallet.address, chainNames, wallet.activityScore, wallet.transactionCount, wallet.internalTransactionCount ?? null, wallet.internalValue ?? null, balances ?? (symbol && wallet.nativeBalanceFormatted ? `${wallet.nativeBalanceFormatted} ${symbol}` : null), wallet.classification, JSON.stringify(wallet.coverage), JSON.stringify(wallet.tokenBalances ?? []), JSON.stringify(wallet.tokenEnrichment ?? null)].map(csvValue).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function render(result, format) {
  if (format === "none") return "";
  if (format === "csv") return csv(result);
  if (format === "jsonl") return result.wallets.map((wallet) => JSON.stringify(wallet)).join("\n") + (result.wallets.length ? "\n" : "");
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  throw new RangeError("format must be json, jsonl, csv or none");
}

async function output(value, path) {
  if (!path) {
    if (value) process.stdout.write(value);
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  process.stderr.write(`Saved ${path}\n`);
}

function checkpointFor(result) {
  const chains = result.results.map((item) => ({
    chain: item.chain,
    unit: item.range?.unit ?? null,
    from: item.range?.from ?? null,
    to: item.range?.to ?? null,
    next: item.range?.to == null ? null : (BigInt(item.range.to) + 1n).toString(),
    headHash: item.range?.head?.hash ?? item.range?.head?.blockhash ?? null,
    parentHash: item.range?.head?.parentHash ?? item.range?.head?.previousBlockhash ?? null,
    commitment: item.range?.head?.commitment ?? null
  }));
  return {
    cursor: { version: 1, chains },
    hash: chains.length === 1 ? chains[0].headHash : null,
    coverage: {
      summary: result.summary,
      reorgDetected: result.results.some((item) => item.coverage?.reorgDetected === true)
    }
  };
}

export function applyCheckpointComparison(result, previous) {
  const previousChains = Array.isArray(previous?.cursor?.chains) ? previous.cursor.chains : [];
  if (!previousChains.length) return;
  let compared = 0;
  for (const item of result.results) {
    const prior = previousChains.find((entry) => entry.chain === item.chain);
    if (!prior?.headHash || prior.to == null) continue;
    const current = (item.blockEvidence ?? []).find((entry) => String(entry.blockNumber ?? entry.slot) === String(prior.to));
    const currentHash = current?.blockHash ?? current?.blockhash;
    if (!currentHash) continue;
    compared += 1;
    if (currentHash !== prior.headHash) {
      item.coverage ??= { status: "partial", complete: false, partial: true, reasons: [] };
      item.coverage.reasons = [...new Set([...item.coverage.reasons, "reorg-detected"])].sort();
      item.coverage.partial = true;
      item.coverage.complete = false;
      item.coverage.status = "partial";
    }
  }
  if (compared) {
    result.summary.partial = result.results.filter((item) => item.coverage?.partial).length;
    result.summary.complete = result.results.filter((item) => item.coverage?.complete).length;
  }
}

async function saveCheckpoint(store, result) {
  await store.save(checkpointFor(result));
  process.stderr.write(`Saved checkpoint ${store.path}\n`);
}

async function commandChains(values) {
  const { values: parsed } = parseArgs({ args: values, options, allowPositionals: false });
  const chains = CHAIN_REGISTRY.map(publicChain);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ chains }, null, 2)}\n`);
    return;
  }
  for (const chain of chains) {
    const zeroEx = chain.zeroEx.supported ? "0x" : "—";
    process.stdout.write(`${chain.id.padEnd(15)} ${chain.family.toUpperCase().padEnd(4)} ${String(chain.chainId).padEnd(12)} ${chain.symbol.padEnd(6)} ${zeroEx}\n`);
  }
}

async function commandScan(values) {
  const { values: parsed } = parseArgs({ args: values, options, allowPositionals: false });
  if (!["json", "jsonl", "csv", "none"].includes(parsed.format)) throw new RangeError("format must be json, jsonl, csv or none");
  const tokens = selectedTokens(parsed.token);
  const checkpointStore = parsed.stateFile ? new CheckpointStore(parsed.stateFile) : null;
  const previousCheckpoint = checkpointStore ? await checkpointStore.load() : null;
  const request = {
    mode: parsed.mode,
    chains: selectedChains(parsed.chain),
    blocks: integer(parsed.blocks, 1, 50, "blocks"),
    concurrency: integer(parsed.concurrency, 1, 8, "concurrency"),
    limit: integer(parsed.limit, 1, 100, "limit"),
    ...(parsed.receipts ? { includeReceipts: true } : {}),
    ...(parsed.traces ? { includeTraces: true } : {}),
    ...(tokens.length ? { enrich: { tokens } } : {})
  };
  const result = await scanChains(request, {
    onProgress(progress) {
      if (process.stderr.isTTY && progress.phase !== "starting") process.stderr.write(`\r${progress.chain} ${progress.phase} ${progress.completed}/${progress.total}`.padEnd(76));
    }
  });
  if (process.stderr.isTTY) process.stderr.write("\r\u001b[2K");
  if (previousCheckpoint) applyCheckpointComparison(result, previousCheckpoint);
  if (checkpointStore) await saveCheckpoint(checkpointStore, result);
  await output(render(result, parsed.format), parsed.output);
}

async function commandServe(values) {
  const { values: parsed } = parseArgs({ args: values, options, allowPositionals: false });
  const host = parsed.host ?? process.env.ADDRESSSCRIBE_HOST ?? "127.0.0.1";
  const port = integer(parsed.port ?? process.env.ADDRESSSCRIBE_PORT ?? process.env.PORT ?? "4173", 1, 65535, "port");
  const allowInsecureLan = parsed.allowInsecureLan || /^(?:1|true|yes)$/i.test(process.env.ADDRESSSCRIBE_ALLOW_INSECURE_LAN ?? "");
  const server = startServer({ host, port, allowInsecureLan, env: process.env });
  server.once("error", (error) => {
    process.stderr.write(`AddressScribe: ${sanitizeErrorText(error)}\n`);
    process.exitCode = 1;
  });
  const shutdown = () => server.gracefulClose().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(usage());
    return;
  }
  const [command, ...values] = args;
  if (command === "chains") return commandChains(values);
  if (command === "scan") return commandScan(values);
  if (command === "serve") return commandServe(values);
  throw new RangeError(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`AddressScribe: ${sanitizeErrorText(error)}\n`);
    process.exitCode = 1;
  });
}
