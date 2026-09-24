import { redactRpcUrl } from "../core/privacy.js";
import { CHAIN_REGISTRY, findChain, getChain } from "./chains.js";

/**
 * @typedef {"json"|"jsonl"|"csv"|"none"} OutputFormat
 * @typedef {Object} RuntimeConfig
 * @property {string} chain
 * @property {string} chainName
 * @property {number} chainId
 * @property {"evm"|"svm"} kind
 * @property {number|null} blocks
 * @property {number|null} slots
 * @property {{unit: "blocks"|"slots", amount: number, max: number}} range
 * @property {number} concurrency
 * @property {number} timeoutMs
 * @property {number} rpcTimeoutMs
 * @property {number} maxRetries
 * @property {number} requestsPerSecond
 * @property {number} burst
 * @property {OutputFormat} output
 * @property {string|null} outputPath
 * @property {string|null} stateFile
 * @property {string[]} rpcUrls
 * @property {string[]} redactedRpcUrls
 * @property {string[]} safeRpcUrls
 * @property {boolean} readOnly
 * @property {boolean} execution
 * @property {boolean} browserPersistence
 * @property {boolean} telemetry
 * @property {boolean} cookies
 */

export const RUNTIME_LIMITS = Object.freeze({
  maxBlocks: 50,
  maxSlots: 50,
  maxConcurrency: 8,
  minTimeoutMs: 100,
  maxTimeoutMs: 300000,
  maxRpcTimeoutMs: 30000,
  maxRetries: 5,
  maxRequestsPerSecond: 1000,
  maxBurst: 100,
  maxResponseBytes: 16 * 1024 * 1024,
  maxBatchSize: 100
});

export const RUNTIME_DEFAULTS = Object.freeze({
  chain: "ethereum",
  blocks: 10,
  slots: 10,
  concurrency: 4,
  timeoutMs: 30000,
  rpcTimeoutMs: 10000,
  maxRetries: 2,
  requestsPerSecond: 10,
  burst: 10,
  maxResponseBytes: 16 * 1024 * 1024,
  maxBatchSize: 100,
  output: "json",
  outputPath: null,
  stateFile: null
});

const OUTPUT_FORMATS = new Set(["json", "jsonl", "csv", "none"]);
const MAX_RPC_URLS = 16;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function cleanString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function defaultEnvironment() {
  const globalObject = /** @type {{process?: {env?: Record<string, unknown>}}} */ (globalThis);
  return globalObject.process?.env ?? {};
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number.isSafeInteger(value) ? Number(value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = numberValue(value);
  if (parsed === null || !Number.isSafeInteger(parsed)) throw new TypeError("Numeric configuration must be an integer");
  if (parsed < minimum || parsed > maximum) throw new RangeError(`Numeric configuration must be between ${minimum} and ${maximum}`);
  return parsed;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string[]} names
 * @returns {unknown}
 */
function firstEnvValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

/**
 * @param {string} slug
 * @returns {string}
 */
function rpcEnvName(slug) {
  return `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_RPC_URL`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function rpcValues(value) {
  if (typeof value === "string") return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => rpcValues(item));
  if (isRecord(value)) {
    for (const key of ["http", "https", "urls", "rpcUrls", "rpc_urls"]) {
      if (value[key] !== undefined) return rpcValues(value[key]);
    }
  }
  return [];
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeHttpUrl(value) {
  const text = cleanString(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
function normalizeRpcValues(value, label) {
  const values = rpcValues(value);
  if (!values.length) return [];
  const urls = [];
  for (const item of values) {
    const url = normalizeHttpUrl(item);
    if (!url) throw new TypeError(`${label} must contain HTTP or HTTPS RPC URLs`);
    urls.push(url);
  }
  const unique = [...new Set(urls)];
  if (unique.length > MAX_RPC_URLS) throw new RangeError(`${label} contains too many RPC URLs`);
  return unique;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseRpcMap(value) {
  if (value === undefined || value === null || String(value).trim() === "") return {};
  if (typeof value !== "string") {
    if (!isRecord(value)) throw new TypeError("ADDRESSSCRIBE_RPC_URLS must be a JSON object");
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("ADDRESSSCRIBE_RPC_URLS is not valid JSON");
  }
  if (!isRecord(parsed)) throw new TypeError("ADDRESSSCRIBE_RPC_URLS must be a JSON object");
  return parsed;
}

/**
 * @param {Record<string, unknown>} map
 * @param {string} chainId
 * @param {string} slug
 * @returns {string[]}
 */
function rpcMapValue(map, chainId, slug) {
  const direct = map[slug] ?? map[slug.toUpperCase()] ?? map[chainId];
  if (direct === undefined) return [];
  return normalizeRpcValues(direct, "ADDRESSSCRIBE_RPC_URLS");
}

/**
 * @param {unknown} selector
 * @param {ReturnType<typeof getChain>[]} [registry]
 * @returns {ReturnType<typeof getChain>}
 */
function resolveSelectedChain(selector, registry = CHAIN_REGISTRY) {
  if (isRecord(selector) && (typeof selector.id === "string" || typeof selector.slug === "string")) {
    const key = selector.id ?? selector.slug;
    const selected = registry.find((chain) => chain.id === key || chain.slug === key);
    if (!selected) throw new RangeError(`Unknown chain: ${key}`);
    return selected;
  }
  if (selector === undefined || selector === null || selector === "") return registry.find((chain) => chain.id === RUNTIME_DEFAULTS.chain) ?? getChain(RUNTIME_DEFAULTS.chain);
  if (typeof selector === "number" || typeof selector === "string") {
    const normalized = typeof selector === "string" && /^\d+$/.test(selector.trim()) ? Number(selector.trim()) : selector;
    const matched = findChain(normalized);
    const selected = matched && registry.includes(matched)
      ? matched
      : registry.find((chain) => chain.chainId === normalized);
    if (!selected) throw new RangeError(`Unknown chain: ${String(selector)}`);
    return selected;
  }
  throw new TypeError("Chain selection must be a slug, numeric chain id, or chain record");
}

/**
 * @param {unknown} value
 * @returns {OutputFormat}
 */
function normalizeOutput(value) {
  if (value === undefined || value === null || value === "") return RUNTIME_DEFAULTS.output;
  if (typeof value !== "string") throw new TypeError("Output format must be a string");
  const text = value.trim();
  if (!text) return RUNTIME_DEFAULTS.output;
  const normalized = text.toLowerCase();
  if (!OUTPUT_FORMATS.has(/** @type {OutputFormat} */ (normalized))) throw new RangeError("Output format must be json, jsonl, csv or none");
  return /** @type {OutputFormat} */ (normalized);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {{env?: Record<string, unknown>, chain?: unknown, chainId?: unknown, registry?: ReturnType<typeof getChain>[], blocks?: unknown, slots?: unknown, concurrency?: unknown, timeoutMs?: unknown, rpcTimeoutMs?: unknown, maxRetries?: unknown, requestsPerSecond?: unknown, burst?: unknown, output?: unknown, outputPath?: unknown, stateFile?: unknown}} [input]
 * @returns {RuntimeConfig}
 */
export function getRuntimeConfig(input = {}) {
  const env = input.env ?? defaultEnvironment();
  const registry = input.registry ?? CHAIN_REGISTRY;
  const chainSelector = input.chain ?? firstEnvValue(env, ["ADDRESSSCRIBE_CHAIN"]);
  const chainIdSelector = input.chainId ?? firstEnvValue(env, ["ADDRESSSCRIBE_CHAIN_ID"]);
  const selected = resolveSelectedChain(chainSelector ?? chainIdSelector, registry);
  const kind = selected.kind ?? selected.family;
  const slug = selected.slug ?? selected.id;
  const amount = kind === "svm"
    ? boundedNumber(
        input.slots ?? firstEnvValue(env, ["ADDRESSSCRIBE_SLOTS"]),
        RUNTIME_DEFAULTS.slots,
        1,
        RUNTIME_LIMITS.maxSlots
      )
    : boundedNumber(
        input.blocks ?? firstEnvValue(env, ["ADDRESSSCRIBE_BLOCKS"]),
        RUNTIME_DEFAULTS.blocks,
        1,
        RUNTIME_LIMITS.maxBlocks
      );
  const rpcMap = parseRpcMap(env.ADDRESSSCRIBE_RPC_URLS);
  const mapped = rpcMapValue(rpcMap, String(selected.chainId), slug);
  const envOverride = normalizeRpcValues(env[rpcEnvName(slug)], `${rpcEnvName(slug)}`);
  const rpcUrls = [...new Set([...envOverride, ...mapped, ...(selected.rpcUrls ?? [])])];
  if (rpcUrls.length > MAX_RPC_URLS) throw new RangeError("Too many RPC URLs configured");
  const timeoutMs = boundedNumber(
    input.timeoutMs ?? firstEnvValue(env, ["ADDRESSSCRIBE_TIMEOUT_MS"]),
    RUNTIME_DEFAULTS.timeoutMs,
    RUNTIME_LIMITS.minTimeoutMs,
    RUNTIME_LIMITS.maxTimeoutMs
  );
  const rpcTimeoutMs = Math.min(
    timeoutMs,
    boundedNumber(
      input.rpcTimeoutMs ?? firstEnvValue(env, ["ADDRESSSCRIBE_RPC_TIMEOUT_MS"]),
      RUNTIME_DEFAULTS.rpcTimeoutMs,
      RUNTIME_LIMITS.minTimeoutMs,
      RUNTIME_LIMITS.maxRpcTimeoutMs
    )
  );
  const outputValue = input.output ?? firstEnvValue(env, ["ADDRESSSCRIBE_OUTPUT"]);
  const stateValue = input.stateFile ?? firstEnvValue(env, ["ADDRESSSCRIBE_STATE_FILE"]);
  const outputPathValue = input.outputPath ?? firstEnvValue(env, ["ADDRESSSCRIBE_OUTPUT_PATH"]);
  const config = {
    chain: selected.id,
    chainName: selected.name,
    chainId: selected.chainId,
    kind,
    blocks: kind === "evm" ? amount : null,
    slots: kind === "svm" ? amount : null,
    range: {
      unit: /** @type {"blocks"|"slots"} */ (selected.rangeUnit ?? (kind === "svm" ? "slots" : "blocks")),
      amount,
      max: kind === "svm" ? RUNTIME_LIMITS.maxSlots : RUNTIME_LIMITS.maxBlocks
    },
    concurrency: boundedNumber(
      input.concurrency ?? firstEnvValue(env, ["ADDRESSSCRIBE_CONCURRENCY"]),
      RUNTIME_DEFAULTS.concurrency,
      1,
      RUNTIME_LIMITS.maxConcurrency
    ),
    timeoutMs,
    rpcTimeoutMs,
    maxRetries: boundedNumber(
      input.maxRetries ?? firstEnvValue(env, ["ADDRESSSCRIBE_MAX_RETRIES"]),
      RUNTIME_DEFAULTS.maxRetries,
      0,
      RUNTIME_LIMITS.maxRetries
    ),
    requestsPerSecond: boundedNumber(
      input.requestsPerSecond ?? firstEnvValue(env, ["ADDRESSSCRIBE_RPC_RATE"]),
      RUNTIME_DEFAULTS.requestsPerSecond,
      1,
      RUNTIME_LIMITS.maxRequestsPerSecond
    ),
    burst: boundedNumber(
      input.burst ?? firstEnvValue(env, ["ADDRESSSCRIBE_RPC_BURST"]),
      RUNTIME_DEFAULTS.burst,
      1,
      RUNTIME_LIMITS.maxBurst
    ),
    maxResponseBytes: boundedNumber(
      input.maxResponseBytes ?? firstEnvValue(env, ["ADDRESSSCRIBE_RPC_MAX_RESPONSE_BYTES"]),
      RUNTIME_DEFAULTS.maxResponseBytes,
      1,
      RUNTIME_LIMITS.maxResponseBytes
    ),
    maxBatchSize: boundedNumber(
      input.maxBatchSize ?? firstEnvValue(env, ["ADDRESSSCRIBE_RPC_MAX_BATCH_SIZE"]),
      RUNTIME_DEFAULTS.maxBatchSize,
      1,
      RUNTIME_LIMITS.maxBatchSize
    ),
    output: normalizeOutput(outputValue),
    outputPath: cleanString(outputPathValue),
    stateFile: cleanString(stateValue),
    rpcUrls,
    redactedRpcUrls: [...new Set(rpcUrls.map((url) => redactRpcUrl(url) ?? ""))],
    safeRpcUrls: [...new Set(rpcUrls.map((url) => redactRpcUrl(url) ?? ""))],
    readOnly: true,
    execution: false,
    browserPersistence: false,
    telemetry: false,
    cookies: false
  };
  Object.defineProperty(config, "toJSON", {
    value: () => ({ ...config, rpcUrls: config.redactedRpcUrls }),
    enumerable: false
  });
  return deepFreeze(config);
}

/**
 * @param {RuntimeConfig} config
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRuntimeConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return { ok: false, errors: ["Runtime config must be an object"] };
  if (!findChain(config.chain)) errors.push("Unknown chain selection");
  if (config.blocks !== null && (!Number.isSafeInteger(config.blocks) || config.blocks < 1 || config.blocks > RUNTIME_LIMITS.maxBlocks)) {
    errors.push("Block range is outside the bounded limit");
  }
  if (config.slots !== null && (!Number.isSafeInteger(config.slots) || config.slots < 1 || config.slots > RUNTIME_LIMITS.maxSlots)) {
    errors.push("Slot range is outside the bounded limit");
  }
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > RUNTIME_LIMITS.maxConcurrency) {
    errors.push("Concurrency is outside the bounded limit");
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < RUNTIME_LIMITS.minTimeoutMs || config.timeoutMs > RUNTIME_LIMITS.maxTimeoutMs) {
    errors.push("Timeout is outside the bounded limit");
  }
  if (!Array.isArray(config.rpcUrls) || config.rpcUrls.length === 0 || config.rpcUrls.some((url) => !normalizeHttpUrl(url))) {
    errors.push("At least one HTTP RPC URL is required");
  }
  if (!OUTPUT_FORMATS.has(config.output)) errors.push("Output format is not allowlisted");
  if (!Number.isSafeInteger(config.rpcTimeoutMs) || config.rpcTimeoutMs < RUNTIME_LIMITS.minTimeoutMs || config.rpcTimeoutMs > RUNTIME_LIMITS.maxRpcTimeoutMs || config.rpcTimeoutMs > config.timeoutMs) {
    errors.push("RPC timeout is outside the bounded limit");
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > RUNTIME_LIMITS.maxRetries) {
    errors.push("Retry count is outside the bounded limit");
  }
  if (!Number.isSafeInteger(config.requestsPerSecond) || config.requestsPerSecond < 1 || config.requestsPerSecond > RUNTIME_LIMITS.maxRequestsPerSecond) {
    errors.push("RPC rate is outside the bounded limit");
  }
  if (!Number.isSafeInteger(config.burst) || config.burst < 1 || config.burst > RUNTIME_LIMITS.maxBurst) {
    errors.push("RPC burst is outside the bounded limit");
  }
  if (config.maxResponseBytes !== undefined && (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > RUNTIME_LIMITS.maxResponseBytes)) {
    errors.push("RPC response limit is outside the bounded limit");
  }
  if (config.maxBatchSize !== undefined && (!Number.isSafeInteger(config.maxBatchSize) || config.maxBatchSize < 1 || config.maxBatchSize > RUNTIME_LIMITS.maxBatchSize)) {
    errors.push("RPC batch size is outside the bounded limit");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {Parameters<typeof getRuntimeConfig>[0]} [input]
 * @returns {RuntimeConfig}
 */
export function loadRuntimeConfig(input) {
  return getRuntimeConfig(input);
}

/**
 * @param {Parameters<typeof getRuntimeConfig>[0]} [input]
 * @returns {RuntimeConfig}
 */
export function createRuntimeConfig(input) {
  return getRuntimeConfig(input);
}

export const getConfig = getRuntimeConfig;
export const resolveConfig = getRuntimeConfig;

/**
 * @param {unknown} selector
 * @returns {ReturnType<typeof getChain>}
 */
export function resolveRuntimeChain(selector) {
  return resolveSelectedChain(selector);
}

/**
 * @param {unknown} value
 * @returns {Record<string, string[]>}
 */
export function parseRpcOverrides(value) {
  const map = parseRpcMap(value);
  const result = /** @type {Record<string, string[]>} */ ({});
  for (const [key, raw] of Object.entries(map)) {
    const chain = findChain(key);
    if (!chain) continue;
    result[chain.slug ?? chain.id] = normalizeRpcValues(raw, "ADDRESSSCRIBE_RPC_URLS");
  }
  return result;
}

export function resolveRpcUrls(chainOrSelector, env = process.env) {
  const chain = typeof chainOrSelector === "object" ? chainOrSelector : getChain(chainOrSelector);
  const map = parseRpcMap(env.ADDRESSSCRIBE_RPC_URLS);
  const mapped = rpcMapValue(map, String(chain.chainId), chain.id);
  const envName = rpcEnvName(chain.slug ?? chain.id);
  const direct = normalizeRpcValues(env[envName], envName);
  const urls = [...new Set([...direct, ...mapped, ...(chain.rpcUrls ?? [])])];
  if (urls.length > MAX_RPC_URLS) throw new RangeError("Too many RPC URLs configured");
  return urls;
}

export const getRpcOverrides = parseRpcOverrides;
export const validateConfig = validateRuntimeConfig;
