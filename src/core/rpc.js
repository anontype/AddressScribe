import { TokenBucket } from "./limiter.js";
import { redactData, redactRpcUrl, sanitizeErrorText } from "./privacy.js";

/**
 * @typedef {Object} FetchHeaders
 * @property {(name: string) => string|null} [get]
 * @property {Record<string, string>} [entries]
 * @typedef {Object} FetchResponseLike
 * @property {boolean} [ok]
 * @property {number} [status]
 * @property {FetchHeaders|string|Record<string, string>} [headers]
 * @property {() => Promise<string>} [text]
 * @property {() => Promise<unknown>} [json]
 * @property {{getReader: () => {read: () => Promise<{done: boolean, value?: Uint8Array|string}>, cancel?: () => Promise<void>, releaseLock?: () => void}}} [body]
 * @typedef {(url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>} FetchLike
 * @typedef {() => number|Date} ClockLike
 * @typedef {(milliseconds: number) => Promise<void>} SleepLike
 * @typedef {Object} JsonRpcRequest
 * @property {string} method
 * @property {unknown[]} [params]
 * @property {string|number} [id]
 * @typedef {Object} BatchResult
 * @property {string|number} id
 * @property {boolean} ok
 * @property {string} method
 * @property {unknown} [result]
 * @property {{code: unknown, message: string, data?: unknown}} [error]
 * @typedef {Object} JsonRpcClientOptions
 * @property {string|string[]|EndpointInput[]} [endpoints]
 * @property {string[]} [urls]
 * @property {string[]} [rpcUrls]
 * @property {FetchLike} [fetch]
 * @property {FetchLike} [fetchImpl]
 * @property {ClockLike} [clock]
 * @property {SleepLike} [sleep]
 * @property {number} [maxRetries]
 * @property {number} [retries]
 * @property {number} [retry]
 * @property {number} [timeoutMs]
 * @property {number} [timeout]
 * @property {number} [requestTimeoutMs]
 * @property {number} [maxResponseBytes]
 * @property {number} [responseSizeLimit]
 * @property {number} [responseLimit]
 * @property {number} [maxBatchSize]
 * @property {number} [requestsPerSecond]
 * @property {number} [rate]
 * @property {number} [burst]
 * @property {number} [capacity]
 * @property {() => number} [random]
 * @property {number|false} [jitter]
 * @typedef {Object} RequestOptions
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @typedef {Object} EndpointInput
 * @property {string} url
 * @property {LimiterLike} [limiter]
 * @typedef {Object} LimiterLike
 * @property {(amount?: number, options?: {signal?: AbortSignal}) => Promise<boolean>} acquire
 * @typedef {Object} EndpointHealth
 * @property {string} url
 * @property {boolean|null} healthy
 * @property {string} status
 * @property {number} requests
 * @property {number} failures
 * @property {number} rateLimits
 * @property {number|null} lastSuccessAt
 * @property {number|null} lastFailureAt
 * @property {number|null} retryAfterMs
 * @property {string|null} lastError
 */

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_REQUESTS_PER_SECOND = 10;
const DEFAULT_BURST = 10;
const DEFAULT_BASE_RETRY_MS = 100;
const DEFAULT_MAX_RETRY_MS = 5000;
const MAX_ENDPOINTS = 16;
/** @type {WeakMap<EndpointHealth, string>} */
const RAW_ENDPOINT_URLS = new WeakMap();

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function numberOption(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("RPC numeric options must be finite integers");
  if (parsed < minimum || parsed > maximum) throw new RangeError(`RPC option must be between ${minimum} and ${maximum}`);
  return parsed;
}

/**
 * @param {ClockLike} clock
 * @returns {number}
 */
function clockValue(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) throw new TypeError("RPC clock must return finite milliseconds");
  return milliseconds;
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers === "object") {
    const getter = /** @type {FetchHeaders} */ (headers).get;
    if (typeof getter === "function") {
      const value = getter.call(headers, name);
      return value === null || value === undefined ? null : String(value);
    }
  }
  if (typeof headers === "object") {
    const record = /** @type {Record<string, unknown>} */ (headers);
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(record[key]) : null;
  }
  return null;
}

/**
 * @param {FetchResponseLike} response
 * @returns {number}
 */
function responseStatus(response) {
  const status = Number(response.status);
  return Number.isInteger(status) ? status : 200;
}

/**
 * @param {FetchResponseLike} response
 * @returns {boolean}
 */
function responseOk(response) {
  return typeof response.ok === "boolean" ? response.ok : responseStatus(response) >= 200 && responseStatus(response) < 300;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeMessage(value) {
  return sanitizeErrorText(value) || "RPC request failed";
}

function isRateLimitError(code, message) {
  if (code === -32005 || code === -32007 || code === "rate_limited" || code === "rate_limit_exceeded") return true;
  return /rate.?limit|too many requests|throttl|exceeded|429/i.test(String(message ?? ""));
}

function isTransientRpcError(code, message) {
  if (code === -32603 || code === "server_error") return true;
  return /internal error|temporar(?:y|ily)|timeout|upstream|connection/i.test(String(message ?? ""));
}

export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {string} [name]
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, name = "RpcError", fields = {}) {
    super(safeMessage(message));
    this.name = name;
    this.code = typeof fields.code === "string" ? sanitizeErrorText(fields.code) : fields.code ?? name;
    this.status = fields.status;
    this.retryable = fields.retryable === true;
    this.retryAfterMs = typeof fields.retryAfterMs === "number" ? fields.retryAfterMs : null;
    this.endpoint = typeof fields.endpoint === "string" ? redactRpcUrl(fields.endpoint) : null;
    this.details = fields.details === undefined ? null : redactData(fields.details);
    this.rpcError = fields.rpcError;
  }
}

export class RpcTransportError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcTransportError", { ...fields, code: fields.code ?? "transport", retryable: true });
  }
}

export class RpcTimeoutError extends RpcTransportError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, { ...fields, code: "timeout" });
    this.name = "RpcTimeoutError";
  }
}

export class RpcHttpError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcHttpError", fields);
  }
}

export class RpcRateLimitError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcRateLimitError", { ...fields, code: "rate_limited", status: 429, retryable: false });
  }
}

export class RpcResponseTooLargeError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcResponseTooLargeError", { ...fields, code: "response_too_large", retryable: false });
  }
}

export class RpcProtocolError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcProtocolError", { ...fields, code: "protocol", retryable: false });
  }
}

export class RpcUnavailableError extends RpcError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  constructor(message, fields = {}) {
    super(message, "RpcUnavailableError", { ...fields, code: "unavailable", retryable: false });
  }
}

export class RpcAbortError extends RpcError {
  /**
   * @param {string} [message]
   */
  constructor(message = "RPC request aborted") {
    super(message, "RpcAbortError", { code: "aborted", retryable: false });
    this.name = "AbortError";
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function endpointUrl(value) {
  const candidate = typeof value === "string" ? value : isRecord(value) && typeof value.url === "string" ? value.url : null;
  if (!candidate) throw new TypeError("RPC endpoints must be HTTP or HTTPS URLs");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("RPC endpoints must be valid URLs");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("RPC endpoints must use HTTP or HTTPS");
  return parsed.toString();
}

/**
 * @param {unknown} value
 * @param {ClockLike} clock
 * @returns {number}
 */
function retryAfterMs(value, clock) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(DEFAULT_MAX_RETRY_MS * 10, Math.ceil(numeric * 1000));
  const timestamp = Date.parse(String(value));
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - clockValue(clock));
  return 0;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new RpcProtocolError("RPC endpoint returned invalid JSON");
  }
}

/**
 * @param {FetchResponseLike} response
 * @param {number} maximum
 * @returns {Promise<unknown>}
 */
async function readResponseBody(response, maximum) {
  const declared = headerValue(response.headers, "content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maximum) {
      throw new RpcResponseTooLargeError(`RPC response exceeds ${maximum} bytes`);
    }
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value === undefined) continue;
        const chunk = typeof part.value === "string" ? new TextEncoder().encode(part.value) : part.value;
        size += chunk.byteLength;
        if (size > maximum) {
          if (typeof reader.cancel === "function") await reader.cancel();
          throw new RpcResponseTooLargeError(`RPC response exceeds ${maximum} bytes`);
        }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
    return parseJsonValue(text);
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) {
      throw new RpcResponseTooLargeError(`RPC response exceeds ${maximum} bytes`);
    }
    return parseJsonValue(text);
  }
  if (typeof response.json === "function") {
    const value = await response.json();
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw new RpcProtocolError("RPC endpoint returned an unreadable JSON value");
    }
    if (typeof encoded !== "string") throw new RpcProtocolError("RPC endpoint returned an unreadable JSON value");
    if (new TextEncoder().encode(encoded).byteLength > maximum) {
      throw new RpcResponseTooLargeError(`RPC response exceeds ${maximum} bytes`);
    }
    return value;
  }
  throw new RpcProtocolError("RPC response has no readable body");
}

/**
 * @param {unknown} value
 * @returns {JsonRpcRequest}
 */
function normalizeRequest(value) {
  if (!isRecord(value) || typeof value.method !== "string" || !value.method.trim()) {
    throw new TypeError("JSON-RPC requests require a method");
  }
  if (value.params !== undefined && !Array.isArray(value.params)) throw new TypeError("JSON-RPC params must be an array");
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
    throw new TypeError("JSON-RPC request ID must be a string or number");
  }
  return {
    method: value.method.trim(),
    params: value.params ?? [],
    ...(value.id === undefined ? {} : { id: /** @type {string|number} */ (value.id) })
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function idKey(value) {
  return `${typeof value}:${String(value)}`;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function safeRpcDetails(value) {
  return redactData(value);
}

async function sleepWithSignal(sleep, milliseconds, signal) {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) throw abortError();
  let remove;
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    remove?.();
  }
}

export class JsonRpcClient {
  /**
   * @param {string[]|string|EndpointInput[]|JsonRpcClientOptions} endpointsOrOptions
   * @param {JsonRpcClientOptions} [maybeOptions]
   */
  constructor(endpointsOrOptions, maybeOptions = {}) {
    const optionRecord = /** @type {Record<string, unknown>} */ (isRecord(endpointsOrOptions) ? endpointsOrOptions : {});
    const endpointLike = typeof endpointsOrOptions === "string" || Array.isArray(endpointsOrOptions) ||
      (isRecord(endpointsOrOptions) && typeof optionRecord.url === "string");
    const options = /** @type {JsonRpcClientOptions} */ (endpointLike
      ? { ...maybeOptions, endpoints: /** @type {string|string[]|EndpointInput[]} */ (endpointsOrOptions) }
      : (endpointsOrOptions ?? {}));
    const endpointValues = options.endpoints ?? options.urls ?? options.rpcUrls ?? [];
    const values = typeof endpointValues === "string" ? [endpointValues] : endpointValues;
    if (!Array.isArray(values) || values.length === 0) throw new TypeError("JsonRpcClient requires at least one endpoint");
    if (values.length > MAX_ENDPOINTS) throw new RangeError(`JsonRpcClient supports at most ${MAX_ENDPOINTS} endpoints`);
    const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("JsonRpcClient requires a fetch implementation");
    this._fetch = /** @type {FetchLike} */ (fetchImpl);
    this._clock = options.clock ?? Date.now;
    this._sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (typeof this._clock !== "function") throw new TypeError("JsonRpcClient clock must be a function");
    if (typeof this._sleep !== "function") throw new TypeError("JsonRpcClient sleep must be a function");
    this._maxRetries = numberOption(options.maxRetries ?? options.retries ?? options.retry, DEFAULT_MAX_RETRIES, 0, 10);
    this._timeoutMs = numberOption(options.timeoutMs ?? options.timeout ?? options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 1, 120000);
    this._maxResponseBytes = numberOption(options.maxResponseBytes ?? options.responseSizeLimit ?? options.responseLimit, DEFAULT_MAX_RESPONSE_BYTES, 1, 50 * 1024 * 1024);
    this._maxBatchSize = numberOption(options.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1, 1000);
    this._requestsPerSecond = numberOption(options.requestsPerSecond ?? options.rate, DEFAULT_REQUESTS_PER_SECOND, 1, 100000);
    this._burst = numberOption(options.burst ?? options.capacity, DEFAULT_BURST, 1, 100000);
    this._random = options.random ?? Math.random;
    this._jitter = options.jitter === undefined ? true : options.jitter;
    if (typeof this._random !== "function") throw new TypeError("JsonRpcClient random must be a function");
    if (typeof this._jitter !== "boolean" && typeof this._jitter !== "number") throw new TypeError("JsonRpcClient jitter must be a boolean or number");
    this._nextId = 1;
    /** @type {Array<{state: EndpointHealth, limiter: LimiterLike}>} */
    this._states = [];
    const seen = new Set();
    for (const value of values) {
      const url = endpointUrl(value);
      if (seen.has(url)) continue;
      seen.add(url);
      const safeUrl = redactRpcUrl(url);
      const state = /** @type {EndpointHealth} */ ({
        url: safeUrl,
        healthy: null,
        status: "unknown",
        requests: 0,
        failures: 0,
        rateLimits: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        retryAfterMs: null,
        lastError: null
      });
      const inputLimiter = isRecord(value) && value.limiter
        ? /** @type {LimiterLike} */ (value.limiter)
        : null;
      const limiter = inputLimiter && typeof inputLimiter.acquire === "function"
        ? inputLimiter
        : new TokenBucket({ capacity: this._burst, refillRate: this._requestsPerSecond, clock: this._clock, sleep: this._sleep });
      RAW_ENDPOINT_URLS.set(state, url);
      this._states.push({ state, limiter });
    }
    if (!this._states.length) throw new TypeError("JsonRpcClient requires at least one unique endpoint");
  }

  /**
   * @returns {string[]}
   */
  get endpoints() {
    return this._states.map(({ state }) => state.url);
  }

  get endpointHealth() {
    return this.healthSnapshot();
  }

  /**
   * @param {string|JsonRpcRequest} [methodOrRequest]
   * @param {unknown[]} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async request(methodOrRequest, params, options = {}) {
    const response = await this.requestEnvelope(methodOrRequest, params, options);
    return response.result;
  }

  /**
   * @param {string|JsonRpcRequest} [methodOrRequest]
   * @param {unknown[]} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async requestEnvelope(methodOrRequest, params, options = {}) {
    const request = typeof methodOrRequest === "object" && methodOrRequest !== null
      ? normalizeRequest(methodOrRequest)
      : normalizeRequest({ method: methodOrRequest, params });
    const id = request.id ?? this._allocateId();
    const payload = { jsonrpc: "2.0", id, method: request.method, params: request.params };
    return /** @type {Record<string, unknown>} */ (await this._execute(payload, options, false));
  }

  /**
   * @param {string|JsonRpcRequest} [methodOrRequest]
   * @param {unknown[]} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async send(methodOrRequest, params, options = {}) {
    return this.requestEnvelope(methodOrRequest, params, options);
  }

  /**
   * @param {string} method
   * @param {unknown[]} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async call(method, params = [], options = {}) {
    return this.request(method, params, options);
  }

  /**
   * @param {string} method
   * @param {unknown[]} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async rpc(method, params = [], options = {}) {
    return this.request(method, params, options);
  }

  /**
   * @param {JsonRpcRequest[]} requests
   * @param {RequestOptions} [options]
   * @returns {Promise<BatchResult[]>}
   */
  async requestBatch(requests, options = {}) {
    if (!Array.isArray(requests) || requests.length === 0) throw new TypeError("JSON-RPC batch must contain at least one request");
    if (requests.length > this._maxBatchSize) throw new RangeError(`JSON-RPC batch exceeds ${this._maxBatchSize} requests`);
    const normalized = requests.map(normalizeRequest);
    const assigned = normalized.map((request) => ({ ...request, id: request.id ?? this._allocateId() }));
    const ids = new Set(assigned.map((request) => idKey(request.id)));
    if (ids.size !== assigned.length) throw new TypeError("JSON-RPC batch IDs must be unique");
    const payload = assigned.map(({ method, params, id }) => ({ jsonrpc: "2.0", id, method, params }));
    const response = await this._execute(payload, options, true);
    if (!Array.isArray(response)) throw new RpcProtocolError("JSON-RPC batch response must be an array");
    const byId = new Map();
    for (const item of response) {
      if (!isRecord(item) || item.id === undefined || item.id === null) continue;
      const key = idKey(item.id);
      if (!byId.has(key)) byId.set(key, item);
    }
    return assigned.map((request) => {
      const item = byId.get(idKey(request.id));
      if (!item) {
        return {
          id: request.id,
          ok: false,
          method: request.method,
          error: { code: "missing_response", message: "Batch response did not contain this request ID" }
        };
      }
      if (item.error !== undefined && item.error !== null) {
        const error = isRecord(item.error) ? item.error : {};
        const code = isRateLimitError(error.code, error.message) ? "rate_limited" : safeRpcDetails(error.code ?? "rpc_error");
        return {
          id: request.id,
          ok: false,
          method: request.method,
          error: {
            code,
            message: "RPC endpoint returned an error",
            ...(error.data === undefined ? {} : { data: safeRpcDetails(error.data) })
          }
        };
      }
      if (!Object.prototype.hasOwnProperty.call(item, "result")) {
        return {
          id: request.id,
          ok: false,
          method: request.method,
          error: { code: "missing_result", message: "Batch response did not contain a result" }
        };
      }
      return { id: request.id, ok: true, method: request.method, result: item.result };
    });
  }

  /**
   * @param {JsonRpcRequest[]} requests
   * @param {RequestOptions} [options]
   * @returns {Promise<BatchResult[]>}
   */
  async batch(requests, options = {}) {
    return this.requestBatch(requests, options);
  }

  /**
   * @param {JsonRpcRequest[]} requests
   * @param {RequestOptions} [options]
   * @returns {Promise<BatchResult[]>}
   */
  async batchWithErrors(requests, options = {}) {
    return this.requestBatch(requests, options);
  }

  /**
   * @param {JsonRpcRequest[]} requests
   * @param {RequestOptions} [options]
   * @returns {Promise<BatchResult[]>}
   */
  async batchRequest(requests, options = {}) {
    return this.requestBatch(requests, options);
  }

  /**
   * @param {number|string} [selector]
   * @returns {EndpointHealth|EndpointHealth[]|null}
   */
  health(selector) {
    if (selector === undefined) return this.healthSnapshot();
    if (typeof selector === "number") {
      const state = this._healthAt(selector);
      return state ? this._snapshot(state) : null;
    }
    const text = String(selector);
    const safeText = /** @type {string} */ (redactRpcUrl(text) ?? text);
    const entry = this._states.find(({ state }) => state.url === text || state.url === safeText);
    return entry ? this._snapshot(entry.state) : null;
  }

  /**
   * @returns {EndpointHealth[]}
   */
  healthSnapshot() {
    return this._states.map(({ state }) => this._snapshot(state));
  }

  /**
   * @returns {EndpointHealth[]}
   */
  getHealth() {
    return this.healthSnapshot();
  }

  /**
   * @param {number|string} selector
   * @returns {EndpointHealth|null}
   */
  getEndpointHealth(selector) {
    const value = this.health(selector);
    return Array.isArray(value) ? value[0] ?? null : value;
  }

  /**
   * @returns {void}
   */
  resetHealth() {
    for (const { state } of this._states) {
      state.healthy = null;
      state.status = "unknown";
      state.requests = 0;
      state.failures = 0;
      state.rateLimits = 0;
      state.lastSuccessAt = null;
      state.lastFailureAt = null;
      state.retryAfterMs = null;
      state.lastError = null;
    }
  }

  /**
   * @returns {number}
   */
  _allocateId() {
    const id = this._nextId;
    this._nextId += 1;
    if (this._nextId > Number.MAX_SAFE_INTEGER) this._nextId = 1;
    return id;
  }

  /**
   * @param {{state: EndpointHealth, limiter: TokenBucket|{acquire: (amount?: number) => Promise<boolean>}}} entry
   * @returns {string}
   */
  _rawUrl(entry) {
    return RAW_ENDPOINT_URLS.get(entry.state) ?? entry.state.url;
  }

  /**
   * @param {Record<string, unknown>|Record<string, unknown>[]} payload
   * @param {RequestOptions} options
   * @param {boolean} batch
   * @returns {Promise<unknown>}
   */
  async _execute(payload, options, batch) {
    const maximumRetries = options.maxRetries === undefined
      ? this._maxRetries
      : numberOption(options.maxRetries, this._maxRetries, 0, 10);
    const failures = [];
    /** @type {RpcError|null} */
    let lastError = null;
    for (const entry of this._states) {
      const rawUrl = this._rawUrl(entry);
      for (let retry = 0; retry <= maximumRetries; retry += 1) {
        if (options.signal?.aborted) throw abortError();
        try {
          await entry.limiter.acquire(1, options.signal ? { signal: options.signal } : {});
          const response = await this._send(rawUrl, payload, options, batch);
          this._markSuccess(entry.state);
          return response;
        } catch (rawError) {
          const error = this._normalizeError(rawError, rawUrl);
          lastError = error;
          if (error.code === "rate_limited") {
            this._markRateLimit(entry.state, error);
            throw error;
          }
          if (!error.retryable) throw error;
          this._markFailure(entry.state, error);
          failures.push({ endpoint: entry.state.url, code: error.code, message: error.message });
          if (retry >= maximumRetries) break;
          await sleepWithSignal(this._sleep, this._backoff(retry, error.retryAfterMs), options.signal);
        }
      }
    }
    if (lastError && this._states.length === 1) throw lastError;
    throw new RpcUnavailableError("All RPC endpoints failed", { details: failures });
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>|Record<string, unknown>[]} payload
   * @param {RequestOptions} options
   * @param {boolean} batch
   * @returns {Promise<unknown>}
   */
  async _send(url, payload, options, batch) {
    let response;
    try {
      response = await this._fetchWithTimeout(url, payload, options);
    } catch (error) {
      if (error instanceof RpcError && error.endpoint === null) error.endpoint = redactRpcUrl(url);
      throw error;
    }
    const status = responseStatus(response);
    const endpoint = redactRpcUrl(url);
    if (status === 429) {
      const wait = retryAfterMs(headerValue(response.headers, "retry-after"), this._clock);
      throw new RpcRateLimitError("RPC endpoint rate limited the request", {
        endpoint,
        retryAfterMs: wait,
        details: { status }
      });
    }
    if (status >= 500) {
      const wait = retryAfterMs(headerValue(response.headers, "retry-after"), this._clock);
      throw new RpcHttpError(`RPC endpoint returned HTTP ${status}`, {
        endpoint,
        status,
        retryable: true,
        retryAfterMs: wait,
        details: { status }
      });
    }
    if (!responseOk(response)) {
      throw new RpcHttpError(`RPC endpoint returned HTTP ${status}`, {
        endpoint,
        status,
        retryable: false,
        details: { status }
      });
    }
    const value = await readResponseBody(response, this._maxResponseBytes);
    if (batch) {
      if (!Array.isArray(value)) throw new RpcProtocolError("JSON-RPC batch response must be an array", { endpoint });
      return value;
    }
    if (!isRecord(value)) throw new RpcProtocolError("JSON-RPC response must be an object", { endpoint });
    if (value.error !== undefined && value.error !== null) {
      const error = isRecord(value.error) ? value.error : {};
      const message = safeMessage(error.message ?? "RPC endpoint returned an error");
      if (isRateLimitError(error.code, message)) {
        throw new RpcRateLimitError("RPC endpoint rate limited the request", {
          endpoint,
          retryAfterMs: retryAfterMs(error.retryAfter, this._clock),
          details: { code: error.code ?? "rate_limited" }
        });
      }
      throw new RpcError(message, "RpcError", {
        endpoint,
        code: error.code ?? "rpc_error",
        retryable: isTransientRpcError(error.code, message),
        details: error.data,
        rpcError: true
      });
    }
    if (!Object.prototype.hasOwnProperty.call(value, "result")) {
      throw new RpcProtocolError("JSON-RPC response did not contain a result", { endpoint });
    }
    return value;
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>|Record<string, unknown>[]} payload
   * @param {RequestOptions} options
   * @returns {Promise<FetchResponseLike>}
   */
  async _fetchWithTimeout(url, payload, options) {
    const timeoutMs = options.timeoutMs === undefined ? this._timeoutMs : numberOption(options.timeoutMs, this._timeoutMs, 1, 120000);
    const controller = new AbortController();
    let timer;
    /** @type {() => void} */
    let removeAbortListener = () => undefined;
    if (options.signal) {
      if (options.signal.aborted) throw abortError();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    }
    const request = Promise.resolve().then(() => this._fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      credentials: "omit"
    }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RpcTimeoutError(`RPC request timed out after ${timeoutMs}ms`, {
          retryAfterMs: null,
          details: { timeout: true }
        }));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([request, timeout]);
      if (!response || typeof response !== "object") throw new RpcProtocolError("RPC fetch returned an invalid response");
      return response;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (options.signal?.aborted || (isRecord(error) && error.name === "AbortError")) throw abortError();
      throw new RpcTransportError("RPC transport failed", { details: { transport: true } });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
    }
  }

  /**
   * @param {number} retry
   * @param {number|null|undefined} retryAfter
   * @returns {number}
   */
  _backoff(retry, retryAfter) {
    if (typeof retryAfter === "number" && retryAfter > 0) return Math.min(DEFAULT_MAX_RETRY_MS * 10, retryAfter);
    const exponential = Math.min(DEFAULT_MAX_RETRY_MS, DEFAULT_BASE_RETRY_MS * (2 ** retry));
    if (this._jitter === false) return exponential;
    const ratio = typeof this._jitter === "number" ? this._jitter : this._random();
    return Math.max(1, Math.ceil(exponential * (1 + Math.max(0, Math.min(1, ratio)))));
  }

  /**
   * @param {unknown} error
   * @param {string} url
   * @returns {RpcError}
   */
  _normalizeError(error, url) {
    if (error instanceof RpcError) return error;
    if (isRecord(error) && error.name === "AbortError") return abortError();
    return new RpcTransportError("RPC transport failed", { endpoint: url, details: { transport: true } });
  }

  /**
   * @param {EndpointHealth} state
   * @returns {void}
   */
  _markSuccess(state) {
    state.healthy = true;
    state.status = "healthy";
    state.requests += 1;
    state.lastSuccessAt = clockValue(this._clock);
    state.retryAfterMs = null;
    state.lastError = null;
  }

  /**
   * @param {EndpointHealth} state
   * @param {RpcError} error
   * @returns {void}
   */
  _markFailure(state, error) {
    state.healthy = false;
    state.status = "unhealthy";
    state.requests += 1;
    state.failures += 1;
    state.lastFailureAt = clockValue(this._clock);
    state.retryAfterMs = error.retryAfterMs ?? null;
    state.lastError = error.message;
  }

  /**
   * @param {EndpointHealth} state
   * @param {RpcError} error
   * @returns {void}
   */
  _markRateLimit(state, error) {
    state.healthy = false;
    state.status = "rate-limited";
    state.requests += 1;
    state.rateLimits += 1;
    state.lastFailureAt = clockValue(this._clock);
    state.retryAfterMs = error.retryAfterMs ?? null;
    state.lastError = error.message;
  }

  /**
   * @param {EndpointHealth} state
   * @returns {EndpointHealth}
   */
  _snapshot(state) {
    return {
      url: state.url,
      healthy: state.healthy,
      status: state.status,
      requests: state.requests,
      failures: state.failures,
      rateLimits: state.rateLimits,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      retryAfterMs: state.retryAfterMs,
      lastError: state.lastError
    };
  }

  /**
   * @param {number} index
   * @returns {EndpointHealth|null}
   */
  _healthAt(index) {
    return this._states[index]?.state ?? null;
  }
}

function abortError() {
  return new RpcAbortError();
}

/**
 * @param {string[]|string} endpoints
 * @param {JsonRpcClientOptions} [options]
 * @returns {JsonRpcClient}
 */
export function createJsonRpcClient(endpoints, options) {
  return new JsonRpcClient(endpoints, options);
}

/**
 * @param {string[]|string} endpoints
 * @param {JsonRpcClientOptions} [options]
 * @returns {JsonRpcClient}
 */
export function createRpcClient(endpoints, options) {
  return new JsonRpcClient(endpoints, options);
}

export const RpcClient = JsonRpcClient;
export const JSONRPCClient = JsonRpcClient;
export const RateLimitError = RpcRateLimitError;
