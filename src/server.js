import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_REGISTRY, publicChain } from "./config/chains.js";
import { redactData, sanitizeErrorText } from "./core/privacy.js";
import { toJsonSafe } from "./core/ranker.js";
import { scanChains } from "./scanners/index.js";

const NAME = "AddressScribe";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 8192;
const MAX_BLOCKS = 50;
const MAX_CONCURRENCY = 8;
const MAX_LIMIT = 100;
const MAX_TIMEOUT_MS = 300000;
const MAX_ACTIVE_SCANS = 64;
const DEFAULT_SCAN_TIMEOUT_MS = 180000;
const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-Robots-Tag": "noindex, nofollow, noarchive"
});

const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8", "no-cache"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8", "no-cache"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8", "no-cache"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8", "no-cache"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8", "public, max-age=3600"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8", "no-cache"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml", "public, max-age=86400"]],
  ["/icon-192.png", ["icon-192.png", "image/png", "public, max-age=86400"]],
  ["/icon-512.png", ["icon-512.png", "image/png", "public, max-age=86400"]]
]);

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function envValue(env, name) {
  const value = env?.[name];
  return value === undefined || value === null || String(value).trim() === "" ? undefined : String(value);
}

function integerValue(value, name, minimum, maximum) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function isLoopback(host) {
  const value = String(host || "").replace(/^\[|\]$/g, "").toLowerCase().split("%", 1)[0];
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value.startsWith("::ffff:")) return isLoopback(value.slice(7));
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function validateHost(host) {
  const value = String(host || "").trim();
  if (!value || /[\s/\\]/.test(value) || value.length > 255) throw new TypeError("ADDRESSSCRIBE_HOST is invalid");
  return value;
}

function validateToken(token) {
  const value = String(token ?? "");
  let hasControl = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) hasControl = true;
  }
  if ((value && value.length < 16) || value.length > 512 || hasControl) throw new TypeError("ADDRESSSCRIBE_TOKEN is invalid");
  return value;
}

function booleanValue(value, name) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  throw new TypeError(`${name} must be a boolean`);
}

export function readServerConfig(env = process.env, overrides = {}) {
  const host = validateHost(overrides.host ?? envValue(env, "ADDRESSSCRIBE_HOST") ?? "127.0.0.1");
  const port = integerValue(overrides.port ?? envValue(env, "ADDRESSSCRIBE_PORT") ?? envValue(env, "PORT"), "ADDRESSSCRIBE_PORT", 0, 65535) ?? 4173;
  const token = validateToken(overrides.token ?? envValue(env, "ADDRESSSCRIBE_TOKEN") ?? "");
  const allowInsecureLan = booleanValue(overrides.allowInsecureLan ?? envValue(env, "ADDRESSSCRIBE_ALLOW_INSECURE_LAN"), "ADDRESSSCRIBE_ALLOW_INSECURE_LAN");
  const rateLimit = integerValue(overrides.rateLimit ?? envValue(env, "ADDRESSSCRIBE_RATE_LIMIT"), "ADDRESSSCRIBE_RATE_LIMIT", 1, 10000) ?? 90;
  const rateWindowMs = integerValue(overrides.rateWindowMs ?? envValue(env, "ADDRESSSCRIBE_RATE_WINDOW_MS"), "ADDRESSSCRIBE_RATE_WINDOW_MS", 1000, 3600000) ?? 60000;
  const scanTimeoutMs = integerValue(overrides.scanTimeoutMs ?? envValue(env, "ADDRESSSCRIBE_SCAN_TIMEOUT_MS") ?? envValue(env, "ADDRESSSCRIBE_TIMEOUT_MS"), "ADDRESSSCRIBE_SCAN_TIMEOUT_MS", 100, MAX_TIMEOUT_MS) ?? DEFAULT_SCAN_TIMEOUT_MS;
  const maxActiveScans = integerValue(overrides.maxActiveScans ?? envValue(env, "ADDRESSSCRIBE_MAX_ACTIVE_SCANS"), "ADDRESSSCRIBE_MAX_ACTIVE_SCANS", 1, MAX_ACTIVE_SCANS) ?? 8;
  const maxBodyBytes = integerValue(overrides.maxBodyBytes ?? envValue(env, "ADDRESSSCRIBE_MAX_BODY_BYTES"), "ADDRESSSCRIBE_MAX_BODY_BYTES", 1, 65536) ?? MAX_BODY_BYTES;
  const secure = !isLoopback(host);
  if (secure && !token) throw new Error("ADDRESSSCRIBE_TOKEN is required for a non-loopback bind");
  if (secure && !allowInsecureLan) throw new Error("Non-loopback binds require an HTTPS reverse proxy; set ADDRESSSCRIBE_ALLOW_INSECURE_LAN=1 only for a trusted test network");
  return Object.freeze({ host, port, token, secure, allowInsecureLan, rateLimit, rateWindowMs, scanTimeoutMs, maxActiveScans, maxBodyBytes });
}

export function isLoopbackHost(host) {
  return isLoopback(host);
}

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function json(response, status, payload, headers = {}) {
  if (response.destroyed || response.writableEnded) return false;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  if (response.req?.method === "HEAD") response.end();
  else response.end(body);
  return true;
}

function error(response, status, code, message, headers = {}) {
  return json(response, status, { ok: false, error: { code, message: sanitizeErrorText(message) } }, headers);
}

function validateScan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "invalid_request", "A JSON object is required.");
  const allowed = new Set(["mode", "chains", "blocks", "concurrency", "limit"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new RequestError(400, "invalid_request", "The request contains unsupported fields.");
  const mode = value.mode ?? "activity";
  if (!["activity", "balances", "multichain"].includes(mode)) throw new RequestError(400, "invalid_mode", "Choose activity, balances, or multichain.");
  if (!Array.isArray(value.chains) || value.chains.length < 1 || value.chains.length > CHAIN_REGISTRY.length) throw new RequestError(400, "invalid_chains", `Select 1 to ${CHAIN_REGISTRY.length} chains.`);
  const ids = [...new Set(value.chains)];
  if (ids.some((id) => typeof id !== "string" || !CHAIN_REGISTRY.some((chain) => chain.id === id))) throw new RequestError(400, "invalid_chains", "One or more chains are not supported.");
  const blocks = value.blocks ?? 2;
  const concurrency = value.concurrency ?? 4;
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) throw new RequestError(400, "invalid_blocks", `Blocks must be an integer from 1 to ${MAX_BLOCKS}.`);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new RequestError(400, "invalid_concurrency", `Concurrency must be an integer from 1 to ${MAX_CONCURRENCY}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RequestError(400, "invalid_limit", `Limit must be an integer from 1 to ${MAX_LIMIT}.`);
  return { mode, chains: ids, blocks, concurrency, limit };
}

function readJson(request, maximum) {
  return new Promise((resolveBody, rejectBody) => {
    const type = String(request.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
    if (type !== "application/json" && !type.endsWith("+json")) {
      request.resume();
      rejectBody(new RequestError(415, "unsupported_media_type", "Content-Type must be application/json."));
      return;
    }
    const declared = request.headers["content-length"];
    let expectedLength;
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) {
        request.resume();
        rejectBody(new RequestError(400, "invalid_request", "Content-Length is invalid."));
        return;
      }
      if (length > maximum) {
        request.resume();
        rejectBody(new RequestError(413, "body_too_large", "Request body is too large."));
        return;
      }
      expectedLength = length;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const finish = (callback, output) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(output);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        chunks.length = 0;
        request.resume();
        finish(rejectBody, new RequestError(413, "body_too_large", "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!chunks.length) return finish(rejectBody, new RequestError(400, "invalid_json", "A JSON body is required."));
      if (expectedLength !== undefined && expectedLength !== size) return finish(rejectBody, new RequestError(400, "invalid_length", "Content-Length does not match the request body."));
      try {
        finish(resolveBody, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(rejectBody, new RequestError(400, "invalid_json", "Request body is not valid JSON."));
      }
    };
    const onAbort = () => finish(rejectBody, new RequestError(400, "request_aborted", "Request body was interrupted."));
    const onError = () => finish(rejectBody, new RequestError(400, "request_error", "Request body could not be read."));
    timer = setTimeout(() => {
      request.resume();
      finish(rejectBody, new RequestError(408, "request_timeout", "Request body timed out."));
    }, 10000);
    timer.unref?.();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

export function fixedWindowLimiter(limit, windowMs, now = () => Date.now(), maxKeys = 4096) {
  const entries = new Map();
  let nextSweep = 0;
  return (key) => {
    const current = Number(now());
    if (current >= nextSweep) {
      for (const [candidate, value] of entries) if (value.resetAt <= current) entries.delete(candidate);
      nextSweep = current + Math.max(1000, Math.min(windowMs, 60000));
    }
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entry = { count: 0, resetAt: current + windowMs };
      entries.set(key, entry);
    }
    if (entry.count >= limit) return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    entry.count += 1;
    return { allowed: true, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
  };
}

function applyHeaders(response, secure) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

async function staticFile(path, request, response) {
  const descriptor = STATIC.get(path);
  if (!descriptor) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    error(response, 405, "method_not_allowed", "Method not allowed.", { Allow: "GET, HEAD" });
    return true;
  }
  try {
    const body = await readFile(join(PUBLIC_ROOT, descriptor[0]));
    if (response.destroyed || response.writableEnded) return true;
    response.writeHead(200, { "Cache-Control": descriptor[2], "Content-Length": body.length, "Content-Type": descriptor[1] });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    error(response, 500, "static_unavailable", "The application shell is unavailable.");
  }
  return true;
}

function ndjson(response, payload) {
  if (response.destroyed || response.writableEnded) return false;
  return response.write(`${JSON.stringify(payload)}\n`);
}

function scrubResult(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    const result = value.map((item) => scrubResult(item, seen));
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  const output = {};
  for (const [key, child] of Object.entries(value)) output[key] = key === "error" ? "scan-failed" : scrubResult(child, seen);
  seen.delete(value);
  return output;
}

function safeResult(result) {
  return scrubResult(redactData(toJsonSafe(result && typeof result === "object" ? result : { coverage: { status: "partial", complete: false, partial: true, reasons: ["invalid-result"] }, candidates: [] })));
}

function scanTimeoutError() {
  const error = new Error("Scan timed out");
  error.name = "ScanTimeoutError";
  error.code = "scan_timeout";
  return error;
}

function shutdownError() {
  const error = new Error("Server is shutting down");
  error.name = "ServerShutdownError";
  error.code = "server_shutdown";
  return error;
}

function scannerOptions(options, signal) {
  const output = {
    env: options.env ?? process.env,
    signal,
    timeoutMs: options.scanTimeoutMs
  };
  for (const key of ["rpcTimeoutMs", "maxRetries", "requestsPerSecond", "burst", "maxResponseBytes", "maxBatchSize", "rpcUrls", "clients", "clientFactory", "now", "onProgress", "onResult"]) {
    if (Object.hasOwn(options, key)) output[key] = options[key];
  }
  return output;
}

async function runScan(scan, request, response, normalized, options) {
  if (options.activeScans.size >= options.maxActiveScans) {
    error(response, 503, "server_busy", "The scanner is busy. Try again shortly.", { "Retry-After": "1" });
    return;
  }
  const controller = new AbortController();
  const task = { controller };
  options.activeScans.add(task);
  let timedOut = false;
  let clientClosed = false;
  const onAbort = () => {
    clientClosed = true;
    if (!response.writableEnded) controller.abort(new Error("client-disconnected"));
  };
  const onClose = () => {
    if (!response.writableEnded) {
      clientClosed = true;
      controller.abort(new Error("client-disconnected"));
    }
  };
  request.once("aborted", onAbort);
  response.once("close", onClose);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const timeout = scanTimeoutError();
      controller.abort(timeout);
      reject(timeout);
    }, options.scanTimeoutMs);
    timer.unref?.();
  });
  const scanOptions = scannerOptions(options, controller.signal);
  const taskPromise = Promise.resolve().then(() => scan(normalized, scanOptions));
  task.promise = taskPromise.then(
    () => options.activeScans.delete(task),
    () => options.activeScans.delete(task)
  );
  try {
    const result = await Promise.race([taskPromise, timeoutPromise]);
    if (response.destroyed || response.writableEnded) return;
    if (controller.signal.reason?.code === "server_shutdown") {
      if (normalized.stream) {
        ndjson(response, { type: "error", code: "server_restarting", message: "The scanner is restarting." });
        response.end();
      } else {
        error(response, 503, "server_restarting", "The scanner is restarting.");
      }
      return;
    }
    if (normalized.stream) {
      ndjson(response, { type: "complete", result: safeResult(result) });
      response.end();
    } else {
      json(response, 200, { ok: true, result: safeResult(result) });
    }
  } catch {
    if (response.destroyed || response.writableEnded || clientClosed) return;
    if (controller.signal.reason?.code === "server_shutdown") {
      if (normalized.stream) {
        ndjson(response, { type: "error", code: "server_restarting", message: "The scanner is restarting." });
        response.end();
      } else {
        error(response, 503, "server_restarting", "The scanner is restarting.");
      }
      return;
    }
    if (normalized.stream) {
      ndjson(response, { type: "error", message: timedOut ? "The scan exceeded its time limit." : "The chain scanner could not complete the scan." });
      response.end();
    } else {
      error(response, timedOut ? 504 : 502, timedOut ? "scan_timeout" : "scan_failed", timedOut ? "The scan exceeded its time limit." : "The chain scanner could not complete the scan.");
    }
  } finally {
    clearTimeout(timer);
    request.off("aborted", onAbort);
    response.off("close", onClose);
  }
}

export function createServer(options = {}) {
  const config = readServerConfig(options.env ?? process.env, options);
  const scan = options.scanChains ?? scanChains;
  const consume = fixedWindowLimiter(config.rateLimit, config.rateWindowMs, options.clock);
  const activeScans = new Set();
  const server = createHttpServer(async (request, response) => {
    applyHeaders(response, config.secure);
    const path = typeof request.url === "string" ? request.url.split("?", 1)[0] : "/";
    try {
      if (STATIC.has(path)) {
        await staticFile(path, request, response);
        return;
      }
      if (path === "/api/health") {
        if (request.method !== "GET" && request.method !== "HEAD") return error(response, 405, "method_not_allowed", "Method not allowed.", { Allow: "GET, HEAD" });
        return json(response, 200, {
          ok: true,
          name: NAME,
          version: VERSION,
          privacy: { readOnly: true, cookies: false, browserStorage: false, telemetry: false, privateKeyAccess: false }
        });
      }
      const protectedApi = path === "/api/chains" || path === "/api/scan" || path === "/api/scan/stream";
      if (protectedApi) {
        const key = request.socket.remoteAddress || "unknown";
        const rate = consume(key);
        const now = Number(typeof options.clock === "function" ? options.clock() : Date.now());
        const rateHeaders = {
          "RateLimit-Limit": String(config.rateLimit),
          "RateLimit-Remaining": String(rate.remaining),
          "RateLimit-Reset": String(Math.max(0, Math.ceil((rate.resetAt - now) / 1000)))
        };
        if (!rate.allowed) return error(response, 429, "rate_limited", "Too many requests. Try again shortly.", { ...rateHeaders, "Retry-After": String(Math.max(1, Math.ceil((rate.resetAt - now) / 1000))) });
        for (const [name, value] of Object.entries(rateHeaders)) response.setHeader(name, value);
        if (config.secure && !tokenMatches(request.headers["x-addressscribe-token"], config.token)) return error(response, 401, "unauthorized", "A valid AddressScribe token is required.", { "WWW-Authenticate": "AddressScribe" });
      }
      if (path === "/api/chains") {
        if (request.method !== "GET" && request.method !== "HEAD") return error(response, 405, "method_not_allowed", "Method not allowed.", { Allow: "GET, HEAD" });
        return json(response, 200, { ok: true, chains: CHAIN_REGISTRY.map(publicChain) });
      }
      if (path !== "/api/scan" && path !== "/api/scan/stream") return error(response, 404, "not_found", "Resource not found.");
      if (request.method !== "POST") return error(response, 405, "method_not_allowed", "Method not allowed.", { Allow: "POST" });
      const body = await readJson(request, config.maxBodyBytes);
      const normalized = validateScan(body);
      if (activeScans.size >= config.maxActiveScans) return error(response, 503, "server_busy", "The scanner is busy. Try again shortly.", { "Retry-After": "1" });
      if (path === "/api/scan/stream") {
        normalized.stream = true;
        response.writeHead(200, { "Cache-Control": "no-store", "Connection": "keep-alive", "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        ndjson(response, { type: "started", request: { mode: normalized.mode, chains: normalized.chains, blocks: normalized.blocks, concurrency: normalized.concurrency, limit: normalized.limit }, chainCount: normalized.chains.length });
        const streamScan = async (requestValue, scanOptions) => {
          scanOptions.onResult = (result) => ndjson(response, { type: "chain", result: safeResult(result) });
          scanOptions.onProgress = (progress) => ndjson(response, { type: "progress", progress: scrubResult(toJsonSafe(progress)) });
          return scan(requestValue, scanOptions);
        };
        return runScan(streamScan, request, response, normalized, { ...options, env: options.env ?? process.env, scanTimeoutMs: config.scanTimeoutMs, maxActiveScans: config.maxActiveScans, activeScans });
      }
      return runScan(scan, request, response, normalized, { ...options, env: options.env ?? process.env, scanTimeoutMs: config.scanTimeoutMs, maxActiveScans: config.maxActiveScans, activeScans });
    } catch (caught) {
      if (caught instanceof RequestError) return error(response, caught.status, caught.code, caught.message);
      if (!response.destroyed && !response.writableEnded) error(response, 500, "internal_error", "The request could not be completed.");
    }
  });
  server.requestTimeout = Math.max(30000, config.scanTimeoutMs + 5000);
  server.headersTimeout = Math.min(10000, server.requestTimeout);
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.on("clientError", (_caught, socket) => {
    if (socket.destroyed || !socket.writable) return;
    const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    const hsts = config.secure ? "Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n" : "";
    socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n${hsts}${headers}\r\n\r\n`);
  });
  server.gracefulClose = (graceMs = 5000) => new Promise((resolveClose) => {
    for (const task of activeScans) task.controller.abort(shutdownError());
    let finished = false;
    let timer;
    let idleTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      resolveClose();
    };
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, Math.max(0, Math.min(30000, graceMs)));
    timer.unref?.();
    idleTimer = setInterval(() => server.closeIdleConnections?.(), 10);
    idleTimer.unref?.();
    if (!server.listening) return finish();
    server.close(() => finish());
    server.closeIdleConnections?.();
  });
  server.shutdown = server.gracefulClose;
  return server;
}

export function startServer(options = {}) {
  const config = readServerConfig(options.env ?? process.env, options);
  const server = createServer({ ...options, env: options.env ?? process.env });
  const port = config.port;
  server.listen(port, config.host, () => {
    const address = server.address();
    const actual = address && typeof address === "object" ? address.port : port;
    process.stdout.write(`AddressScribe listening on http://${config.host}:${actual}\n`);
  });
  return server;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const server = startServer();
  server.once("error", (error) => {
    process.stderr.write(`AddressScribe: ${sanitizeErrorText(error)}\n`);
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.gracefulClose().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
