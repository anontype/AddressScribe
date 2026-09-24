function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function unwrap(value) {
  if (isRecord(value) && value.error) {
    const error = new Error("RPC request failed");
    const details = isRecord(value.error) ? value.error : {};
    if (details.code !== undefined) error.code = details.code;
    if (details.status !== undefined) error.status = details.status;
    if (details.message !== undefined) error.rpcMessage = String(details.message);
    error.rpcError = true;
    throw error;
  }
  return isRecord(value) && Object.hasOwn(value, "result") ? value.result : value;
}

function invocationShapeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot destructure|method[^\n]*undefined|not a function|arguments[^\n]*method/i.test(message);
}

async function callRequest(request, client, method, params, options) {
  try {
    const value = await request.call(client, { method, params }, options);
    if (value !== undefined) return unwrap(value);
  } catch (error) {
    if (!invocationShapeError(error)) throw error;
  }
  return unwrap(await request.call(client, method, params, options));
}

export function makeRpcAdapter(client) {
  if (!client || typeof client !== "object") throw new TypeError("RPC client is required");
  const call = typeof client.call === "function" ? client.call.bind(client) : null;
  const request = typeof client.request === "function" ? client.request.bind(client) : null;
  if (!call && !request) throw new TypeError("RPC client must expose call or request");
  const batch = typeof client.batch === "function"
    ? client.batch.bind(client)
    : typeof client.requestBatch === "function"
      ? client.requestBatch.bind(client)
      : null;
  return {
    async call(method, params = [], signal) {
      const options = signal ? { signal } : {};
      if (call) {
        try {
          return unwrap(await call(method, params, options));
        } catch (error) {
          if (!request || !invocationShapeError(error)) throw error;
        }
      }
      return callRequest(request, client, method, params, options);
    },
    async batch(requests, signal) {
      if (!batch) return null;
      const options = signal ? { signal } : {};
      const response = await batch(requests, options);
      if (!Array.isArray(response)) return null;
      return response.map((item) => isRecord(item) && item.ok === false
        ? { ok: false, error: isRecord(item.error) ? item.error : null }
        : { ok: true, result: isRecord(item) && Object.hasOwn(item, "result") ? item.result : item });
    }
  };
}
