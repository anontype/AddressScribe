import { CHAIN_REGISTRY, getChain } from "../config/chains.js";
import { getRuntimeConfig, resolveRpcUrls } from "../config/runtime.js";
import { makeRpcAdapter } from "../core/client-adapter.js";
import { JsonRpcClient } from "../core/rpc.js";
import { SCHEMA_VERSION } from "../core/ranker.js";
import { compareBigInt, formatUnits } from "../core/units.js";
import { EVM_LIMITS, scanEvm } from "./evm.js";
import { SOLANA_LIMITS, scanSolana } from "./solana.js";
import { enrichTokenBalances, validateTokenEnrichment } from "./tokens.js";

const MODES = new Set(["activity", "balances", "multichain"]);
const MAX_CHAINS = CHAIN_REGISTRY.length;
const MAX_BLOCKS = 50;
const MAX_CONCURRENCY = 8;
const MAX_LIMIT = 100;
const MAX_TIMEOUT_MS = 300000;

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function validateRequest(request) {
  if (!isRecord(request)) throw new TypeError("Scan request must be an object");
  const mode = request.mode ?? "activity";
  if (!MODES.has(mode)) throw new RangeError("Unsupported scan mode");
  if (!Array.isArray(request.chains) || request.chains.length < 1 || request.chains.length > MAX_CHAINS) {
    throw new RangeError(`Select 1 to ${MAX_CHAINS} chains`);
  }
  const ids = [...new Set(request.chains)];
  if (ids.some((id) => typeof id !== "string" || !CHAIN_REGISTRY.some((chain) => chain.id === id))) {
    throw new RangeError("One or more chains are not supported");
  }
  const blocks = request.blocks ?? 10;
  const concurrency = request.concurrency ?? 4;
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) throw new RangeError("Blocks must be an integer from 1 to 50");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new RangeError(`Concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(`Limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (request.includeReceipts !== undefined && typeof request.includeReceipts !== "boolean") throw new TypeError("includeReceipts must be a boolean");
  if (request.includeTraces !== undefined && typeof request.includeTraces !== "boolean") throw new TypeError("includeTraces must be a boolean");
  const enrich = validateTokenEnrichment(request.enrich, ids);
  return { mode, chains: ids, blocks, concurrency, limit, enrich, includeReceipts: request.includeReceipts === true, includeTraces: request.includeTraces === true };
}

function unwrap(response) {
  if (isRecord(response) && response.error) throw new Error("RPC request failed");
  return isRecord(response) && Object.hasOwn(response, "result") ? response.result : response;
}

function emptyCoverage(reason) {
  return { status: "partial", complete: false, partial: true, reasons: [reason] };
}

function failedResult(chain, reason = "scan-failed") {
  return {
    schemaVersion: SCHEMA_VERSION,
    chain: chain.id,
    chainId: chain.chainId,
    family: chain.family,
    symbol: chain.symbol,
    explorerUrl: chain.explorerUrl,
    capabilities: chain.capabilities,
    zeroEx: chain.zeroEx,
    range: null,
    coverage: emptyCoverage(reason),
    gas: null,
    error: reason,
    blockEvidence: [],
    stats: { transactions: "0", candidates: "0" },
    totals: { value: "0", fees: "0" },
    candidates: []
  };
}

async function mapConcurrent(values, limit, worker) {
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
        firstError ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  if (firstError) throw firstError;
  return output;
}

function createDeadline(parent, timeoutMs) {
  if (!timeoutMs) return { signal: parent, cancel: () => undefined };
  const controller = new AbortController();
  let timer;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else if (typeof parent.addEventListener === "function") parent.addEventListener("abort", onAbort, { once: true });
  }
  timer = setTimeout(() => controller.abort(new Error("scan-timeout")), Math.max(100, timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      if (typeof parent?.removeEventListener === "function") parent.removeEventListener("abort", onAbort);
    }
  };
}

async function readGas(client, chain, signal) {
  try {
    const rpc = makeRpcAdapter(client);
    if (chain.family === "evm") {
      const raw = unwrap(await rpc.call("eth_gasPrice", [], signal));
      return { raw: BigInt(raw).toString(), formatted: `${formatUnits(raw, chain.gasDecimals ?? 9, 4)} ${chain.gasUnit ?? "gwei"}`, unit: chain.gasUnit ?? "gwei", stale: false };
    }
    const raw = unwrap(await rpc.call("getRecentPrioritizationFees", [], signal));
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const values = raw.map((value) => {
      const candidate = isRecord(value) ? value.prioritizationFee ?? value.value : value;
      try {
        return BigInt(candidate);
      } catch {
        return null;
      }
    }).filter((value) => value !== null);
    if (!values.length) return null;
    values.sort((a, b) => compareBigInt(a, b));
    const median = values[Math.floor(values.length / 2)];
    return { raw: median.toString(), formatted: `${formatUnits(median, 9, 4)} micro-lamports/CU`, unit: "micro-lamports/CU", stale: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function enrichBalances(result, client, chain, limit, signal) {
  const selected = result.candidates.slice(0, limit);
  if (!selected.length) return [];
  if (chain.nativeBalance === false) {
    return selected.map((candidate) => ({
      ...candidate,
      nativeBalance: null,
      nativeBalanceFormatted: null,
      nativeSymbol: chain.symbol,
      balanceConfidence: "not-applicable"
    }));
  }
  const rpc = makeRpcAdapter(client);
  const method = chain.family === "evm" ? "eth_getBalance" : "getBalance";
  const params = (candidate) => chain.family === "evm" ? [candidate.address, "latest"] : [candidate.address, { commitment: "finalized" }];
  const requests = selected.map((candidate) => ({ method, params: params(candidate) }));
  let responses = null;
  try {
    responses = await rpc.batch(requests, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  let values;
  if (Array.isArray(responses) && responses.length === selected.length) {
    values = responses.map((response) => response?.ok ? response.result : null);
  } else {
    values = await mapConcurrent(selected, Math.min(4, selected.length), async (candidate) => {
      try {
        return unwrap(await rpc.call(method, params(candidate), signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        return null;
      }
    });
  }
  const output = [];
  for (let index = 0; index < selected.length; index += 1) {
    let raw = values[index] ?? null;
    if (isRecord(raw) && Object.hasOwn(raw, "value")) raw = raw.value;
    if (raw != null) {
      try {
        BigInt(raw);
      } catch {
        raw = null;
      }
    }
    const balance = raw == null ? null : BigInt(raw);
    output.push({
      ...selected[index],
      nativeBalance: balance?.toString() ?? null,
      nativeBalanceFormatted: balance == null ? null : formatUnits(balance, chain.decimals, 8),
      nativeSymbol: chain.symbol,
      balanceConfidence: raw == null ? "unknown" : "rpc"
    });
  }
  return output.sort((left, right) => {
    if (left.nativeBalance == null && right.nativeBalance == null) return right.activityScore - left.activityScore;
    if (left.nativeBalance == null) return 1;
    if (right.nativeBalance == null) return -1;
    return compareBigInt(right.nativeBalance, left.nativeBalance) || right.activityScore - left.activityScore || left.address.localeCompare(right.address);
  });
}

function combineCoverage(...coverages) {
  const reasons = [...new Set(coverages.flatMap((coverage) => Array.isArray(coverage?.reasons) ? coverage.reasons : []))].sort();
  const complete = reasons.length === 0 && coverages.every((coverage) => coverage?.complete === true);
  return { status: complete ? "complete" : "partial", complete, partial: !complete, reasons };
}

function mergeWallets(results, limit) {
  const merged = new Map();
  for (const result of results) {
    for (const candidate of result.candidates) {
      const key = result.family === "evm" ? `evm:${candidate.address.toLowerCase()}` : `svm:${result.chain}:${candidate.address}`;
      const current = merged.get(key) ?? {
        address: candidate.address,
        family: result.family,
        classification: candidate.classification,
        activityScore: 0,
        transactionCount: 0,
        successfulTransactionCount: 0,
        failedTransactionCount: 0,
        chains: [],
        chainDetails: [],
        nativeBalances: [],
        tokenBalances: []
      };
      current.activityScore += candidate.activityScore;
      current.transactionCount += candidate.transactionCount;
      current.successfulTransactionCount += candidate.successfulTransactionCount;
      current.failedTransactionCount += candidate.failedTransactionCount;
      if (!current.chains.includes(result.chain)) current.chains.push(result.chain);
      current.chainDetails.push({
        chain: result.chain,
        symbol: result.symbol,
        activityScore: candidate.activityScore,
        transactionCount: candidate.transactionCount,
        classification: candidate.classification,
        nativeBalance: candidate.nativeBalance ?? null,
        nativeBalanceFormatted: candidate.nativeBalanceFormatted ?? null,
        ...(Array.isArray(candidate.tokenBalances) ? { tokenBalances: candidate.tokenBalances } : {}),
        ...(candidate.tokenEnrichment ? { tokenEnrichment: candidate.tokenEnrichment } : {}),
        coverage: combineCoverage(candidate.coverage, result.coverage)
      });
      if (candidate.nativeBalance != null) {
        current.nativeBalances.push({ chain: result.chain, symbol: result.symbol, raw: candidate.nativeBalance, formatted: candidate.nativeBalanceFormatted });
      }
      if (Array.isArray(candidate.tokenBalances)) current.tokenBalances.push(...candidate.tokenBalances);
      merged.set(key, current);
    }
  }
  return [...merged.values()].map((item) => {
    const { tokenBalances, ...base } = item;
    return {
      ...base,
      activityScore: Math.min(100, item.activityScore),
      chainCount: item.chains.length,
      ...(tokenBalances.length ? { tokenBalances, tokenEnrichment: combineCoverage(...item.chainDetails.map((detail) => detail.tokenEnrichment).filter(Boolean)) } : {}),
      coverage: combineCoverage(...item.chainDetails.map((detail) => detail.coverage))
    };
  }).sort((left, right) => right.activityScore - left.activityScore || left.address.localeCompare(right.address)).slice(0, limit);
}

function flattenWallets(results, mode, limit) {
  const wallets = results.flatMap((result) => result.candidates.map((candidate) => ({
    ...candidate,
    chain: result.chain,
    chainName: result.chain,
    symbol: result.symbol,
    family: result.family,
    explorerUrl: result.explorerUrl,
    coverage: combineCoverage(candidate.coverage, result.coverage)
  })));
  if (mode !== "balances") {
    return wallets.sort((left, right) => right.activityScore - left.activityScore || left.address.localeCompare(right.address)).slice(0, limit);
  }
  return wallets.sort((left, right) => {
    if (left.nativeBalance == null && right.nativeBalance == null) return right.activityScore - left.activityScore;
    if (left.nativeBalance == null) return 1;
    if (right.nativeBalance == null) return -1;
    return compareBigInt(right.nativeBalance, left.nativeBalance) || right.activityScore - left.activityScore || left.address.localeCompare(right.address);
  }).slice(0, limit);
}

function timestamp(options) {
  if (typeof options.now === "function") return new Date(options.now()).toISOString();
  if (options.now instanceof Date) return options.now.toISOString();
  if (typeof options.now === "number" && Number.isFinite(options.now)) return new Date(options.now).toISOString();
  return new Date().toISOString();
}

export async function scanChains(input, options = {}) {
  const request = validateRequest(input);
  const env = options.env ?? process.env;
  const deadline = createDeadline(options.signal, bounded(options.timeoutMs, 180000, 100, MAX_TIMEOUT_MS));
  const signal = deadline.signal;
  const clientFactory = options.clientFactory ?? ((chain, urls, config) => new JsonRpcClient(urls, {
    maxRetries: config.maxRetries,
    timeoutMs: config.rpcTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxBatchSize: config.maxBatchSize,
    requestsPerSecond: config.requestsPerSecond,
    burst: config.burst
  }));
  try {
    const results = await mapConcurrent(request.chains, request.concurrency, async (id) => {
      const chain = getChain(id);
      options.onProgress?.({ chain: chain.id, phase: "starting", completed: 0, total: request.blocks });
      try {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Scan aborted");
        const config = getRuntimeConfig({
          env,
          chain: chain.id,
          blocks: request.blocks,
          slots: request.blocks,
          concurrency: request.concurrency,
          timeoutMs: options.timeoutMs ?? undefined,
          rpcTimeoutMs: options.rpcTimeoutMs ?? undefined,
          maxRetries: options.maxRetries ?? undefined,
          requestsPerSecond: options.requestsPerSecond ?? undefined,
          burst: options.burst ?? undefined,
          maxResponseBytes: options.maxResponseBytes ?? undefined,
          maxBatchSize: options.maxBatchSize ?? undefined
        });
        const urls = options.rpcUrls?.[chain.id] ?? options.rpcUrls?.[chain.chainId] ?? resolveRpcUrls(chain, env);
        if (!urls.length) throw new Error("No public RPC is configured for this chain");
        const client = options.clients?.[chain.id] ?? clientFactory(chain, urls, config);
        const rpc = makeRpcAdapter(client);
        if (chain.family === "evm") {
          const actualChainId = BigInt(unwrap(await rpc.call("eth_chainId", [], signal)));
          if (actualChainId !== BigInt(chain.chainId)) {
            const error = new Error(`RPC chain mismatch for ${chain.id}`);
            error.code = "chain-mismatch";
            throw error;
          }
        }
        const head = chain.family === "evm"
          ? BigInt(unwrap(await rpc.call("eth_blockNumber", [], signal)))
          : BigInt(unwrap(await rpc.call("getSlot", [{ commitment: "finalized" }], signal)));
        const result = chain.family === "evm"
          ? await scanEvm({ chain, client, head, blocks: request.blocks, concurrency: Math.min(request.concurrency, 4), maxCodeChecks: EVM_LIMITS.codeChecks, includeReceipts: request.includeReceipts, maxReceipts: options.maxReceipts, includeTraces: request.includeTraces, maxTraceBlocks: options.maxTraceBlocks, signal, onProgress: options.onProgress })
          : await scanSolana({ chain, client, head, blocks: request.blocks, concurrency: Math.min(request.concurrency, 4), maxAccountChecks: SOLANA_LIMITS.accountChecks, signal, onProgress: options.onProgress });
        if (request.mode === "balances") {
          result.candidates = await enrichBalances(result, client, chain, request.limit, signal);
          const incomplete = chain.nativeBalance !== false && result.candidates.some((item) => item.nativeBalance == null);
          result.coverage.reasons = [...new Set([...result.coverage.reasons, ...(incomplete ? ["balance-incomplete"] : [])])].sort();
          result.coverage.partial = result.coverage.reasons.length > 0;
          result.coverage.complete = !result.coverage.partial;
          result.coverage.status = result.coverage.partial ? "partial" : "complete";
        }
        if (request.enrich) {
          const tokenResult = await enrichTokenBalances({ chain, client, candidates: result.candidates, tokens: request.enrich.tokens, signal });
          if (tokenResult.coverage) {
            result.candidates = tokenResult.candidates;
            result.tokenEnrichment = tokenResult.coverage;
            result.coverage.reasons = [...new Set([...result.coverage.reasons, ...tokenResult.coverage.reasons])].sort();
            result.coverage.partial = result.coverage.reasons.length > 0;
            result.coverage.complete = !result.coverage.partial;
            result.coverage.status = result.coverage.partial ? "partial" : "complete";
          }
        }
        const discoveredCandidates = result.candidates.length;
        result.candidates = result.candidates.slice(0, request.limit);
        result.coverage.discoveredCandidates = String(discoveredCandidates);
        result.coverage.returnedCandidates = String(result.candidates.length);
        result.coverage.candidates = String(discoveredCandidates);
        result.gas = await readGas(client, chain, signal);
        await options.onResult?.(result);
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        const failed = failedResult(chain, error?.code === "chain-mismatch" ? "chain-mismatch" : "scan-failed");
        await options.onResult?.(failed);
        return failed;
      }
    });
    const wallets = request.mode === "multichain" ? mergeWallets(results, request.limit) : flattenWallets(results, request.mode, request.limit);
    return {
      schema: "addressscribe/scan/v1",
      mode: request.mode,
      createdAt: timestamp(options),
      request: { chains: request.chains, blocks: request.blocks, concurrency: request.concurrency, limit: request.limit, ...(request.includeReceipts ? { includeReceipts: true } : {}), ...(request.includeTraces ? { includeTraces: true } : {}), ...(request.enrich ? { enrich: request.enrich } : {}) },
      summary: {
        chains: results.length,
        complete: results.filter((result) => result.coverage.complete).length,
        partial: results.filter((result) => result.coverage.partial).length,
        failed: results.filter((result) => result.error).length,
        wallets: wallets.length
      },
      wallets,
      results
    };
  } finally {
    deadline.cancel();
  }
}

export async function scan(options = {}) {
  return scanChains({ chains: [options.chain ?? "ethereum"], blocks: options.blocks, concurrency: options.concurrency, mode: "activity", enrich: options.enrich, includeReceipts: options.includeReceipts, includeTraces: options.includeTraces }, options);
}

export * from "./evm.js";
export * from "./solana.js";
export * from "./tokens.js";
