import { getChain } from "../config/chains.js";
import { makeRpcAdapter } from "../core/client-adapter.js";
import { formatUnits } from "../core/units.js";

export const TOKEN_ENRICHMENT_LIMITS = Object.freeze({
  wallets: 20,
  tokens: 20,
  batchSize: 20,
  concurrency: 4
});

const KIND_ALIASES = Object.freeze({
  erc20: "erc20",
  token: "token",
  erc721: "erc721",
  nft: "nft",
  "spl-token": "spl-token",
  "spl-nft": "spl-nft"
});

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeDecimals(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 255) throw new TypeError("Token decimals must be an integer from 0 to 255");
  return number;
}

function abortError() {
  const error = new Error("Token enrichment aborted");
  error.name = "AbortError";
  return error;
}

function checkSignal(signal) {
  if (signal?.aborted) throw abortError();
}

function normalizeKind(value, family) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "token";
  const kind = KIND_ALIASES[text];
  if (!kind) throw new TypeError("Token kind must be erc20, erc721, spl-token, or spl-nft");
  if (family === "evm") {
    if (kind === "erc20") return "erc20";
    if (kind === "erc721") return "erc721";
    if (kind === "token") return "erc20";
    return "erc721";
  }
  if (kind === "spl-token") return "spl-token";
  if (kind === "spl-nft") return "spl-nft";
  if (kind === "token") return "spl-token";
  return "spl-nft";
}

function normalizeAddress(value, family) {
  const text = typeof value === "string" ? value.trim() : "";
  if (family === "evm" && /^0x[0-9a-f]{40}$/i.test(text)) return text.toLowerCase();
  if (family === "svm" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;
  throw new TypeError(`Token address is not valid for ${family}`);
}

function normalizeSpec(value, index, allowedChainIds) {
  if (!isRecord(value)) throw new TypeError(`Token specification ${index + 1} must be an object`);
  const allowed = new Set(["chain", "address", "kind", "decimals", "symbol"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError(`Token specification ${index + 1} has unsupported fields`);
  if (typeof value.chain !== "string") throw new TypeError(`Token specification ${index + 1} needs a chain`);
  let chain;
  try {
    chain = getChain(value.chain);
  } catch {
    throw new TypeError(`Token specification ${index + 1} has an unknown chain`);
  }
  if (allowedChainIds && !allowedChainIds.has(chain.id)) throw new TypeError(`Token specification ${index + 1} is not for a selected chain`);
  const kind = normalizeKind(value.kind, chain.family);
  const address = normalizeAddress(value.address, chain.family);
  let decimals = null;
  if (value.decimals !== undefined && value.decimals !== null) {
    if (kind === "erc721" || kind === "spl-nft") throw new TypeError("NFT specifications cannot set decimals");
    decimals = normalizeDecimals(value.decimals);
  }
  if (value.symbol !== undefined && (typeof value.symbol !== "string" || value.symbol.length > 32)) throw new TypeError("Token symbol must be a short string");
  return {
    chain: chain.id,
    address,
    kind,
    decimals,
    symbol: value.symbol ?? null
  };
}

export function validateTokenEnrichment(value, allowedChainIds = null) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new TypeError("Token enrichment must be an object");
  if (Object.keys(value).some((key) => key !== "tokens")) throw new TypeError("Token enrichment only supports tokens");
  if (!Array.isArray(value.tokens) || value.tokens.length < 1) throw new TypeError("Token enrichment requires at least one token");
  if (value.tokens.length > TOKEN_ENRICHMENT_LIMITS.tokens) throw new RangeError(`Token enrichment supports at most ${TOKEN_ENRICHMENT_LIMITS.tokens} tokens`);
  const selected = new Set(allowedChainIds ?? []);
  const tokens = value.tokens.map((item, index) => normalizeSpec(item, index, selected.size ? selected : null));
  const unique = new Map();
  for (const token of tokens) unique.set(`${token.chain}:${token.address}:${token.kind}`, token);
  return { tokens: [...unique.values()] };
}

function decodeQuantity(value) {
  try {
    if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString();
    if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) return BigInt(value.trim()).toString();
  } catch {
    return null;
  }
  return null;
}

function encodeAddress(address) {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function ethBalanceData(address) {
  return `0x70a08231${encodeAddress(address)}`;
}

function unsupportedError(error) {
  const code = String(error?.code ?? "");
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? "");
  return code === "-32601" || code === "-32602" || status === 404 || status === 405 || /not supported|not available|not implemented|unsupported|method not found|no such method/i.test(message);
}

function rateLimited(error) {
  return error?.code === "rate_limited" || error?.code === "rate_limit_exceeded" || error?.status === 429;
}

function emptyTokenRecord(spec, confidence = "unknown") {
  return {
    chain: spec.chain,
    address: spec.address,
    standard: spec.kind,
    symbol: spec.symbol,
    raw: null,
    formatted: null,
    decimals: spec.decimals,
    confidence
  };
}

function formatTokenRecord(spec, raw, confidence = "rpc") {
  const quantityValue = decodeQuantity(raw);
  if (quantityValue === null) return emptyTokenRecord(spec, "unknown");
  const formatted = spec.decimals === null || spec.kind === "erc721" || spec.kind === "spl-nft"
    ? quantityValue
    : formatUnits(quantityValue, spec.decimals, 8);
  return {
    chain: spec.chain,
    address: spec.address,
    standard: spec.kind,
    symbol: spec.symbol,
    raw: quantityValue,
    formatted,
    decimals: spec.decimals,
    confidence
  };
}

function parseSolanaBalance(value, spec) {
  if (!isRecord(value) || !Array.isArray(value.value)) return null;
  let total = 0n;
  let decimals = spec.decimals;
  for (const entry of value.value) {
    const info = entry?.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const amountDecimals = info?.tokenAmount?.decimals;
    const parsed = decodeQuantity(amount);
    if (parsed === null) return null;
    total += BigInt(parsed);
    if (amountDecimals !== undefined) {
      const parsedDecimals = Number(amountDecimals);
      if (!Number.isSafeInteger(parsedDecimals) || parsedDecimals < 0 || parsedDecimals > 255) return null;
      if (decimals !== null && decimals !== parsedDecimals) return null;
      decimals = parsedDecimals;
    }
  }
  const effectiveSpec = decimals === spec.decimals ? spec : { ...spec, decimals };
  return formatTokenRecord(effectiveSpec, total.toString());
}

async function mapConcurrent(values, limit, worker, signal) {
  const output = new Array(values.length);
  let cursor = 0;
  let firstError = null;
  async function run() {
    while (cursor < values.length && !firstError) {
      const index = cursor;
      cursor += 1;
      try {
        output[index] = await worker(values[index], index);
      } catch (error) {
        if (signal?.aborted) throw error;
        firstError = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  if (firstError) throw firstError;
  return output;
}

async function executeJobGroup(rpc, jobs, signal) {
  let responses = null;
  try {
    responses = await rpc.batch(jobs.map((job) => job.request), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (unsupportedError(error) || rateLimited(error)) return jobs.map(() => ({ ok: false, error }));
  }
  if (Array.isArray(responses) && responses.length === jobs.length) return responses;
  return mapConcurrent(jobs, TOKEN_ENRICHMENT_LIMITS.concurrency, async (job) => {
    try {
      return { ok: true, result: await rpc.call(job.request.method, job.request.params, signal) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, error };
    }
  }, signal);
}

async function executeJobs(rpc, jobs, signal) {
  const output = [];
  for (let offset = 0; offset < jobs.length; offset += TOKEN_ENRICHMENT_LIMITS.batchSize) {
    const group = jobs.slice(offset, offset + TOKEN_ENRICHMENT_LIMITS.batchSize);
    output.push(...await executeJobGroup(rpc, group, signal));
  }
  return output;
}

async function enrichEvm(rpc, candidates, specs, signal) {
  checkSignal(signal);
  const jobs = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    for (const spec of specs) {
      jobs.push({
        candidateIndex,
        spec,
        request: { method: "eth_call", params: [{ to: spec.address, data: ethBalanceData(candidates[candidateIndex].address) }, "latest"] }
      });
    }
  }
  const results = await executeJobs(rpc, jobs, signal);
  const output = candidates.map((candidate) => ({ ...candidate, tokenBalances: [], tokenEnrichment: { status: "complete", complete: true, partial: false, reasons: [] } }));
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const response = results[index] ?? { ok: false, error: new Error("missing token response") };
    let record;
    if (response.ok) record = formatTokenRecord(job.spec, response.result);
    else record = emptyTokenRecord(job.spec, unsupportedError(response.error) ? "unsupported" : "unknown");
    output[job.candidateIndex].tokenBalances.push(record);
  }
  return output;
}

async function enrichSolana(rpc, candidates, specs, signal) {
  checkSignal(signal);
  const jobs = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    for (const spec of specs) {
      jobs.push({
        candidateIndex,
        spec,
        request: {
          method: "getTokenAccountsByOwner",
          params: [candidates[candidateIndex].address, { mint: spec.address }, { encoding: "jsonParsed", commitment: "finalized" }]
        }
      });
    }
  }
  const results = await executeJobs(rpc, jobs, signal);
  const output = candidates.map((candidate) => ({ ...candidate, tokenBalances: [], tokenEnrichment: { status: "complete", complete: true, partial: false, reasons: [] } }));
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const response = results[index] ?? { ok: false, error: new Error("missing token response") };
    let record;
    if (response.ok) record = parseSolanaBalance(response.result, job.spec) ?? emptyTokenRecord(job.spec, "unknown");
    else record = emptyTokenRecord(job.spec, unsupportedError(response.error) ? "unsupported" : "unknown");
    output[job.candidateIndex].tokenBalances.push(record);
  }
  return output;
}

export async function enrichTokenBalances({ chain, client, candidates, tokens, signal } = {}) {
  if (!chain || !client || !Array.isArray(candidates) || !Array.isArray(tokens) || !tokens.length) return { candidates, coverage: null };
  const rpc = makeRpcAdapter(client);
  const selected = candidates.slice(0, TOKEN_ENRICHMENT_LIMITS.wallets);
  const specs = tokens.filter((token) => token.chain === chain.id);
  if (!specs.length) return { candidates, coverage: null };
  const output = chain.family === "evm"
    ? await enrichEvm(rpc, selected, specs, signal)
    : await enrichSolana(rpc, selected, specs, signal);
  const reasons = new Set();
  if (selected.length < candidates.length) reasons.add("token-wallet-cap");
  for (const candidate of output) {
    const candidateReasons = new Set();
    for (const record of candidate.tokenBalances) {
      if (record.confidence === "unsupported") candidateReasons.add("token-rpc-unsupported");
      if (record.confidence === "unknown") candidateReasons.add("token-balance-incomplete");
    }
    if (candidateReasons.size) {
      candidate.tokenEnrichment = { status: "partial", complete: false, partial: true, reasons: [...candidateReasons].sort() };
      for (const reason of candidateReasons) reasons.add(reason);
    }
  }
  const uniqueReasons = [...reasons].sort();
  return {
    candidates: output,
    coverage: {
      status: uniqueReasons.length ? "partial" : "complete",
      complete: uniqueReasons.length === 0,
      partial: uniqueReasons.length > 0,
      reasons: uniqueReasons,
      wallets: selected.length.toString(),
      tokens: specs.length.toString(),
      calls: (selected.length * specs.length).toString()
    }
  };
}
