/**
 * @typedef {Object} TokenBucketOptions
 * @property {number} [capacity]
 * @property {number} [limit]
 * @property {number} [maxTokens]
 * @property {number} [refillRate]
 * @property {number} [rate]
 * @property {number} [refillRatePerMs]
 * @property {number} [refillTokens]
 * @property {number} [refillIntervalMs]
 * @property {() => number|Date} [now]
 * @property {number} [tokens]
 * @property {() => number|Date} [clock]
 * @property {(milliseconds: number) => Promise<void>} [sleep]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

/**
 * @param {() => number|Date} clock
 * @returns {number}
 */
function clockMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  return finiteNumber(milliseconds, "clock value");
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

async function waitForRetry(sleep, milliseconds, signal) {
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

export class TokenBucket {
  /**
   * @param {TokenBucketOptions|number} [options]
   */
  constructor(options = {}) {
    const settings = typeof options === "number" ? { capacity: options, refillRate: 1 } : options;
    if (!isRecord(settings)) throw new TypeError("TokenBucket options must be an object");
    const capacityValue = settings.capacity ?? settings.limit ?? settings.maxTokens;
    const refillRateValue = settings.refillRate ?? settings.rate;
    const refillRatePerMsValue = settings.refillRatePerMs;
    const refillTokensValue = settings.refillTokens;
    const refillIntervalValue = settings.refillIntervalMs;
    if (capacityValue === undefined) throw new TypeError("TokenBucket capacity is required");
    if (refillRateValue === undefined && refillRatePerMsValue === undefined && (refillTokensValue === undefined || refillIntervalValue === undefined)) {
      throw new TypeError("TokenBucket refill rate is required");
    }
    const capacity = finiteNumber(capacityValue, "TokenBucket capacity");
    const refillRate = refillRatePerMsValue !== undefined
      ? finiteNumber(refillRatePerMsValue, "TokenBucket refill rate per millisecond") * 1000
      : refillRateValue !== undefined
        ? finiteNumber(refillRateValue, "TokenBucket refill rate")
        : finiteNumber(refillTokensValue, "TokenBucket refill tokens") * 1000 / finiteNumber(refillIntervalValue, "TokenBucket refill interval");
    if (!Number.isFinite(capacity) || !Number.isFinite(refillRate)) throw new TypeError("TokenBucket refill settings must be finite");
    if (capacity <= 0) throw new RangeError("TokenBucket capacity must be greater than zero");
    if (refillRate <= 0) throw new RangeError("TokenBucket refill rate must be greater than zero");
    const initialTokens = settings.tokens === undefined ? capacity : finiteNumber(settings.tokens, "TokenBucket tokens");
    if (initialTokens < 0 || initialTokens > capacity) throw new RangeError("TokenBucket tokens must be between zero and capacity");
    const clock = settings.clock ?? settings.now ?? Date.now;
    if (typeof clock !== "function") throw new TypeError("TokenBucket clock must be a function");
    if (settings.sleep !== undefined && typeof settings.sleep !== "function") throw new TypeError("TokenBucket sleep must be a function");
    this._capacity = capacity;
    this._refillRate = refillRate;
    this._tokens = initialTokens;
    this._clock = clock;
    this._sleep = settings.sleep ?? defaultSleep;
    this._updatedAt = clockMilliseconds(this._clock);
  }

  get capacity() {
    return this._capacity;
  }

  get refillRate() {
    return this._refillRate;
  }

  get tokens() {
    this._refill();
    return this._tokens;
  }

  get availableTokens() {
    return this.tokens;
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  tryConsume(amount = 1) {
    const requested = finiteNumber(amount, "Token amount");
    if (requested <= 0) throw new RangeError("Token amount must be greater than zero");
    if (requested > this._capacity) throw new RangeError("Token amount exceeds bucket capacity");
    this._refill();
    if (this._tokens + Number.EPSILON >= requested) {
      this._tokens = Math.max(0, this._tokens - requested);
      return true;
    }
    return false;
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  tryTake(amount = 1) {
    return this.tryConsume(amount);
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  tryAcquire(amount = 1) {
    return this.tryConsume(amount);
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  consume(amount = 1) {
    return this.tryConsume(amount);
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  take(amount = 1) {
    return this.tryConsume(amount);
  }

  /**
   * @param {number} [amount]
   * @returns {boolean}
   */
  remove(amount = 1) {
    return this.tryConsume(amount);
  }

  /**
   * @param {number} [amount]
   * @returns {number}
   */
  retryAfterMs(amount = 1) {
    const requested = finiteNumber(amount, "Token amount");
    if (requested <= 0 || requested > this._capacity) throw new RangeError("Token amount is outside the bucket limit");
    this._refill();
    if (this._tokens >= requested) return 0;
    return Math.max(1, Math.ceil(((requested - this._tokens) / this._refillRate) * 1000));
  }

  /**
   * @param {number} amount
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<boolean>}
   */
  async acquire(amount = 1, options = {}) {
    const requested = finiteNumber(amount, "Token amount");
    if (requested <= 0 || requested > this._capacity) throw new RangeError("Token amount is outside the bucket limit");
    while (true) {
      if (options.signal?.aborted) throw abortError();
      if (this.tryConsume(requested)) return true;
      await waitForRetry(this._sleep, this.retryAfterMs(requested), options.signal);
    }
  }

  /**
   * @param {number} amount
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<boolean>}
   */
  async wait(amount = 1, options = {}) {
    return this.acquire(amount, options);
  }

  /**
   * @returns {{tokens: number, capacity: number, refillRate: number}}
   */
  snapshot() {
    return {
      tokens: this.tokens,
      capacity: this._capacity,
      refillRate: this._refillRate
    };
  }

  /**
   * @param {number} [tokens]
   * @returns {void}
   */
  reset(tokens = this._capacity) {
    const next = finiteNumber(tokens, "TokenBucket tokens");
    if (next < 0 || next > this._capacity) throw new RangeError("TokenBucket tokens must be between zero and capacity");
    this._tokens = next;
    this._updatedAt = clockMilliseconds(this._clock);
  }

  _refill() {
    const now = clockMilliseconds(this._clock);
    if (now < this._updatedAt) {
      this._updatedAt = now;
      return;
    }
    const elapsedSeconds = (now - this._updatedAt) / 1000;
    this._tokens = Math.min(this._capacity, this._tokens + elapsedSeconds * this._refillRate);
    this._updatedAt = now;
  }
}

function abortError() {
  const error = new Error("Token bucket wait aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @param {TokenBucketOptions} options
 * @returns {TokenBucket}
 */
export function createTokenBucket(options) {
  return new TokenBucket(options);
}

export const TokenBucketLimiter = TokenBucket;
export const createLimiter = createTokenBucket;
