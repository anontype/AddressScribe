/**
 * @typedef {Record<string, unknown>} JsonRecord
 */

const REDACTED = "<redacted>";
const REDACTED_URL = "<redacted-url>";
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const SENSITIVE_KEY_RE = /(?:^|[-_])(api[-_]?key|apikey|access[-_]?token|auth(?:orization)?|token|secret|password|passwd|private[-_]?key|private|project[-_]?id|cookie|set[-_]?cookie|credential|credentials|seed|mnemonic)(?:$|[-_])/i;
const URL_FIELD_RE = /^(?:rpc(?:_?urls?|_?url)?|rpc_?candidates|rpcs|selectedrpcurl|primaryrpcurl|readrpc(?:s|urls?)?|wsrpcurl|wssrpcurl|httpurl|finalurl|endpoint|url)$/i;
const OPAQUE_SEGMENT_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{20,}$/i;
const VERSION_SEGMENT_RE = /^v\d+$/i;

/**
 * @param {unknown} value
 * @returns {value is JsonRecord}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function sensitiveKey(value) {
  return SENSITIVE_KEY_RE.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function opaquePathSegment(value) {
  return OPAQUE_SEGMENT_RE.test(value) && !/^0x[0-9a-f]+$/i.test(value);
}

/**
 * @param {string} value
 * @param {string} previous
 * @returns {boolean}
 */
function secretPathSegment(value, previous) {
  if (!value) return false;
  if (VERSION_SEGMENT_RE.test(previous) || sensitiveKey(previous) || sensitiveKey(value)) return true;
  if (/(?:^|[-_])(?:key|secret|token|password|credential|credentials|private|seed|mnemonic)(?:$|[-_])/i.test(value)) return true;
  return opaquePathSegment(value);
}

/**
 * @param {URL} parsed
 * @returns {string}
 */
function redactedPath(parsed) {
  const parts = parsed.pathname.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    if (secretPathSegment(parts[index] ?? "", parts[index - 1] ?? "")) parts[index] = REDACTED;
  }
  return parts.join("/");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactUrl(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return REDACTED_URL;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return REDACTED_URL;
  const hasQueryOrHash = Boolean(parsed.search || parsed.hash);
  const pathParts = parsed.pathname.split("/");
  const pathIsSecret = pathParts.some((part, index) => secretPathSegment(part, pathParts[index - 1] ?? ""));
  if (!parsed.username && !parsed.password && !hasQueryOrHash && !pathIsSecret) {
    return text;
  }
  const path = redactedPath(parsed);
  return `${parsed.protocol}//${parsed.host}${path}${hasQueryOrHash ? "?redacted" : ""}`;
}

/**
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
export function redactRpcUrl(value) {
  return value === null || value === undefined ? value : redactUrl(value);
}

/**
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
export function redactUrlCredentials(value) {
  return value === null || value === undefined ? value : redactUrl(value);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactRpcUrlList(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => item === null || item === undefined ? item : redactUrl(item));
  return redactUrl(value);
}

/**
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
export function redactRpcText(value) {
  if (value === null || value === undefined) return value;
  return typeof value === "string" ? redactText(value) : sanitizeErrorText(value);
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @returns {string}
 */
function redactString(value, key = "") {
  if (sensitiveKey(key)) return REDACTED;
  if (URL_FIELD_RE.test(key)) return /** @type {string} */ (redactUrl(value));
  return redactText(String(value));
}

/**
 * @param {string} text
 * @returns {string}
 */
function redactText(text) {
  return text.replace(URL_RE, (match) => {
    const trailing = match.match(/[),.;!?\]}]+$/)?.[0] ?? "";
    const rawUrl = trailing ? match.slice(0, -trailing.length) : match;
    return `${redactUrl(rawUrl)}${trailing}`;
  });
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function redactData(value, key = "", seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value, key);
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => redactData(item, key, seen));
  } else if (isRecord(value)) {
    result = /** @type {Record<string, unknown>} */ ({});
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sensitiveKey(childKey) ? REDACTED : redactData(childValue, childKey, seen);
    }
  } else {
    result = REDACTED;
  }
  seen.delete(value);
  return result;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactRpcData(value) {
  return redactData(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function withoutControlCharacters(value) {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    output += code < 32 && character !== "\n" && character !== "\r" && character !== "\t" ? " " : character;
  }
  return output;
}

function redactAssignments(value) {
  return value.replace(
    /(\b(?:api[-_]?key|access[-_]?token|auth(?:orization)?|token|secret|password|private[-_]?key|credential|credentials|seed|mnemonic)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACTED}`
  );
}

function redactLabels(value) {
  return value.replace(
    /(["']?)([A-Za-z][A-Za-z0-9_-]{1,48})\1\s*([:=])\s*(["']?)([^\s,;}=]+|\{[^}]*\})\4(?=\s|[,;}]|$)/gi,
    (match, quote, name, separator, valueQuote) => {
      if (!sensitiveKey(name)) return match;
      return `${quote}${name}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    }
  );
}

export function sanitizeErrorText(value) {
  const input = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "");
  const withoutControls = withoutControlCharacters(input).replace(/\s+/g, " ").trim();
  const withUrls = redactText(withoutControls);
  const withCredentials = redactAssignments(withUrls.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED}`));
  return redactLabels(withCredentials).slice(0, 2000);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeError(value) {
  return sanitizeErrorText(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeErrorMessage(value) {
  return sanitizeErrorText(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeForLogging(value) {
  return sanitizeErrorText(value);
}

/**
 * @param {unknown} error
 * @param {string} [fallback]
 * @returns {Error & {code?: string|number, status?: number, retryAfterMs?: number}}
 */
export function toSafeError(error, fallback = "RPC request failed") {
  const source = isRecord(error) ? error : {};
  const safe = /** @type {Error & {code?: string|number, status?: number, retryAfterMs?: number}} */ (
    new Error(sanitizeErrorText(source.message ?? error ?? fallback) || fallback)
  );
  safe.name = typeof source.name === "string" ? source.name.slice(0, 80) : "Error";
  if (typeof source.code === "string" || typeof source.code === "number") safe.code = source.code;
  if (typeof source.status === "number") safe.status = source.status;
  if (typeof source.retryAfterMs === "number" && Number.isFinite(source.retryAfterMs)) safe.retryAfterMs = source.retryAfterMs;
  return safe;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return sanitizeErrorText(value);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
export function rpcJsonReplacer(key, value) {
  if (typeof value === "string") return redactString(value, key);
  if (typeof value === "bigint") return value.toString();
  return value;
}

export const redactRpcList = redactRpcUrlList;
export const sanitizeErrorString = sanitizeErrorText;
export const redactSensitiveData = redactData;
