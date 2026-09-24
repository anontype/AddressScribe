import { spawnSync } from "node:child_process";

const paths = ["wallets.txt", "worker.js", "credentials", "credentials.json", "credentials/prod.json", "credential", "credential.json", ".credentials/example", ".credentials/prod.json", ".env", ".npmrc", "secrets.json", "app.secret.json", "private.key", "private.pem", "client.p12"];
const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { input: `${paths.join("\n")}\n`, encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(`Index safety check failed: ${(result.stderr || "one or more paths are not ignored").trim()}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Index safety check passed (${paths.length} paths)\n`);
}
