import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

function bin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("start-paper runs npm ci once when dotenv is missing and exits if it fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-boot-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const log = join(dir, "npm.log");
  bin(binDir, "npm", `#!/usr/bin/env bash
echo "$@" >> "${log}"
if [[ "$1" == "ci" ]]; then
  echo "npm ci failed" >&2
  exit 1
fi
exit 0
`);
  const result = spawnSync("bash", [join(root, "start-paper.sh")], {
    cwd: dir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, PAPER_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(`${result.stderr}`, /npm ci failed/);
  assert.match(`${result.stderr}`, /node_modules missing dotenv/);
});

test("start-paper keeps the npm ci check and restarts through the supervisor", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-supervised-"));
  mkdirSync(join(dir, "node_modules", "dotenv"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dotenv", "package.json"), "{}");
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const log = join(dir, "npm.log");
  bin(binDir, "npm", `#!/usr/bin/env bash
echo "$@" >> "${log}"
if [[ "$1" == "ci" ]]; then
  echo "npm ci should not run" >&2
  exit 1
fi
exit 1
`);
  const result = spawnSync("bash", [join(root, "start-paper.sh")], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PAPER_ROOT: dir,
      PAPER_SUPERVISOR_DELAYS: "0 0",
      PAPER_SUPERVISOR_MAX: "2",
      PAPER_SUPERVISOR_IMMEDIATE_SEC: "60",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const calls = readFileSync(log, "utf8");
  assert.equal(calls.includes("ci"), false);
  assert.equal(calls.trim().split("\n").length, 2);
  assert.match(`${result.stderr}`, /retry 1 in 0s/);
  assert.match(`${result.stderr}`, /giving up after 2 immediate exits/);
});

test("the supervisor backs off and stops after repeated immediate exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-sup-"));
  const child = join(dir, "fail.sh");
  writeFileSync(child, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(child, 0o755);
  const result = spawnSync("bash", [join(root, "run-supervised.sh")], {
    cwd: dir,
    env: {
      ...process.env,
      START_CMD: child,
      PAPER_SUPERVISOR_DELAYS: "0 0 0",
      PAPER_SUPERVISOR_MAX: "3",
      PAPER_SUPERVISOR_IMMEDIATE_SEC: "60",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const text = `${result.stderr}`;
  assert.match(text, /retry 1 in 0s/);
  assert.match(text, /retry 2 in 0s/);
  assert.match(text, /giving up after 3 immediate exits/);
});
