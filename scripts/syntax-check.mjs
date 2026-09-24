import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const roots = ["src", "public", "test", "scripts"];
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
}
for (const directory of roots) await collect(join(root, directory));
const failures = [];
for (const path of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", path], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) failures.push(`${relative(root, path)}: ${(result.stderr || "syntax error").trim()}`);
}
if (failures.length) {
  process.stderr.write(`Syntax check failed:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed (${files.length} files)\n`);
}
