/**
 * @typedef {Object} CoverageInfo
 * @property {string} status
 * @property {boolean} partial
 * @property {boolean} complete
 * @property {string[]} reasons
 */

/**
 * @typedef {Object} Evidence
 * @property {string} [chain]
 * @property {string|number|bigint} [blockNumber]
 * @property {string} [blockHash]
 * @property {string} [transactionHash]
 * @property {number} [transactionIndex]
 * @property {string|number|bigint} [slot]
 * @property {string} [blockhash]
 * @property {string|number|bigint} [blockTime]
 * @property {string|number|bigint} [timestamp]
 * @property {string} [role]
 * @property {string} [method]
 * @property {string|number|bigint} [value]
 * @property {string|number|bigint} [fee]
 * @property {boolean} [success]
 * @property {string|number} [status]
 * @property {string} [signature]
 * @property {boolean} [feePayer]
 */

/**
 * @typedef {Object} ScoreBreakdown
 * @property {number} transactionActivity
 * @property {number} counterpartyActivity
 * @property {number} methodDiversity
 * @property {number} valueEvidence
 * @property {number} feeEvidence
 * @property {number} successEvidence
 * @property {number} contractPenalty
 * @property {number} programPenalty
 * @property {number} unknownClassificationPenalty
 */

/**
 * @typedef {Object} NormalizedCandidate
 * @property {number} schemaVersion
 * @property {string} chain
 * @property {string} address
 * @property {string} classification
 * @property {boolean} isContract
 * @property {boolean} isProgram
 * @property {number} transactionCount
 * @property {number} sentTransactionCount
 * @property {number} receivedTransactionCount
 * @property {number} internalTransactionCount
 * @property {string} internalValue
 * @property {number} successfulTransactionCount
 * @property {number} failedTransactionCount
 * @property {number} feePayerTransactionCount
 * @property {number} signerTransactionCount
 * @property {number} uniqueCounterpartyCount
 * @property {string} totalValue
 * @property {string} totalFees
 * @property {string[]} methods
 * @property {string} [firstSeen]
 * @property {string} [lastSeen]
 * @property {number} activityScore
 * @property {number} score
 * @property {ScoreBreakdown} scoreBreakdown
 * @property {number} confidence
 * @property {CoverageInfo} coverage
 * @property {Evidence[]} evidence
 * @property {Evidence[]} blockEvidence
 * @property {number} [rank]
 */

/**
 * @typedef {Record<string, unknown>} CandidateInput
 */

export const SCHEMA_VERSION = 1;
export const NORMALIZED_SCHEMA_VERSION = SCHEMA_VERSION;
export const SCHEMA_VERSION_STRING = "1.0";

const EVIDENCE_FIELDS = [
  "chain",
  "blockNumber",
  "blockHash",
  "transactionHash",
  "transactionIndex",
  "slot",
  "blockhash",
  "blockTime",
  "timestamp",
  "role",
  "method",
  "value",
  "valueWei",
  "fee",
  "feeWei",
  "success",
  "status",
  "signature",
  "feePayer",
  "callType",
  "traceAddress"
];

const SCORE_LIMITS = Object.freeze({
  transactionActivity: 40,
  counterpartyActivity: 20,
  methodDiversity: 10,
  valueEvidence: 8,
  feeEvidence: 7,
  successEvidence: 20
});

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @returns {value is bigint}
 */
function isBigInt(value) {
  return typeof value === "bigint";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function toJsonSafe(value, seen = new WeakSet()) {
  if (isBigInt(value)) {
    return value.toString();
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((item) => toJsonSafe(item, seen));
      seen.delete(value);
      return result;
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = toJsonSafe(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function serializeBigInt(value) {
  if (isBigInt(value)) {
    return value.toString();
  }
  if (typeof value === "string" && /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    try {
      return BigInt(value).toString();
    } catch {
      return value;
    }
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return value === null || typeof value === "undefined" ? "" : String(value);
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function stringField(value, fallback = "") {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (isBigInt(value)) {
    return value.toString();
  }
  return fallback;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      return [value];
    }
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function integerField(value) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.trunc(number));
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function quantityField(value) {
  if (isBigInt(value)) {
    return value < 0n ? 0n : value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value < 0 ? 0n : BigInt(value);
  }
  if (typeof value === "string" && /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value.trim())) {
    try {
      const parsed = BigInt(value.trim());
      return parsed < 0n ? 0n : parsed;
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * @param {unknown} value
 * @returns {CoverageInfo}
 */
export function normalizeCoverage(value) {
  if (!isRecord(value)) {
    return { status: "unknown", partial: true, complete: false, reasons: [] };
  }
  const rawStatus = typeof value.status === "string" ? value.status : "";
  const reasons = stringArray(value.reasons);
  const partial = typeof value.partial === "boolean" ? value.partial : rawStatus === "partial" || rawStatus === "unknown";
  const complete = typeof value.complete === "boolean" ? value.complete : !partial && rawStatus === "complete";
  return {
    status: complete ? "complete" : partial ? "partial" : rawStatus || "unknown",
    partial: !complete,
    complete,
    reasons: [...new Set(reasons)].sort()
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function classificationOf(value) {
  if (!isRecord(value)) {
    return "unknown";
  }
  const explicit = stringField(value.classification || value.accountType || value.kind).toLowerCase();
  if (explicit === "contract") {
    return "contract";
  }
  if (explicit === "program") {
    return "program";
  }
  if (explicit === "eoa" || explicit === "wallet" || explicit === "account") {
    return "eoa";
  }
  if (explicit === "token-account") {
    return "token-account";
  }
  if (value.isProgram === true || value.program === true || value.executable === true) {
    return "program";
  }
  if (value.isContract === true || value.contract === true || value.code === true) {
    return "contract";
  }
  return "unknown";
}

/**
 * @param {unknown} value
 * @returns {Evidence[]}
 */
function normalizeEvidence(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Record<string, unknown>[]} */
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    /** @type {Record<string, unknown>} */
    const normalized = {};
    for (const field of EVIDENCE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(item, field)) {
        const fieldValue = item[field];
        if (field === "transactionIndex" || field === "status") {
          normalized[field] = typeof fieldValue === "number" ? fieldValue : Number(fieldValue);
        } else if (field === "success" || field === "feePayer") {
          normalized[field] = Boolean(fieldValue);
        } else {
          const serialized = toJsonSafe(fieldValue);
          if (serialized !== null && typeof serialized !== "object") {
            normalized[field] = serialized;
          }
        }
      }
    }
    if (Object.keys(normalized).length === 0) {
      continue;
    }
    const key = JSON.stringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  result.sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
  return /** @type {Evidence[]} */ (result);
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function firstQuantity(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + quantityField(item), 0n);
  }
  return quantityField(value);
}

/**
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * @param {bigint} value
 * @returns {number}
 */
function magnitude(value) {
  if (value <= 0n) {
    return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 1;
  }
  return Math.log10(number + 1);
}

/**
 * @param {CandidateInput} candidate
 * @returns {ScoreBreakdown}
 */
function breakdownFor(candidate) {
  const transactionCount = integerField(candidate.transactionCount ?? candidate.activityCount ?? candidate.txCount);
  const successful = integerField(
    candidate.successfulTransactionCount ?? candidate.successCount ?? candidate.successfulTransactions
  );
  const failed = integerField(candidate.failedTransactionCount ?? candidate.failureCount ?? candidate.failedTransactions);
  const counterparties = integerField(
    candidate.uniqueCounterpartyCount ??
      candidate.counterpartyCount ??
      (Array.isArray(candidate.uniqueCounterparties) ? candidate.uniqueCounterparties.length : 0)
  );
  const methods = new Set(
    stringArray(candidate.methods ?? candidate.uniqueMethods).map((method) => method.toLowerCase())
  );
  const totalValue = firstQuantity(candidate.totalValue ?? candidate.totalValueWei ?? candidate.value);
  const feesAvailable = candidate.feesAvailable !== false && candidate.totalFees !== null && candidate.totalFees !== undefined;
  const totalFees = feesAvailable ? firstQuantity(candidate.totalFees ?? candidate.fees ?? candidate.fee) : 0n;
  const successTotal = successful + failed;
  const successEvidence = successTotal === 0 ? 0 : Math.round((successful / successTotal) * SCORE_LIMITS.successEvidence);
  const classification = classificationOf(candidate);
  return {
    transactionActivity: Math.round(
      clamp(SCORE_LIMITS.transactionActivity * Math.log2(transactionCount + 1), 0, SCORE_LIMITS.transactionActivity)
    ),
    counterpartyActivity: Math.round(
      clamp(SCORE_LIMITS.counterpartyActivity * Math.log2(counterparties + 1), 0, SCORE_LIMITS.counterpartyActivity)
    ),
    methodDiversity: Math.round(clamp(methods.size * 2, 0, SCORE_LIMITS.methodDiversity)),
    valueEvidence: Math.round(clamp(magnitude(totalValue) * 1.5, 0, SCORE_LIMITS.valueEvidence)),
    feeEvidence: feesAvailable ? Math.round(clamp(magnitude(totalFees) * 1.5, 0, SCORE_LIMITS.feeEvidence)) : 0,
    successEvidence,
    contractPenalty: classification === "contract" ? -20 : 0,
    programPenalty: classification === "program" ? -25 : 0,
    unknownClassificationPenalty: classification === "unknown" ? -5 : 0
  };
}

/**
 * @param {CandidateInput} candidate
 * @param {string} classification
 * @param {CoverageInfo} coverage
 * @returns {number}
 */
function confidenceFor(candidate, classification, coverage) {
  let confidence = coverage.complete ? 0.8 : 0.55;
  if (classification === "eoa") {
    confidence += 0.15;
  } else if (classification === "contract") {
    confidence += 0.15;
  } else if (classification === "program") {
    confidence += 0.15;
  } else {
    confidence -= 0.2;
  }
  const transactionCount = integerField(candidate.transactionCount ?? candidate.activityCount ?? candidate.txCount);
  if (transactionCount === 0) {
    confidence -= 0.3;
  }
  return Math.round(clamp(confidence, 0, 1) * 1000) / 1000;
}

/**
 * @param {unknown} input
 * @returns {NormalizedCandidate | null}
 */
export function normalizeCandidate(input) {
  if (!isRecord(input)) {
    return null;
  }
  const address = stringField(input.address ?? input.account ?? input.pubkey);
  if (!address) {
    return null;
  }
  const chain = stringField(input.chain ?? input.network, "unknown");
  const classification = classificationOf(input);
  const coverage = normalizeCoverage(input.coverage);
  const breakdown = breakdownFor(input);
  const activityScore = clamp(
    Object.values(breakdown).reduce((total, value) => total + value, 0),
    0,
    100
  );
  const candidate = /** @type {NormalizedCandidate} */ ({
    schemaVersion: SCHEMA_VERSION,
    chain,
    address,
    classification,
    isContract: classification === "contract",
    isProgram: classification === "program",
    transactionCount: integerField(input.transactionCount ?? input.activityCount ?? input.txCount),
    sentTransactionCount: integerField(input.sentTransactionCount ?? input.senderTransactionCount),
    receivedTransactionCount: integerField(input.receivedTransactionCount ?? input.recipientTransactionCount),
    internalTransactionCount: integerField(input.internalTransactionCount),
    internalValue: firstQuantity(input.internalValue ?? input.internalValueWei).toString(),
    successfulTransactionCount: integerField(
      input.successfulTransactionCount ?? input.successCount ?? input.successfulTransactions
    ),
    failedTransactionCount: integerField(
      input.failedTransactionCount ?? input.failureCount ?? input.failedTransactions
    ),
    feePayerTransactionCount: integerField(input.feePayerTransactionCount),
    signerTransactionCount: integerField(input.signerTransactionCount),
    uniqueCounterpartyCount: integerField(
      input.uniqueCounterpartyCount ??
        input.counterpartyCount ??
        (Array.isArray(input.uniqueCounterparties) ? input.uniqueCounterparties.length : 0)
    ),
    totalValue: (firstQuantity(input.totalValue ?? input.totalValueWei ?? input.value)).toString(),
    totalFees: input.feesAvailable === false || input.totalFees === null || input.totalFees === undefined ? null : firstQuantity(input.totalFees ?? input.fees ?? input.fee).toString(),
    feesAvailable: input.feesAvailable !== false && input.totalFees !== null && input.totalFees !== undefined,
    methods: [...new Set(stringArray(input.methods ?? input.uniqueMethods))].sort(),
    activityScore: Math.round(activityScore),
    score: Math.round(activityScore),
    scoreBreakdown: breakdown,
    confidence: confidenceFor(input, classification, coverage),
    coverage,
    evidence: normalizeEvidence(input.evidence),
    blockEvidence: normalizeEvidence(input.blockEvidence),
    ...(Array.isArray(input.tokenBalances) ? { tokenBalances: toJsonSafe(input.tokenBalances) } : {}),
    ...(isRecord(input.tokenEnrichment) ? { tokenEnrichment: toJsonSafe(input.tokenEnrichment) } : {})
  });
  const firstSeen = stringField(input.firstSeen ?? input.firstActivityAt);
  const lastSeen = stringField(input.lastSeen ?? input.lastActivityAt);
  if (firstSeen) {
    candidate.firstSeen = firstSeen;
  }
  if (lastSeen) {
    candidate.lastSeen = lastSeen;
  }
  return candidate;
}

/**
 * @param {NormalizedCandidate} left
 * @param {NormalizedCandidate} right
 * @returns {number}
 */
export function compareCandidates(left, right) {
  if (left.activityScore !== right.activityScore) {
    return right.activityScore - left.activityScore;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  if (left.transactionCount !== right.transactionCount) {
    return right.transactionCount - left.transactionCount;
  }
  const chainOrder = compareText(left.chain, right.chain);
  if (chainOrder !== 0) {
    return chainOrder;
  }
  return compareText(left.address, right.address);
}

/**
 * @param {unknown[]} candidates
 * @param {{limit?: number}} [options]
 * @returns {NormalizedCandidate[]}
 */
export function rankCandidates(candidates, options = {}) {
  const normalized = candidates
    .map((candidate) => normalizeCandidate(candidate))
    .filter((candidate) => candidate !== null);
  normalized.sort(compareCandidates);
  const limit = integerField(options.limit);
  const limited = limit > 0 ? normalized.slice(0, limit) : normalized;
  limited.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  return limited;
}

/**
 * @param {CandidateInput} candidate
 * @returns {number}
 */
export function scoreCandidate(candidate) {
  const normalized = normalizeCandidate(candidate);
  return normalized === null ? 0 : normalized.activityScore;
}

/**
 * @param {CandidateInput} candidate
 * @returns {{score: number, breakdown: ScoreBreakdown, confidence: number}}
 */
export function scoreActivity(candidate) {
  const normalized = normalizeCandidate(candidate);
  return normalized === null
    ? { score: 0, breakdown: breakdownFor(candidate), confidence: 0 }
    : { score: normalized.activityScore, breakdown: normalized.scoreBreakdown, confidence: normalized.confidence };
}

/**
 * @param {unknown[]} candidates
 * @param {{limit?: number}} [options]
 * @returns {NormalizedCandidate[]}
 */
export function prioritizeCandidates(candidates, options = {}) {
  return rankCandidates(candidates, options);
}

export const rankWallets = rankCandidates;
export const calculateActivityScore = scoreCandidate;
export const rank = rankCandidates;
