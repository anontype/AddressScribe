import { getChain } from "../config/chains.js";
import { makeRpcAdapter } from "../core/client-adapter.js";
import { rankCandidates, SCHEMA_VERSION } from "../core/ranker.js";

export const EVM_LIMITS = Object.freeze({
  blocks: 50,
  transactions: 100000,
  candidates: 2000,
  codeChecks: 500,
  batchSize: 20,
  concurrency: 16
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function abortError() {
  const error = new Error("Scan aborted");
  error.name = "AbortError";
  return error;
}

function checkSignal(signal) {
  if (signal?.aborted) throw abortError();
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function quantity(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function optionalQuantity(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function inputQuantity(value, name) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
  }
  throw new RangeError(`${name} must be a non-negative integer`);
}

function feeOf(transaction) {
  const direct = optionalQuantity(transaction.fee ?? transaction.feeWei);
  if (direct !== null) return direct;
  const gasUsed = optionalQuantity(transaction.gasUsed ?? transaction.gas_used);
  const gasPrice = optionalQuantity(transaction.effectiveGasPrice ?? transaction.effective_gas_price ?? transaction.gasPrice ?? transaction.gas_price);
  return gasUsed === null || gasPrice === null ? null : gasUsed * gasPrice;
}

function address(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
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

function checkPriority(items, limit) {
  return [...items].sort((left, right) => right.transactionCount - left.transactionCount || right.counterparties.size - left.counterparties.size || left.address.localeCompare(right.address)).slice(0, limit);
}

function unsupportedMethod(error) {
  const code = String(error?.code ?? "");
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? error?.rpcMessage ?? "");
  return code === "-32601" || code === "-32602" || status === 404 || status === 405 || /not supported|not available|not implemented|unsupported|method not found|no such method/i.test(message);
}

function receiptFee(receipt) {
  const gasUsed = optionalQuantity(receipt?.gasUsed);
  const gasPrice = optionalQuantity(receipt?.effectiveGasPrice ?? receipt?.gasPrice);
  return gasUsed === null || gasPrice === null ? null : gasUsed * gasPrice;
}

function traceItems(value) {
  if (Array.isArray(value)) return value.flatMap((item) => traceItems(item));
  if (!isRecord(value)) return [];
  if (Array.isArray(value.result)) return value.result.flatMap((item) => traceItems(item));
  if (isRecord(value.result)) return traceItems(value.result);
  const calls = Array.isArray(value.calls) ? value.calls.flatMap((item) => traceItems(item)) : [];
  if (value.error || (isRecord(value.action) && value.action.error)) return calls;
  const action = isRecord(value.action) ? value.action : value;
  const from = address(action.from);
  const to = address(action.to ?? action.toAddress);
  const amount = quantity(action.value ?? action.valueWei);
  if (!from || !to || amount <= 0n) return calls;
  return calls.concat([{
    from,
    to,
    value: amount,
    transactionHash: typeof value.transactionHash === "string" ? value.transactionHash : null,
    traceAddress: Array.isArray(value.traceAddress) ? value.traceAddress.join(".") : null,
    callType: typeof value.type === "string" ? value.type : (typeof action.callType === "string" ? action.callType : "call")
  }]);
}

async function fetchTraces(blocks, rpc, concurrency, signal, maxTraceBlocks, reasons) {
  const selected = [...blocks.keys()].slice(0, maxTraceBlocks);
  if (!selected.length) return { traces: new Map(), requested: 0, fetched: 0, status: "not-requested", method: null };
  if (selected.length < blocks.size) reasons.add("trace-block-cap");
  let responses = null;
  try {
    responses = await rpc.batch(selected.map((block) => ({ method: "trace_block", params: [hex(block)] })), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (unsupportedMethod(error) || error?.code === "rate_limited") responses = selected.map(() => ({ ok: false, error }));
  }
  if (!Array.isArray(responses) || responses.length !== selected.length) {
    responses = await mapConcurrent(selected, concurrency, async (block) => {
      try {
        return { ok: true, result: await rpc.call("trace_block", [hex(block)], signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, error };
      }
    });
  }
  const fallbackIndices = responses.flatMap((response, index) => response?.ok || response?.error?.code === "rate_limited" ? [] : [index]);
  let usedFallback = false;
  if (fallbackIndices.length) {
    const fallbackResponses = await mapConcurrent(fallbackIndices, concurrency, async (index) => {
      try {
        const result = await rpc.call("debug_traceBlockByNumber", [hex(selected[index]), { tracer: "callTracer" }], signal);
        usedFallback = true;
        return { ok: true, result };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, error };
      }
    });
    for (let index = 0; index < fallbackIndices.length; index += 1) responses[fallbackIndices[index]] = fallbackResponses[index];
  }
  const traces = new Map();
  let fetched = 0;
  let complete = selected.length === blocks.size;
  for (let index = 0; index < selected.length; index += 1) {
    const response = responses[index];
    if (response?.ok) {
      traces.set(selected[index], traceItems(response.result));
      fetched += 1;
    } else {
      complete = false;
      if (unsupportedMethod(response?.error)) reasons.add("traces-unavailable");
      else reasons.add("traces-partial");
    }
  }
  return { traces, requested: selected.length, fetched, status: complete ? "complete" : "partial", method: usedFallback ? "debug_traceBlockByNumber" : "trace_block" };
}

async function enrichReceipts(targets, rpc, concurrency, signal, maxReceipts, reasons) {
  const selected = targets.slice(0, maxReceipts);
  if (selected.length < targets.length) reasons.add("receipts-partial");
  let responses = null;
  try {
    responses = await rpc.batch(selected.map((target) => ({ method: "eth_getTransactionReceipt", params: [target.hash] })), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (unsupportedMethod(error) || error?.code === "rate_limited") {
      responses = selected.map(() => ({ ok: false, error }));
    }
  }
  if (!Array.isArray(responses) || responses.length !== selected.length) {
    responses = await mapConcurrent(selected, concurrency, async (target) => {
      try {
        return { ok: true, result: await rpc.call("eth_getTransactionReceipt", [target.hash], signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, error };
      }
    });
  }
  let fetched = 0;
  let complete = true;
  for (let index = 0; index < selected.length; index += 1) {
    const response = responses[index] ?? { ok: false, error: new Error("missing receipt") };
    if (!response.ok) {
      complete = false;
      if (unsupportedMethod(response.error)) reasons.add("receipts-unavailable");
      else reasons.add("receipts-partial");
      continue;
    }
    const receipt = response.result;
    if (!isRecord(receipt)) {
      complete = false;
      reasons.add("receipts-partial");
      continue;
    }
    fetched += 1;
    const status = optionalQuantity(receipt.status);
    if (status === 0n || status === 1n) {
      if (status === 1n) selected[index].candidate.successfulTransactionCount += 1;
      else selected[index].candidate.failedTransactionCount += 1;
    } else {
      complete = false;
      reasons.add("receipt-status-unavailable");
    }
    const fee = receiptFee(receipt);
    if (fee !== null && (selected[index].role === "sender" || selected[index].role === "self") && !selected[index].candidate.feesKnown) {
      selected[index].candidate.totalFeesWei = fee;
      selected[index].candidate.feesKnown = true;
    }
  }
  return { requested: selected.length, fetched, status: complete && selected.length === targets.length ? "complete" : "partial" };
}

function candidate(addressValue, chainId) {
  return {
    address: addressValue,
    chainId,
    classification: "unknown",
    transactionCount: 0,
    successfulTransactionCount: 0,
    failedTransactionCount: 0,
    sentTransactionCount: 0,
    receivedTransactionCount: 0,
    internalTransactionCount: 0,
    internalValueWei: 0n,
    nativeInWei: 0n,
    nativeOutWei: 0n,
    totalFeesWei: null,
    feesKnown: false,
    methods: new Set(),
    counterparties: new Set(),
    evidence: [],
    firstSeen: null,
    lastSeen: null
  };
}

function addCandidate(map, value, chainId, maxCandidates, reasons) {
  const normalized = address(value);
  if (!normalized || normalized === ZERO_ADDRESS) return null;
  const existing = map.get(normalized);
  if (existing) return existing;
  if (map.size >= maxCandidates) {
    reasons.add("candidate-cap");
    return null;
  }
  const created = candidate(normalized, chainId);
  map.set(normalized, created);
  return created;
}

function record(candidateValue, role, counterparty, value, fee, method, block, transaction, timestamp) {
  candidateValue.transactionCount += 1;
  if (role === "sender") candidateValue.sentTransactionCount += 1;
  if (role === "recipient") candidateValue.receivedTransactionCount += 1;
  if (role === "sender") candidateValue.nativeOutWei += value;
  if (role === "recipient") candidateValue.nativeInWei += value;
  if ((role === "sender" || role === "self") && fee !== null) {
    candidateValue.totalFeesWei = (candidateValue.totalFeesWei ?? 0n) + fee;
    candidateValue.feesKnown = true;
  }
  if (counterparty && counterparty !== candidateValue.address) candidateValue.counterparties.add(counterparty);
  if (method) candidateValue.methods.add(method);
  if (candidateValue.evidence.length < 12) {
    candidateValue.evidence.push({
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: transaction.hash,
      transactionIndex: transaction.index,
      timestamp,
      role,
      method: method ?? null,
      valueWei: value.toString(),
      ...(fee === null ? {} : { feeWei: fee.toString() })
    });
  }
  if (timestamp != null) {
    const time = BigInt(timestamp);
    candidateValue.firstSeen = candidateValue.firstSeen == null || time < candidateValue.firstSeen ? time : candidateValue.firstSeen;
    candidateValue.lastSeen = candidateValue.lastSeen == null || time > candidateValue.lastSeen ? time : candidateValue.lastSeen;
  }
}

function recordInternal(item, counterparty, value, trace, block, transaction, timestamp) {
  item.internalTransactionCount += 1;
  item.internalValueWei += value;
  if (counterparty && counterparty !== item.address) item.counterparties.add(counterparty);
  if (item.evidence.length < 12) {
    item.evidence.push({
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: trace.transactionHash ?? transaction.hash,
      transactionIndex: transaction.index,
      timestamp,
      role: "internal",
      method: "internal-call",
      valueWei: value.toString()
    });
  }
}

function codeClass(value) {
  if (typeof value !== "string") return "unknown";
  const code = value.toLowerCase();
  if (code === "0x" || code === "0x0") return "eoa";
  if (/^0x[0-9a-f]+$/.test(code) && code.length > 2) return "contract";
  return "unknown";
}

async function classify(values, rpc, concurrency, signal) {
  const output = new Map();
  for (const group of chunks(values, 100)) {
    checkSignal(signal);
    const requests = group.map((value) => ({ method: "eth_getCode", params: [value.address, "latest"] }));
    let responses = null;
    try {
      responses = await rpc.batch(requests, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === "rate_limited") {
        for (const item of group) output.set(item.address, "unknown");
        continue;
      }
    }
    if (responses) {
      const failed = [];
      for (let index = 0; index < group.length; index += 1) {
        const response = responses[index];
        if (response?.ok) output.set(group[index].address, codeClass(response.result));
        else failed.push(group[index]);
      }
      if (!failed.length) continue;
      await mapConcurrent(failed, concurrency, async (item) => {
        checkSignal(signal);
        try {
          const code = await rpc.call("eth_getCode", [item.address, "latest"], signal);
          output.set(item.address, codeClass(code));
        } catch (error) {
          if (signal?.aborted) throw error;
          output.set(item.address, "unknown");
        }
      });
      continue;
    }
    await mapConcurrent(group, concurrency, async (item) => {
      checkSignal(signal);
      try {
        const code = await rpc.call("eth_getCode", [item.address, "latest"], signal);
        output.set(item.address, codeClass(code));
      } catch (error) {
        if (signal?.aborted) throw error;
        output.set(item.address, "unknown");
      }
    });
  }
  return output;
}

export async function scanEvm(options = {}) {
  const chain = options.chain ?? getChain("ethereum");
  const rpc = makeRpcAdapter(options.client);
  const requested = bounded(options.blocks ?? options.amount, 10, 1, EVM_LIMITS.blocks);
  const blockLimit = bounded(options.maxBlocks, EVM_LIMITS.blocks, 1, EVM_LIMITS.blocks);
  const concurrency = bounded(options.concurrency, 4, 1, EVM_LIMITS.concurrency);
  const maxTransactions = bounded(options.maxTransactions, EVM_LIMITS.transactions, 1, EVM_LIMITS.transactions);
  const maxCandidates = bounded(options.maxCandidates, EVM_LIMITS.candidates, 1, EVM_LIMITS.candidates);
  const maxCodeChecks = bounded(options.maxCodeChecks, EVM_LIMITS.codeChecks, 1, EVM_LIMITS.codeChecks);
  const includeReceipts = options.includeReceipts === true;
  const maxReceipts = bounded(options.maxReceipts, 200, 1, 1000);
  const includeTraces = options.includeTraces === true;
  const maxTraceBlocks = bounded(options.maxTraceBlocks, 20, 1, EVM_LIMITS.blocks);
  const reasons = new Set();
  let head = options.head == null ? null : inputQuantity(options.head, "head");
  if (head == null && (options.fromBlock == null || options.toBlock == null)) head = quantity(await rpc.call("eth_blockNumber", [], options.signal));
  const toBlock = options.toBlock == null ? head : inputQuantity(options.toBlock, "toBlock");
  const fromBlock = options.fromBlock == null ? toBlock - BigInt(requested - 1) : inputQuantity(options.fromBlock, "fromBlock");
  if (fromBlock < 0n || toBlock < fromBlock) throw new RangeError("Invalid EVM block range");
  let cappedBlocks = false;
  let effectiveFrom = fromBlock;
  const span = toBlock - fromBlock + 1n;
  if (span > BigInt(blockLimit)) {
    effectiveFrom = toBlock - BigInt(blockLimit - 1);
    cappedBlocks = true;
    reasons.add("block-cap");
  }
  const blockNumbers = [];
  for (let block = effectiveFrom; block <= toBlock; block += 1n) blockNumbers.push(block);
  const blocks = new Map();
  const blockEvidence = [];
  let completed = 0;
  for (const group of chunks(blockNumbers, EVM_LIMITS.batchSize)) {
    checkSignal(options.signal);
    const requests = group.map((block) => ({ method: "eth_getBlockByNumber", params: [hex(block), true] }));
    let responses = null;
    try {
      responses = await rpc.batch(requests, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error?.code === "rate_limited") {
        reasons.add("rate-limited");
        continue;
      }
    }
    if (responses) {
      for (let index = 0; index < group.length; index += 1) {
        const response = responses[index];
        if (response?.ok && isRecord(response.result)) {
          const block = response.result;
          blocks.set(group[index], block);
          blockEvidence.push({ blockNumber: group[index].toString(), blockHash: typeof block.hash === "string" ? block.hash : null, parentHash: typeof block.parentHash === "string" ? block.parentHash : null });
        } else {
          reasons.add("block-request-failed");
        }
      }
    } else {
      await mapConcurrent(group, concurrency, async (block) => {
        checkSignal(options.signal);
        try {
          const response = await rpc.call("eth_getBlockByNumber", [hex(block), true], options.signal);
          if (isRecord(response)) {
            blocks.set(block, response);
            blockEvidence.push({ blockNumber: block.toString(), blockHash: typeof response.hash === "string" ? response.hash : null, parentHash: typeof response.parentHash === "string" ? response.parentHash : null });
          } else {
            reasons.add("block-request-failed");
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          reasons.add("block-request-failed");
        }
      });
    }
    completed += group.length;
    options.onProgress?.({ chain: chain.id, phase: "blocks", completed, total: blockNumbers.length });
  }
  blockEvidence.sort((left, right) => {
    const a = BigInt(left.blockNumber);
    const b = BigInt(right.blockNumber);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let previousEvidence = null;
  for (const evidence of blockEvidence) {
    if (previousEvidence && BigInt(evidence.blockNumber) === BigInt(previousEvidence.blockNumber) + 1n && evidence.parentHash && previousEvidence.blockHash && evidence.parentHash.toLowerCase() !== previousEvidence.blockHash.toLowerCase()) {
      reasons.add("reorg-detected");
      break;
    }
    previousEvidence = evidence;
  }
  const traceResult = includeTraces ? await fetchTraces(blocks, rpc, concurrency, options.signal, maxTraceBlocks, reasons) : { traces: new Map(), requested: 0, fetched: 0, status: "not-requested", method: null };
  const accumulator = new Map();
  const receiptTargets = [];
  let transactions = 0;
  let internalTransactions = 0;
  let transactionCap = false;
  outer: for (const blockNumber of blockNumbers) {
    if (transactions >= maxTransactions) {
      transactionCap = true;
      reasons.add("transaction-cap");
      break;
    }
    const block = blocks.get(blockNumber);
    if (!block) continue;
    if (!Array.isArray(block.transactions)) {
      reasons.add("full-block-unavailable");
      continue;
    }
    const timestamp = optionalQuantity(block.timestamp);
    for (const [traceIndex, trace] of (traceResult.traces.get(blockNumber) ?? []).entries()) {
      internalTransactions += 1;
      const traceBlock = { number: blockNumber.toString(), hash: typeof block.hash === "string" ? block.hash : null };
      const traceTransaction = { hash: trace.transactionHash ?? `${chain.id}:trace:${blockNumber}:${traceIndex}`, index: traceIndex };
      const sender = addCandidate(accumulator, trace.from, chain.chainId, maxCandidates, reasons);
      const recipient = addCandidate(accumulator, trace.to, chain.chainId, maxCandidates, reasons);
      if (sender && recipient && trace.from === trace.to) {
        recordInternal(sender, trace.to, trace.value, trace, traceBlock, traceTransaction, timestamp);
      } else {
        if (sender) recordInternal(sender, trace.to, trace.value, trace, traceBlock, traceTransaction, timestamp);
        if (recipient) recordInternal(recipient, trace.from, trace.value, trace, traceBlock, traceTransaction, timestamp);
      }
    }
    for (let index = 0; index < block.transactions.length; index += 1) {
      if (transactions >= maxTransactions) {
        transactionCap = true;
        reasons.add("transaction-cap");
        break outer;
      }
      const transaction = block.transactions[index];
      if (!isRecord(transaction)) continue;
      transactions += 1;
      const from = address(transaction.from);
      const to = address(transaction.to);
      const value = quantity(transaction.value);
      const fee = feeOf(transaction);
      const method = typeof transaction.input === "string" && /^0x[0-9a-f]{8,}$/i.test(transaction.input) ? transaction.input.slice(0, 10) : null;
      const transactionRecord = {
        hash: typeof transaction.hash === "string" ? transaction.hash : `${chain.id}:${blockNumber}:${index}`,
        index
      };
      const blockRecord = { number: blockNumber.toString(), hash: typeof block.hash === "string" ? block.hash : null };
      if (from === to && from) {
        const item = addCandidate(accumulator, from, chain.chainId, maxCandidates, reasons);
        if (item) {
          record(item, "self", to, value, fee, method, blockRecord, transactionRecord, timestamp);
          if (includeReceipts && typeof transaction.hash === "string" && /^0x[0-9a-f]{64}$/i.test(transaction.hash)) receiptTargets.push({ hash: transaction.hash, candidate: item, role: "self" });
        }
      } else {
        const sender = addCandidate(accumulator, from, chain.chainId, maxCandidates, reasons);
        if (sender) {
          record(sender, "sender", to, value, fee, method, blockRecord, transactionRecord, timestamp);
          if (includeReceipts && typeof transaction.hash === "string" && /^0x[0-9a-f]{64}$/i.test(transaction.hash)) receiptTargets.push({ hash: transaction.hash, candidate: sender, role: "sender" });
        }
        const recipient = addCandidate(accumulator, to, chain.chainId, maxCandidates, reasons);
        if (recipient) record(recipient, "recipient", from, value, null, method, blockRecord, transactionRecord, timestamp);
      }
    }
  }
  const receipts = includeReceipts ? await enrichReceipts(receiptTargets, rpc, concurrency, options.signal, maxReceipts, reasons) : { requested: 0, fetched: 0, status: "not-requested" };
  const prioritized = checkPriority([...accumulator.values()], maxCodeChecks);
  const classification = await classify(prioritized, rpc, concurrency, options.signal);
  for (const item of accumulator.values()) item.classification = classification.get(item.address) ?? "unknown";
  if ([...accumulator.values()].some((item) => item.classification === "unknown")) reasons.add("unknown-classification");
  const candidates = rankCandidates([...accumulator.values()].map((item) => ({
    address: item.address,
    chain: chain.id,
    classification: item.classification,
    transactionCount: item.transactionCount,
    sentTransactionCount: item.sentTransactionCount,
    receivedTransactionCount: item.receivedTransactionCount,
    ...(includeTraces ? { internalTransactionCount: item.internalTransactionCount, internalValue: item.internalValueWei } : {}),
    successfulTransactionCount: item.successfulTransactionCount,
    failedTransactionCount: item.failedTransactionCount,
    uniqueCounterpartyCount: item.counterparties.size,
    methods: [...item.methods],
    totalValue: item.nativeInWei + item.nativeOutWei,
    totalFees: item.feesKnown ? item.totalFeesWei.toString() : null,
    feesAvailable: item.feesKnown,
    firstSeen: item.firstSeen?.toString() ?? null,
    lastSeen: item.lastSeen?.toString() ?? null,
    evidence: item.evidence,
    coverage: { status: "partial", complete: false, partial: true, reasons: [] }
  }))).filter((item) => item.classification !== "contract");
  for (const item of candidates) {
    const complete = item.classification !== "unknown";
    item.coverage = { status: complete ? "complete" : "partial", complete, partial: !complete, reasons: complete ? [] : ["unknown-classification"] };
  }
  options.onProgress?.({ chain: chain.id, phase: "classified", completed: candidates.length, total: accumulator.size });
  const uniqueReasons = [...reasons].sort();
  const coverage = {
    status: uniqueReasons.length ? "partial" : "complete",
    complete: uniqueReasons.length === 0,
    partial: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    scannedBlocks: blocks.size.toString(),
    requestedBlocks: blockNumbers.length.toString(),
    transactions: transactions.toString(),
    ...(includeTraces ? { internalTransactions: internalTransactions.toString(), traceBlocksRequested: traceResult.requested.toString(), traceBlocksFetched: traceResult.fetched.toString(), traceStatus: traceResult.status, traceMethod: traceResult.method } : {}),
    candidates: candidates.length.toString(),
    reorgDetected: reasons.has("reorg-detected"),
    transactionCap,
    cappedBlocks,
    cappedTransactions: transactionCap,
    codeChecks: prioritized.length.toString(),
    ...(includeReceipts ? { receiptsRequested: receipts.requested.toString(), receiptsFetched: receipts.fetched.toString(), receiptsStatus: receipts.status } : {}),
    feesAvailable: [...accumulator.values()].some((item) => item.feesKnown),
    feeData: [...accumulator.values()].some((item) => item.feesKnown) ? "available" : "receipts-not-fetched"
  };
  const totalValue = [...accumulator.values()].reduce((total, item) => total + item.nativeInWei + item.nativeOutWei, 0n);
  const internalValue = [...accumulator.values()].reduce((total, item) => total + item.internalValueWei, 0n);
  const feesAvailable = [...accumulator.values()].some((item) => item.feesKnown);
  const totalFees = feesAvailable ? [...accumulator.values()].reduce((total, item) => total + (item.feesKnown ? item.totalFeesWei : 0n), 0n) : null;
  const headEvidence = blockEvidence.find((item) => item.blockNumber === toBlock.toString());
  return {
    schemaVersion: SCHEMA_VERSION,
    chain: chain.id,
    chainId: chain.chainId,
    family: chain.family,
    symbol: chain.symbol,
    explorerUrl: chain.explorerUrl,
    capabilities: chain.capabilities,
    zeroEx: chain.zeroEx,
    range: { unit: "blocks", from: effectiveFrom.toString(), to: toBlock.toString(), requested, capped: cappedBlocks, head: { number: toBlock.toString(), hash: headEvidence?.blockHash ?? null, tag: "latest" } },
    coverage,
    candidates,
    blockEvidence,
    stats: { blocks: blocks.size.toString(), transactions: transactions.toString(), ...(includeTraces ? { internalTransactions: internalTransactions.toString() } : {}), candidates: candidates.length.toString(), fees: totalFees?.toString() ?? null },
    totals: { value: totalValue.toString(), ...(includeTraces ? { internalValue: internalValue.toString() } : {}), fees: totalFees?.toString() ?? null }
  };
}

export class EVMScanner {
  constructor(options) {
    this.options = options;
  }

  scan(options = {}) {
    return scanEvm({ ...this.options, ...options });
  }
}
