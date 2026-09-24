const $ = (selector) => document.querySelector(selector);
const state = {
  chains: [],
  selected: new Set(),
  mode: "activity",
  controller: null,
  busy: false,
  results: new Map(),
  wallets: new Map(),
  installEvent: null,
  token: "",
  chainsLoaded: false,
  searchTimer: null
};
const errors = {
  unauthorized: "Сервер на LAN требует токен. Введите его в блоке «Удалённый доступ».",
  rate_limited: "Слишком много запросов. Подождите минуту.",
  invalid_chains: "Проверьте выбранные сети.",
  invalid_blocks: "Глубина должна быть от 1 до 50.",
  invalid_limit: "Лимит должен быть от 1 до 100.",
  scan_timeout: "Поиск превысил лимит времени.",
  body_too_large: "Запрос слишком велик.",
  scanner_unavailable: "Сканер недоступен.",
  static_unavailable: "Не удалось загрузить оболочку приложения.",
  server_restarting: "Сканер перезапускается.",
  stream_closed: "Поток поиска закрылся до завершения."
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function boundedInput(selector, fallback, minimum, maximum) {
  const number = Number($(selector).value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function validBalance(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function compareBalances(left, right) {
  const leftBalance = validBalance(left);
  const rightBalance = validBalance(right);
  if (leftBalance && rightBalance) {
    const difference = BigInt(leftBalance) - BigInt(rightBalance);
    if (difference !== 0n) return difference > 0n ? -1 : 1;
  } else if (leftBalance) {
    return -1;
  } else if (rightBalance) {
    return 1;
  }
  return 0;
}

function isAddress(value) {
  return typeof value === "string" && (/^0x[0-9a-f]{40}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value));
}

function shortAddress(value) {
  if (!isAddress(value)) return "неизвестно";
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-7)}` : value;
}

function connection(mode, label) {
  const element = $("#connection");
  element.className = `connection ${mode}`;
  element.lastElementChild.textContent = label;
}

function log(line, tone = "muted") {
  const terminal = $("#terminal-log");
  const paragraph = node("p", tone);
  const name = node("span", "", `${tone}:`);
  paragraph.append(name, document.createTextNode(` ${line}`));
  terminal.append(paragraph);
  terminal.scrollTop = terminal.scrollHeight;
  while (terminal.childElementCount > 18) terminal.firstElementChild.remove();
}

function chainById(id) {
  return state.chains.find((chain) => chain.id === id) ?? null;
}

function updateControls() {
  const selected = state.selected.size;
  $("#chain-count").textContent = state.chains.length ? `Выбрано ${selected} из ${state.chains.length}` : "Загрузка реестра…";
  $("#scan-button").disabled = state.busy || selected === 0;
  $("#scan-form").setAttribute("aria-busy", String(state.busy));
  $("#cancel").hidden = !state.busy;
  for (const input of document.querySelectorAll('input[name="chains"]')) input.disabled = state.busy;
  for (const input of document.querySelectorAll('input[name="mode"]')) input.disabled = state.busy;
  $("#depth").disabled = state.busy;
  $("#concurrency").disabled = state.busy;
  $("#limit").disabled = state.busy;
  $("#select-all").disabled = state.busy;
  $("#clear-all").disabled = state.busy;
  $("#chain-search").disabled = state.busy;
  $("#access-token").disabled = state.busy;
  $("#apply-token").disabled = state.busy;
}

function renderChains() {
  const query = $("#chain-search").value.trim().toLowerCase();
  const grid = $("#chain-grid");
  const visible = state.chains.filter((chain) => `${chain.id} ${chain.name} ${chain.symbol} ${chain.family}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const chain of visible) {
    const label = node("label", "chain-option");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "chains";
    input.value = chain.id;
    input.setAttribute("aria-label", `Выбрать сеть ${chain.name}`);
    input.checked = state.selected.has(chain.id);
    const choice = node("span", "chain-choice");
    const check = node("i", "check");
    const identity = node("span", "chain-identity");
    identity.append(node("b", "", chain.name), node("small", "", `${chain.id} · ${chain.family.toUpperCase()}`));
    const capabilities = node("span", "capabilities");
    capabilities.append(node("i", "", "GAS"));
    const zeroEx = node("i", chain.zeroEx.supported ? "on" : "", chain.zeroEx.supported ? "0X" : "—");
    capabilities.append(zeroEx);
    choice.append(check, identity, capabilities);
    label.append(input, choice);
    fragment.append(label);
  }
  if (!visible.length) fragment.append(node("p", "inline-state", "Сети не найдены"));
  grid.replaceChildren(fragment);
  updateControls();
}

function setSelected(ids) {
  state.selected = new Set(ids.filter((id) => chainById(id)));
  renderChains();
}

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.token) headers["X-AddressScribe-Token"] = state.token;
  return headers;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store", credentials: "omit", headers: apiHeaders() });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("API вернул нечитаемый ответ");
  }
  if (!response.ok || payload?.ok !== true) {
    const message = errors[payload?.error?.code] ?? payload?.error?.message ?? payload?.message ?? "API недоступен";
    throw new Error(message);
  }
  return payload;
}

async function loadChains() {
  const grid = $("#chain-grid");
  connection("", "Подключение");
  grid.setAttribute("aria-busy", "true");
  try {
    const [health, payload] = await Promise.all([fetchJson("/api/health"), fetchJson("/api/chains")]);
    if (health.name !== "AddressScribe" || health.privacy?.readOnly !== true) throw new Error("Неожиданный ответ API");
    state.chains = Array.isArray(payload.chains) ? payload.chains : [];
    if (!state.chains.length) throw new Error("Реестр сетей пуст");
    if (!state.chainsLoaded) {
      state.selected = new Set(state.chains.filter((chain) => ["ethereum", "base", "solana"].includes(chain.id)).map((chain) => chain.id));
      state.chainsLoaded = true;
    }
    $("#chain-fieldset").disabled = false;
    $("#chain-error").hidden = true;
    renderChains();
    connection("online", "API готов");
    log("chain_registry_loaded", "ok");
  } catch (caught) {
    grid.replaceChildren(node("p", "inline-state", caught.message));
    connection("offline", "Нет API");
    $("#chain-fieldset").disabled = state.chains.length === 0;
    $("#chain-error").textContent = caught.message;
    $("#chain-error").hidden = false;
  } finally {
    grid.setAttribute("aria-busy", "false");
  }
}

function candidateKey(candidate) {
  if (state.mode === "multichain" && candidate.family === "evm") return `evm:${candidate.address.toLowerCase()}`;
  return `${candidate.family}:${candidate.chain}:${candidate.address}`;
}

function addChainResult(result) {
  if (!result || typeof result !== "object") return;
  state.results.set(result.chain, result);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  for (const candidate of candidates) {
    const enriched = { ...candidate, chain: result.chain, family: result.family, symbol: result.symbol, explorerUrl: result.explorerUrl };
    state.wallets.set(candidateKey(enriched), enriched);
  }
  updateSummary();
  for (const candidate of candidates.slice(0, 12)) appendLive(candidate, result);
  renderTable();
  if (result.coverage?.partial) {
    $("#partial").hidden = false;
    log(`${result.chain}: partial (${result.coverage.reasons?.join(", ") || "coverage"})`, "warn");
  } else {
    log(`${result.chain}: complete`, "ok");
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      void error;
    }
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.className = "clipboard-proxy";
  area.setAttribute("readonly", "true");
  document.body.append(area);
  area.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  area.remove();
  return copied;
}

function appendLive(candidate, result) {
  const row = node("div", "wallet-line");
  const addressNode = node("code", "", shortAddress(candidate.address));
  addressNode.title = candidate.address;
  const meta = node("span", "wallet-meta", `${result.chain} · tx=${count(candidate.transactionCount)} · score=${count(candidate.activityScore)}`);
  const balance = candidate.nativeBalanceFormatted ? `${candidate.nativeBalanceFormatted} ${result.symbol}` : "balance=?";
  const value = node("span", "wallet-balance", balance);
  const copy = node("button", "copy", "copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Скопировать адрес ${candidate.address}`);
  copy.addEventListener("click", async () => {
    try {
      if (!(await copyText(candidate.address))) throw new Error("Clipboard unavailable");
      copy.textContent = "copied";
    } catch {
      copy.textContent = "error";
    }
    setTimeout(() => { copy.textContent = "copy"; }, 900);
  });
  row.append(node("span", "plus", "+"), addressNode, meta, value, copy);
  const stream = $("#wallet-stream");
  if (stream.childElementCount >= 40) stream.firstElementChild.remove();
  stream.append(row);
}

function updateSummary() {
  const total = state.wallets.size;
  const complete = [...state.results.values()].filter((result) => result.coverage?.complete).length;
  const partial = [...state.results.values()].filter((result) => result.coverage?.partial).length;
  $("#summary-chain").textContent = String(state.results.size);
  $("#summary-wallets").textContent = String(total);
  $("#summary-coverage").textContent = state.results.size ? `${complete}/${state.results.size}${partial ? " partial" : ""}` : "—";
}

function renderTable() {
  const wallets = [...state.wallets.values()].sort((left, right) => {
    if (state.mode === "balances") {
      const balanceOrder = compareBalances(left.nativeBalance, right.nativeBalance);
      if (balanceOrder) return balanceOrder;
    }
    return count(right.activityScore) - count(left.activityScore) || left.address.localeCompare(right.address);
  }).slice(0, 100);
  const fragment = document.createDocumentFragment();
  for (const wallet of wallets) {
    const row = document.createElement("tr");
    const addressCell = document.createElement("td");
    const code = node("code", "", shortAddress(wallet.address));
    code.title = wallet.address;
    addressCell.append(code);
    const type = wallet.chainCount ? `${wallet.chainCount} EVM` : wallet.chain;
    row.append(
      addressCell,
      node("td", "", type),
      node("td", "", String(count(wallet.activityScore))),
      node("td", "", String(count(wallet.transactionCount))),
      node("td", "", wallet.nativeBalanceFormatted ? `${wallet.nativeBalanceFormatted} ${wallet.symbol}` : "—"),
      node("td", "", wallet.classification ?? "unknown")
    );
    fragment.append(row);
  }
  $("#result-body").replaceChildren(fragment);
  $("#table-wrap").hidden = wallets.length === 0;
  $("#empty").hidden = wallets.length > 0;
}

function handleStreamEvent(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "started") {
    $("#run-state").textContent = "SCANNING";
    log(`scope=${payload.request.chains.length} depth=${payload.request.blocks}`, "info");
  }
  if (payload.type === "progress") {
    const progress = payload.progress ?? {};
    if (progress.phase && progress.phase !== "starting") log(`${progress.chain}: ${progress.phase} ${progress.completed}/${progress.total}`, "dim");
  }
  if (payload.type === "chain") addChainResult(payload.result);
  if (payload.type === "complete") {
    const result = payload.result;
    if (result?.wallets) {
      for (const wallet of result.wallets) state.wallets.set(candidateKey(wallet), { ...wallet, chain: wallet.chains?.[0] ?? wallet.chain, family: wallet.family, symbol: wallet.chainDetails?.[0]?.symbol ?? wallet.symbol });
    }
    updateSummary();
    renderTable();
    $("#run-state").textContent = result.summary?.partial ? "PARTIAL" : "COMPLETE";
    $("#partial").hidden = !result.summary?.partial;
    log(`done wallets=${state.wallets.size}`, "ok");
  }
  if (payload.type === "cancelled") {
    $("#run-state").textContent = "CANCELLED";
    log("cancelled", "warn");
  }
  if (payload.type === "error") {
    const message = errors[payload.code] ?? payload.message ?? "Поток поиска завершился с ошибкой";
    const error = new Error(message);
    error.code = payload.code ?? "stream_error";
    throw error;
  }
  return payload.type;
}

async function consumeNdjson(response) {
  if (!response.body?.getReader) throw new Error("Браузер не поддерживает потоковый ответ");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maximumBuffer = 8 * 1024 * 1024;
  let buffer = "";
  let terminal = false;
  const consumeLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      log("stream_parse_error", "warn");
      return;
    }
    const type = handleStreamEvent(event);
    if (type === "complete" || type === "cancelled" || type === "error") terminal = true;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    if (buffer.length > maximumBuffer) throw new Error("Поток поиска слишком велик");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffer);
  if (!terminal) throw new Error(errors.stream_closed);
}

function resetRun() {
  state.results.clear();
  state.wallets.clear();
  $("#wallet-stream").replaceChildren();
  $("#result-body").replaceChildren();
  $("#table-wrap").hidden = true;
  $("#empty").hidden = false;
  $("#error").hidden = true;
  $("#partial").hidden = true;
  $("#summary-chain").textContent = "0";
  $("#summary-wallets").textContent = "0";
  $("#summary-coverage").textContent = "—";
  $("#terminal-log").replaceChildren();
  updateSummary();
}

async function runScan(event) {
  event.preventDefault();
  if (state.busy || !state.selected.size) return;
  resetRun();
  state.busy = true;
  state.controller = new AbortController();
  updateControls();
  const request = {
    mode: state.mode,
    chains: [...state.selected],
    blocks: boundedInput("#depth", 2, 1, 50),
    concurrency: boundedInput("#concurrency", 4, 1, 8),
    limit: boundedInput("#limit", 50, 1, 100)
  };
  log(`mode=${request.mode} chains=${request.chains.length}`, "info");
  try {
    const response = await fetch("/api/scan/stream", {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "omit",
      signal: state.controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(errors[payload?.error?.code] ?? payload?.error?.message ?? "API недоступен");
    }
    await consumeNdjson(response);
    if (!$("#run-state").textContent || $("#run-state").textContent === "SCANNING") {
      $("#run-state").textContent = "COMPLETE";
      log("stream_closed", "ok");
    }
  } catch (caught) {
    if (caught.name === "AbortError") {
      $("#run-state").textContent = "CANCELLED";
      log("cancelled_by_user", "warn");
    } else {
      $("#run-state").textContent = "ERROR";
      $("#error-text").textContent = caught.message;
      $("#error").hidden = false;
      log(caught.message, "error");
    }
  } finally {
    state.busy = false;
    state.controller = null;
    updateControls();
  }
}

$("#scan-form").addEventListener("submit", runScan);
$("#chain-grid").addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== "chains") return;
  if (input.checked) state.selected.add(input.value);
  else state.selected.delete(input.value);
  updateControls();
});
$("#chain-search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(renderChains, 150);
});
$("#select-all").addEventListener("click", () => {
  const query = $("#chain-search").value.trim().toLowerCase();
  for (const chain of state.chains) {
    if (!query || `${chain.id} ${chain.name} ${chain.symbol} ${chain.family}`.toLowerCase().includes(query)) state.selected.add(chain.id);
  }
  renderChains();
});
$("#clear-all").addEventListener("click", () => setSelected([]));
$("#depth").addEventListener("input", () => { $("#depth-output").textContent = $("#depth").value; });
$("#modes").addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement) state.mode = event.target.value;
  $("#run-state").textContent = state.mode.toUpperCase();
});
$("#access-token").addEventListener("input", (event) => { state.token = event.target.value.trim(); });
$("#apply-token").addEventListener("click", async () => {
  const button = $("#apply-token");
  button.disabled = true;
  try {
    await loadChains();
  } finally {
    button.disabled = state.busy;
  }
});
$("#cancel").addEventListener("click", () => state.controller?.abort());

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (!state.installEvent) return;
  state.installEvent.prompt();
  await state.installEvent.userChoice;
  state.installEvent = null;
  $("#install").hidden = true;
});
window.addEventListener("appinstalled", () => {
  $("#install").hidden = true;
  $("#install-note").textContent = "AddressScribe установлен. Офлайн доступна только оболочка; поиск требует запущенного API.";
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
  $("#install-note").textContent = "Офлайн-оболочка недоступна в этом браузере.";
});

updateControls();
loadChains();
