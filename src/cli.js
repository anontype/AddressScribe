#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { CHAIN_REGISTRY, publicChain } from "./config/chains.js";
import { scanChains } from "./scanners/index.js";
import { sanitizeErrorText } from "./core/privacy.js";
import { startServer } from "./server.js";

const options = {
  help: { type: "boolean", short: "h" },
  chain: { type: "string", short: "c", multiple: true },
  mode: { type: "string", default: "activity" },
  blocks: { type: "string", short: "b", default: "2" },
  concurrency: { type: "string", default: "4" },
  limit: { type: "string", short: "n", default: "50" },
  format: { type: "string", short: "f", default: "json" },
  output: { type: "string", short: "o" },
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
  -b, --blocks <number>  Recent blocks or slots, 1..50
      --concurrency <n>  Parallel chains, 1..8
  -n, --limit <number>   Maximum wallets, 1..100
  -f, --format <type>    json, jsonl, csv or none
  -o, --output <path>    Write to a file instead of stdout

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

function csvValue(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(result) {
  const fields = ["address", "chain", "activityScore", "transactionCount", "nativeBalanceFormatted", "classification", "coverage"];
  const lines = [fields.join(",")];
  for (const wallet of result.wallets) {
    const chainNames = Array.isArray(wallet.chains) && wallet.chains.length ? wallet.chains.join("+") : (wallet.chainDetails?.[0]?.chain ?? wallet.chain);
    const balances = Array.isArray(wallet.nativeBalances) && wallet.nativeBalances.length
      ? wallet.nativeBalances.map((item) => `${item.formatted ?? "?"} ${item.symbol}`).join(";")
      : (wallet.nativeBalanceFormatted ?? wallet.chainDetails?.[0]?.nativeBalanceFormatted);
    const symbol = wallet.symbol ?? wallet.chainDetails?.[0]?.symbol;
    lines.push([wallet.address, chainNames, wallet.activityScore, wallet.transactionCount, balances ?? (symbol && wallet.nativeBalanceFormatted ? `${wallet.nativeBalanceFormatted} ${symbol}` : null), wallet.classification, JSON.stringify(wallet.coverage)].map(csvValue).join(","));
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
  const request = {
    mode: parsed.mode,
    chains: selectedChains(parsed.chain),
    blocks: integer(parsed.blocks, 1, 50, "blocks"),
    concurrency: integer(parsed.concurrency, 1, 8, "concurrency"),
    limit: integer(parsed.limit, 1, 100, "limit")
  };
  const result = await scanChains(request, {
    onProgress(progress) {
      if (process.stderr.isTTY && progress.phase !== "starting") process.stderr.write(`\r${progress.chain} ${progress.phase} ${progress.completed}/${progress.total}`.padEnd(76));
    }
  });
  if (process.stderr.isTTY) process.stderr.write("\r\u001b[2K");
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

main().catch((error) => {
  process.stderr.write(`AddressScribe: ${sanitizeErrorText(error)}\n`);
  process.exitCode = 1;
});
