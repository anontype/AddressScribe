import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const CHECKPOINT_FIELDS = Object.freeze(["cursor", "hash", "coverage"]);
const FORBIDDEN_KEY = /(?:^|[-_])(?:addresses?|rpc(?:[-_]?urls?)?|url|uri|endpoint|private(?:[-_]?key)?|secret|token|credentials?|password|wallet|api[-_]?key|key)(?:$|[-_])/i;
const URL_TEXT = /(?:https?|wss?|ftp):\/\//i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @typedef {Object} Checkpoint
 * @property {unknown} cursor
 * @property {unknown} hash
 * @property {unknown} coverage
 */

/**
 * @typedef {Object} CheckpointStoreOptions
 * @property {string} [path]
 * @property {number} [mode]
 */

export class CheckpointCorruptedError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = "Checkpoint file is corrupted") {
    super(message);
    this.name = "CheckpointCorruptedError";
  }
}

export class CheckpointValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "CheckpointValidationError";
  }
}

export const CorruptedCheckpointError = CheckpointCorruptedError;

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
function errorCode(value) {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

/**
 * @param {string} value
 * @param {string} location
 * @returns {boolean}
 */
function containsForbiddenText(value, location) {
  if (URL_TEXT.test(value) || EVM_ADDRESS.test(value)) {
    return true;
  }
  const field = location.split(".").at(-1) ?? location;
  const hashField = field === "hash" || field === "blockHash" || field === "blockhash" || field.endsWith("Hash");
  return !hashField && BASE58_ADDRESS.test(value);
}

/**
 * @param {unknown} value
 * @param {string} location
 * @returns {unknown}
 */
function sanitizeValue(value, location) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && containsForbiddenText(value.trim(), location)) {
      throw new CheckpointValidationError(`Unsafe checkpoint value at ${location}`);
    }
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${location}[${index}]`));
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2");
      if (FORBIDDEN_KEY.test(normalizedKey)) {
        throw new CheckpointValidationError(`Unsafe checkpoint key at ${location}.${key}`);
      }
      result[key] = sanitizeValue(value[key], `${location}.${key}`);
    }
    return result;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {Checkpoint}
 */
export function normalizeCheckpoint(value) {
  if (!isRecord(value)) {
    throw new CheckpointValidationError("Checkpoint must be an object");
  }
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of CHECKPOINT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      result[field] = sanitizeValue(value[field], field);
    } else {
      result[field] = null;
    }
  }
  return /** @type {Checkpoint} */ (result);
}

export class CheckpointStore {
  /**
   * @param {string|CheckpointStoreOptions} pathOrOptions
   * @param {{mode?: number}} [options]
   */
  constructor(pathOrOptions, options = {}) {
    const path = typeof pathOrOptions === "string" ? pathOrOptions : pathOrOptions.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("CheckpointStore requires a file path");
    }
    /** @type {string} */
    this.path = path;
    const requestedMode = options.mode ?? (typeof pathOrOptions === "string" ? undefined : pathOrOptions.mode);
    if (requestedMode !== undefined && requestedMode !== 0o600) throw new TypeError("Checkpoint mode must be 0600");
    /** @type {number} */
    this.mode = 0o600;
  }

  /**
   * @returns {Promise<Checkpoint|null>}
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CheckpointCorruptedError();
    }
    if (!isRecord(parsed)) {
      throw new CheckpointCorruptedError();
    }
    try {
      return normalizeCheckpoint(parsed);
    } catch (error) {
      if (error instanceof CheckpointValidationError) {
        throw new CheckpointCorruptedError(error.message);
      }
      throw error;
    }
  }

  /**
   * @param {unknown} checkpoint
   * @returns {Promise<Checkpoint>}
   */
  async save(checkpoint) {
    const normalized = normalizeCheckpoint(checkpoint);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    /** @type {Awaited<ReturnType<typeof open>> | null} */
    let handle = null;
    try {
      handle = await open(temporaryPath, "wx", this.mode);
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporaryPath, this.mode);
      await rename(temporaryPath, this.path);
      await chmod(this.path, this.mode);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return normalized;
  }

  /**
   * @param {unknown} checkpoint
   * @returns {Promise<Checkpoint>}
   */
  async write(checkpoint) {
    return this.save(checkpoint);
  }

  /**
   * @returns {Promise<void>}
   */
  async clear() {
    await unlink(this.path).catch((error) => {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    });
  }
}

/**
 * @param {string|CheckpointStoreOptions} pathOrOptions
 * @param {{mode?: number}} [options]
 * @returns {CheckpointStore}
 */
export function createCheckpointStore(pathOrOptions, options) {
  return new CheckpointStore(pathOrOptions, options);
}

/**
 * @param {CheckpointStore|string|CheckpointStoreOptions} store
 * @param {{mode?: number}} [options]
 * @returns {Promise<Checkpoint|null>}
 */
export async function loadCheckpoint(store, options) {
  const checkpointStore = store instanceof CheckpointStore ? store : new CheckpointStore(store, options);
  return checkpointStore.load();
}

/**
 * @param {CheckpointStore|string|CheckpointStoreOptions} store
 * @param {unknown} checkpoint
 * @param {{mode?: number}} [options]
 * @returns {Promise<Checkpoint>}
 */
export async function saveCheckpoint(store, checkpoint, options) {
  const checkpointStore = store instanceof CheckpointStore ? store : new CheckpointStore(store, options);
  return checkpointStore.save(checkpoint);
}

export const readCheckpoint = loadCheckpoint;
export const writeCheckpoint = saveCheckpoint;
export default CheckpointStore;
