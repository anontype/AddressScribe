import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const roots = ["src", "public", "test", "scripts"];
const extensions = new Set([".js", ".mjs", ".cjs", ".html", ".css", ".json", ".webmanifest"]);
const rules = [
  { label: "key generation or signing", pattern: /\b(?:Wallet\.createRandom|privateKeyToAccount|generatePrivateKey|Keypair\.generate|signTransaction|signAndSend|sendRawTransaction|eth_sendRawTransaction)\b/i },
  { label: "private environment access", pattern: /env\.(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE)|process\.env\.(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE)/i },
  { label: "browser persistence", pattern: /\b(?:localStorage|sessionStorage|document\.cookie)\b/i },
  { label: "telemetry", pattern: /\b(?:gtag|mixpanel|posthog|segment\.analytics|telemetry\.track)\b/i },
  { label: "external executable resource", pattern: /(?:src|href)\s*=\s*["']https?:\/\//i }
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (extensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

const violations = [];
const self = fileURLToPath(import.meta.url);
for (const scope of roots) {
  for (const path of await files(join(root, scope))) {
    if (path === self) continue;
    const value = await readFile(path, "utf8");
    for (const rule of rules) if (rule.pattern.test(value)) violations.push(`${relative(root, path)}: ${rule.label}`);
  }
}

for (const name of ["worker.js", "wallets.txt", ".env", "credentials", "credentials.json", "id_rsa", "id_ed25519"]) {
  try {
    await stat(join(root, name));
    violations.push(`${name}: forbidden legacy or secret file is present`);
  } catch {
    continue;
  }
}

const ignoredPaths = ["wallets.txt", "worker.js", "credentials", "credentials.json", "credentials/prod.json", "credential", "credential.json", ".credentials/example", ".env", ".npmrc", "secrets.json", "app.secret.json", "private.key", "private.pem", "client.p12"];
const check = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: `${ignoredPaths.join("\n")}\n`, encoding: "utf8" });
if (check.status !== 0) violations.push("gitignore: future secret paths are not all ignored");
if (check.stderr) violations.push(`gitignore: ${check.stderr.trim()}`);

if (violations.length) {
  process.stderr.write(`Privacy check failed:\n${violations.map((line) => `- ${line}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Privacy check passed\n");
}
