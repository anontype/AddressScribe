import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../public/app.js", import.meta.url);
const htmlUrl = new URL("../public/index.html", import.meta.url);
const workerUrl = new URL("../public/sw.js", import.meta.url);

test("PWA keeps token recovery, stream validation, and privacy boundaries explicit", async () => {
  const [app, html, worker] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(htmlUrl, "utf8"),
    readFile(workerUrl, "utf8")
  ]);
  assert.match(app, /#apply-token/);
  assert.match(app, /loadChains\(\)/);
  assert.match(app, /stream_parse_error/);
  assert.match(app, /stream_closed/);
  assert.match(app, /validBalance/);
  assert.match(html, /id="apply-token"/);
  assert.match(html, /scope="col"/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /self\.clients\.claim\(\)/);
  assert.doesNotMatch(app, new RegExp(["local", "Storage"].join("")));
  assert.doesNotMatch(app, new RegExp(["session", "Storage"].join("")));
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
});
