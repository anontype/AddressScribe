import { getChain } from "../config/chains.js";
import { makeRpcAdapter } from "../core/client-adapter.js";
import { rankCandidates, SCHEMA_VERSION } from "../core/ranker.js";

export const SOLANA_LIMITS = Object.freeze({
  slots: 50,
  transactions: 100000,
  candidates: 2000,
  accountChecks: 500,
  batchSize: 20,
  concurrency: 12
});

const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";
export const KNOWN_PROGRAM_IDS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Ed25519Program111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  VOTE_PROGRAM,
  "Stake11111111111111111111111111111111111111"
]);

const TOKEN_OWNERS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

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

function publicKey(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
}

function signature(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
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

function accountKeys(transaction) {
  const message = isRecord(transaction?.transaction) ? transaction.transaction.message : transaction?.message;
  const raw = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  return raw.map((item) => {
    if (typeof item === "string") return { address: publicKey(item), signer: false, writable: false };
    return {
      address: publicKey(item?.pubkey),
      signer: item?.signer === true,
      writable: item?.writable === true
    };
  }).filter((item) => item.address);
}

function isVoteTransaction(transaction) {
  const message = isRecord(transaction?.transaction) ? transaction.transaction.message : transaction?.message;
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  const programIds = instructions.map((instruction) => instruction?.programId ?? instruction?.program).filter(Boolean);
  return programIds.includes(VOTE_PROGRAM) && programIds.every((programId) => programId === VOTE_PROGRAM || programId === "11111111111111111111111111111111" || programId === "ComputeBudget111111111111111111111111111111");
}

function signatureOf(transaction) {
  const signatures = transaction?.transaction?.signatures ?? transaction?.signatures;
  return Array.isArray(signatures) ? signature(signatures[0]) : null;
}

function addCandidate(map, value, chain, maxCandidates, reasons) {
  const normalized = publicKey(value);
  if (!normalized || KNOWN_PROGRAM_IDS.has(normalized)) return null;
  const existing = map.get(normalized);
  if (existing) return existing;
  if (map.size >= maxCandidates) {
    reasons.add("candidate-cap");
    return null;
  }
  const item = {
    address: normalized,
    chain: chain.id,
    classification: "unknown",
    transactionCount: 0,
    signerTransactionCount: 0,
    feePayerTransactionCount: 0,
    successfulTransactionCount: 0,
    failedTransactionCount: 0,
    totalFeesLamports: 0n,
    failedFeesLamports: 0n,
    feesKnown: false,
    counterparties: new Set(),
    evidence: [],
    firstSeen: null,
    lastSeen: null
  };
  map.set(normalized, item);
  return item;
}

function record(item, keys, fee, success, slot, blockhash, blockTime, signatureValue) {
  item.transactionCount += 1;
  if (keys.signer) item.signerTransactionCount += 1;
  if (fee !== null) item.feesKnown = true;
  if (keys.feePayer) {
    item.feePayerTransactionCount += 1;
    if (fee !== null) {
      item.totalFeesLamports += fee;
      if (success === false) item.failedFeesLamports += fee;
    }
  }
  if (success === true) item.successfulTransactionCount += 1;
  if (success === false) item.failedTransactionCount += 1;
  for (const counterparty of keys.counterparties) {
    if (counterparty !== item.address) item.counterparties.add(counterparty);
  }
  if (item.evidence.length < 12) {
    item.evidence.push({
      slot: slot.toString(),
      blockhash,
      blockTime,
      signature: signatureValue,
      role: keys.feePayer && keys.signer ? "fee-payer-signer" : keys.feePayer ? "fee-payer" : "signer",
      feeLamports: fee === null ? null : fee.toString(),
      success
    });
  }
  if (blockTime != null) {
    const time = BigInt(blockTime);
    item.firstSeen = item.firstSeen == null || time < item.firstSeen ? time : item.firstSeen;
    item.lastSeen = item.lastSeen == null || time > item.lastSeen ? time : item.lastSeen;
  }
}

function accountClass(account) {
  if (!isRecord(account)) return "unknown";
  if (account.executable === true) return "program";
  if (TOKEN_OWNERS.has(account.owner)) return "token-account";
  if (account.owner === "11111111111111111111111111111111") return "eoa";
  return "account";
}

async function classify(values, rpc, signal) {
  const output = new Map();
  for (const group of chunks(values, 100)) {
    checkSignal(signal);
    const addresses = group.map((item) => item.address);
    const params = [addresses, { encoding: "base64", commitment: "finalized" }];
    let response = null;
    try {
      const responses = await rpc.batch([{ method: "getMultipleAccounts", params }], signal);
      if (responses) response = responses[0] ?? null;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === "rate_limited") {
        for (const item of group) output.set(item.address, "unknown");
        continue;
      }
    }
    if (!response || response.ok === false) {
      try {
        response = { ok: true, result: await rpc.call("getMultipleAccounts", params, signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        for (const item of group) output.set(item.address, "unknown");
        continue;
      }
    }
    const accounts = response.ok && isRecord(response.result) && Array.isArray(response.result.value) ? response.result.value : [];
    for (let index = 0; index < group.length; index += 1) {
      output.set(group[index].address, accountClass(accounts[index]));
    }
  }
  return output;
}

export async function scanSolana(options = {}) {
  const chain = options.chain ?? getChain("solana");
  const rpc = makeRpcAdapter(options.client);
  const requested = bounded(options.slots ?? options.blocks ?? options.amount, 10, 1, SOLANA_LIMITS.slots);
  const slotLimit = bounded(options.maxSlots, SOLANA_LIMITS.slots, 1, SOLANA_LIMITS.slots);
  const concurrency = bounded(options.concurrency, 4, 1, SOLANA_LIMITS.concurrency);
  const maxTransactions = bounded(options.maxTransactions, SOLANA_LIMITS.transactions, 1, SOLANA_LIMITS.transactions);
  const maxCandidates = bounded(options.maxCandidates, SOLANA_LIMITS.candidates, 1, SOLANA_LIMITS.candidates);
  const maxAccountChecks = bounded(options.maxAccountChecks, SOLANA_LIMITS.accountChecks, 1, SOLANA_LIMITS.accountChecks);
  const commitment = options.commitment === "confirmed" ? "confirmed" : "finalized";
  const reasons = new Set();
  let head = options.head == null ? null : inputQuantity(options.head, "head");
  if (head == null && (options.fromSlot == null || options.toSlot == null)) head = quantity(await rpc.call("getSlot", [{ commitment }], options.signal));
  const toSlot = options.toSlot == null ? head : inputQuantity(options.toSlot, "toSlot");
  const fromSlot = options.fromSlot == null ? toSlot - BigInt(requested - 1) : inputQuantity(options.fromSlot, "fromSlot");
  if (fromSlot < 0n || toSlot < fromSlot) throw new RangeError("Invalid Solana slot range");
  let cappedSlots = false;
  let effectiveFrom = fromSlot;
  const span = toSlot - fromSlot + 1n;
  if (span > BigInt(slotLimit)) {
    effectiveFrom = toSlot - BigInt(slotLimit - 1);
    cappedSlots = true;
    reasons.add("slot-cap");
  }
  const slots = [];
  for (let slot = effectiveFrom; slot <= toSlot; slot += 1n) slots.push(slot);
  const blocks = new Map();
  const blockEvidence = [];
  let completed = 0;
  let skippedSlots = 0;
  for (const group of chunks(slots, SOLANA_LIMITS.batchSize)) {
    checkSignal(options.signal);
    const requests = group.map((slot) => ({
      method: "getBlock",
      params: [Number(slot), {
        encoding: "jsonParsed",
        transactionDetails: "full",
        rewards: false,
        maxSupportedTransactionVersion: 1
      }]
    }));
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
        if (response?.ok && response.result === null) {
          skippedSlots += 1;
          reasons.add("skipped-slots");
        } else if (response?.ok && isRecord(response.result)) {
          const block = response.result;
          blocks.set(group[index], block);
          blockEvidence.push({ slot: group[index].toString(), blockhash: typeof block.blockhash === "string" ? block.blockhash : null, previousBlockhash: typeof block.previousBlockhash === "string" ? block.previousBlockhash : null });
        } else {
          reasons.add("block-request-failed");
        }
      }
    } else {
      await mapConcurrent(group, concurrency, async (slot, index) => {
        checkSignal(options.signal);
        try {
          const response = await rpc.call("getBlock", requests[index].params, options.signal);
          if (response === null) {
            skippedSlots += 1;
            reasons.add("skipped-slots");
          } else if (isRecord(response)) {
            blocks.set(slot, response);
            blockEvidence.push({ slot: slot.toString(), blockhash: typeof response.blockhash === "string" ? response.blockhash : null, previousBlockhash: typeof response.previousBlockhash === "string" ? response.previousBlockhash : null });
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
    options.onProgress?.({ chain: chain.id, phase: "slots", completed, total: slots.length });
  }
  blockEvidence.sort((left, right) => {
    const a = BigInt(left.slot);
    const b = BigInt(right.slot);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let previousEvidence = null;
  for (const evidence of blockEvidence) {
    if (previousEvidence && BigInt(evidence.slot) === BigInt(previousEvidence.slot) + 1n && evidence.previousBlockhash && previousEvidence.blockhash && evidence.previousBlockhash !== previousEvidence.blockhash) {
      reasons.add("reorg-detected");
      break;
    }
    previousEvidence = evidence;
  }
  const accumulator = new Map();
  let transactions = 0;
  let transactionCap = false;
  let voteTransactions = 0;
  outer: for (const slot of slots) {
    if (transactions >= maxTransactions) {
      transactionCap = true;
      reasons.add("transaction-cap");
      break;
    }
    const block = blocks.get(slot);
    if (!block) continue;
    if (!Array.isArray(block.transactions)) {
      reasons.add("block-data-unavailable");
      continue;
    }
    const blockhash = typeof block.blockhash === "string" ? block.blockhash : null;
    const blockTime = optionalQuantity(block.blockTime ?? block.block_time);
    for (const transaction of block.transactions) {
      if (transactions >= maxTransactions) {
        transactionCap = true;
        reasons.add("transaction-cap");
        break outer;
      }
      if (isVoteTransaction(transaction)) {
        voteTransactions += 1;
        continue;
      }
      transactions += 1;
      const keys = accountKeys(transaction);
      if (!keys.length) {
        reasons.add("transaction-keys-missing");
        continue;
      }
      const feePayer = keys[0]?.address;
      const signatureValue = signatureOf(transaction);
      const success = isRecord(transaction?.meta) && Object.hasOwn(transaction.meta, "err") ? transaction.meta.err === null : null;
      if (success === null) reasons.add("transaction-status-unavailable");
      const fee = optionalQuantity(transaction?.meta?.fee);
      const signerAddresses = new Set(keys.filter((item) => item.signer).map((item) => item.address));
      if (feePayer) signerAddresses.add(feePayer);
      for (const itemAddress of signerAddresses) {
        const item = addCandidate(accumulator, itemAddress, chain, maxCandidates, reasons);
        if (!item) continue;
        record(item, {
          signer: signerAddresses.has(itemAddress) && keys.some((key) => key.address === itemAddress && key.signer),
          feePayer: itemAddress === feePayer,
          counterparties: keys.map((key) => key.address)
        }, fee, success, slot, blockhash, blockTime, signatureValue);
      }
    }
  }
  const prioritized = checkPriority([...accumulator.values()], maxAccountChecks);
  const classification = await classify(prioritized, rpc, options.signal);
  for (const item of accumulator.values()) item.classification = classification.get(item.address) ?? "unknown";
  if ([...accumulator.values()].some((item) => item.classification === "unknown")) reasons.add("unknown-classification");
  if ([...accumulator.values()].some((item) => !item.feesKnown)) reasons.add("fee-data-unavailable");
  const candidates = rankCandidates([...accumulator.values()].map((item) => ({
    address: item.address,
    chain: chain.id,
    classification: item.classification,
    transactionCount: item.transactionCount,
    signerTransactionCount: item.signerTransactionCount,
    feePayerTransactionCount: item.feePayerTransactionCount,
    successfulTransactionCount: item.successfulTransactionCount,
    failedTransactionCount: item.failedTransactionCount,
    uniqueCounterpartyCount: item.counterparties.size,
    totalFees: item.feesKnown ? item.totalFeesLamports : null,
    feesAvailable: item.feesKnown,
    firstSeen: item.firstSeen?.toString() ?? null,
    lastSeen: item.lastSeen?.toString() ?? null,
    evidence: item.evidence,
    coverage: { status: "partial", complete: false, partial: true, reasons: [] }
  }))).filter((item) => item.classification !== "program");
  for (const item of candidates) {
    const complete = item.classification !== "unknown";
    item.coverage = { status: complete ? "complete" : "partial", complete, partial: !complete, reasons: complete ? [] : ["unknown-classification"] };
  }
  options.onProgress?.({ chain: chain.id, phase: "classified", completed: candidates.length, total: accumulator.size });
  const uniqueReasons = [...reasons].sort();
  const allFeesKnown = [...accumulator.values()].every((item) => item.feesKnown);
  const coverage = {
    status: uniqueReasons.length ? "partial" : "complete",
    complete: uniqueReasons.length === 0,
    partial: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    scannedSlots: blocks.size.toString(),
    requestedSlots: slots.length.toString(),
    skippedSlots: skippedSlots.toString(),
    notes: skippedSlots > 0 ? ["skipped-slots"] : [],
    transactions: transactions.toString(),
    voteTransactionsSkipped: voteTransactions.toString(),
    candidates: candidates.length.toString(),
    reorgDetected: reasons.has("reorg-detected"),
    transactionCap,
    cappedSlots,
    cappedTransactions: transactionCap,
    feesAvailable: allFeesKnown,
    feeData: allFeesKnown ? "available" : "unavailable",
    accountChecks: prioritized.length.toString()
  };
  const totalFees = allFeesKnown ? [...accumulator.values()].reduce((total, item) => total + item.totalFeesLamports, 0n) : null;
  const failedFees = allFeesKnown ? [...accumulator.values()].reduce((total, item) => total + item.failedFeesLamports, 0n) : null;
  const headEvidence = blockEvidence.find((item) => item.slot === toSlot.toString());
  return {
    schemaVersion: SCHEMA_VERSION,
    chain: chain.id,
    chainId: chain.chainId,
    family: chain.family,
    symbol: chain.symbol,
    explorerUrl: chain.explorerUrl,
    capabilities: chain.capabilities,
    zeroEx: chain.zeroEx,
    range: { unit: "slots", from: effectiveFrom.toString(), to: toSlot.toString(), requested, capped: cappedSlots, head: { slot: toSlot.toString(), blockhash: headEvidence?.blockhash ?? null, previousBlockhash: headEvidence?.previousBlockhash ?? null, commitment } },
    coverage,
    candidates,
    blockEvidence,
    stats: { slots: blocks.size.toString(), transactions: transactions.toString(), candidates: candidates.length.toString(), fees: totalFees.toString() },
    totals: { fees: totalFees.toString(), failedFees: failedFees.toString() }
  };
}

export class SolanaScanner {
  constructor(options) {
    this.options = options;
  }

  scan(options = {}) {
    return scanSolana({ ...this.options, ...options });
  }
}
