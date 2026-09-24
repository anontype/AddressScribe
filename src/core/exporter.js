import { rankCandidates, serializeBigInt, toJsonSafe } from "./ranker.js";

export const ALLOWED_FIELDS = Object.freeze([
  "schemaVersion",
  "chain",
  "address",
  "classification",
  "activityScore",
  "score",
  "confidence",
  "coverage",
  "transactionCount",
  "successfulTransactionCount",
  "failedTransactionCount",
  "totalValue",
  "totalFees",
  "sentTransactionCount",
  "receivedTransactionCount",
  "uniqueCounterpartyCount",
  "methods",
  "firstSeen",
  "lastSeen",
  "evidence",
  "blockEvidence",
  "isContract",
  "isProgram"
]);

export const DEFAULT_EXPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "chain",
  "address",
  "classification",
  "activityScore",
  "score",
  "confidence",
  "coverage",
  "transactionCount",
  "successfulTransactionCount",
  "failedTransactionCount",
  "totalValue",
  "totalFees",
  "sentTransactionCount",
  "receivedTransactionCount",
  "uniqueCounterpartyCount",
  "methods",
  "firstSeen",
  "lastSeen",
  "evidence"
]);

export const EXPORT_FIELDS = ALLOWED_FIELDS;

/**
 * @typedef {Object} ExportOptions
 * @property {string[]} [fields]
 * @property {number} [limit]
 */

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * @param {ExportOptions|string[]|undefined} options
 * @returns {string[]}
 */
function selectFields(options) {
  const requested = Array.isArray(options) ? options : options && isStringArray(options.fields) ? options.fields : undefined;
  if (!requested) {
    return [...DEFAULT_EXPORT_FIELDS];
  }
  const selected = [];
  for (const field of requested) {
    if (ALLOWED_FIELDS.includes(field) && !selected.includes(field)) {
      selected.push(field);
    }
  }
  return selected.length > 0 ? selected : [...DEFAULT_EXPORT_FIELDS];
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function safeValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined) {
    return null;
  }
  return toJsonSafe(value);
}

/**
 * @param {Record<string, unknown>} candidate
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 */
function projectCandidate(candidate, fields) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) {
      result[field] = safeValue(candidate[field]);
    } else {
      result[field] = null;
    }
  }
  return result;
}

/**
 * @param {unknown[]} candidates
 * @param {ExportOptions|string[]} [options]
 * @returns {Record<string, unknown>[]}
 */
export function toExportRecords(candidates, options = {}) {
  const fields = selectFields(options);
  const optionObject = /** @type {ExportOptions} */ (
    options && typeof options === "object" && !Array.isArray(options) ? options : {}
  );
  const ranked = rankCandidates(candidates, {
    limit: optionObject.limit
  });
  return ranked.map((candidate) => projectCandidate(/** @type {Record<string, unknown>} */ (candidate), fields));
}

/**
 * @param {unknown[]} candidates
 * @param {ExportOptions|string[]} [options]
 * @returns {string}
 */
export function exportJson(candidates, options = {}) {
  const records = toExportRecords(candidates, options);
  return `${JSON.stringify(records, null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function csvValue(value) {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const serialized = toJsonSafe(value);
  return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeCsv(value) {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * @param {unknown[]} candidates
 * @param {ExportOptions|string[]} [options]
 * @returns {string}
 */
export function exportCsv(candidates, options = {}) {
  const fields = selectFields(options);
  const records = toExportRecords(candidates, options);
  const lines = [fields.map(escapeCsv).join(",")];
  for (const record of records) {
    lines.push(fields.map((field) => escapeCsv(csvValue(record[field]))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export const toJson = exportJson;
export const toCsv = exportCsv;
export const exportToJson = exportJson;
export const exportToCsv = exportCsv;
export const exportToJSON = exportJson;
export const exportToCSV = exportCsv;
export const jsonExporter = exportJson;
export const csvExporter = exportCsv;
export const serializeBigIntForExport = serializeBigInt;
