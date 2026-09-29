#!/usr/bin/env bun
// Packs the real npm artifact, then runs the packaged accounting policy and
// report pipeline with no Bend, Clang or Bun reachable. This is the install
// claim, so it tests the tarball rather than the working tree.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const run = (cmd, options = {}) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...options });
const text = (result) => (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

// Resolve the reviewer before scrubbing PATH for the probe.
const node = process.env.WORKTIME_NODE ?? Bun.which("node");
check(node !== null, "no Node binary found; set WORKTIME_NODE or put node on PATH");
const nodeVersion = node ? text(run([node, "--version"])).trim() : "";
const floor = manifest.engines?.node?.replace(/[^0-9.]/g, "") ?? "0";
const atLeast = (a, b) => {
  const left = a.replace(/^v/, "").split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0, r = right[i] ?? 0;
    if (l !== r) return l > r;
  }
  return true;
};
check(atLeast(nodeVersion, floor), `Node ${floor}+ is required by package.json engines, found ${nodeVersion || "none"}`);

const workspace = mkdtempSync(join(tmpdir(), "pi-worktime-pack-"));
try {
  const packed = run(["npm", "pack", "--ignore-scripts", "--pack-destination", workspace], { cwd: root });
  check(packed.exitCode === 0, `npm pack failed: ${text(packed).slice(-600)}`);
  const tarball = readdirSync(workspace).find((name) => name.endsWith(".tgz"));
  check(tarball !== undefined, "npm pack produced no tarball");
  if (tarball === undefined || packed.exitCode !== 0) throw new Error(failures.join("; "));
  check(run(["tar", "-xzf", join(workspace, tarball), "-C", workspace]).exitCode === 0, "could not extract the packed tarball");
  const pkg = join(workspace, "package");

  const shipped = readdirSync(join(pkg, "generated"));
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const file of ["index.ts", "engine.bend", "audit.bend", "batch.bend", "native.ts", "report.ts", "LICENSE", "README.md"]) {
    check(Bun.file(join(pkg, file)).size > 0, `the tarball is missing ${file}`);
  }
  check(shipped.includes("policy.mjs"), "the tarball is missing generated/policy.mjs");
  check(shipped.includes("policy.d.mts"), "the tarball is missing generated/policy.d.mts");
  check(digest(join(pkg, "generated", "policy.mjs")) === digest(join(root, "generated", "policy.mjs")), "the tarball carries a different generated policy than the committed one");
  const notices = readFileSync(join(pkg, "THIRD_PARTY_NOTICES.md"), "utf8");
  check(notices.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") && notices.includes("END OF TERMS AND CONDITIONS") && notices.includes("Copyright 2026 HigherOrderCO"), "the tarball must carry Bend's license text and attribution");
  check(digest(join(pkg, "THIRD_PARTY_NOTICES.md")) === digest(join(root, "THIRD_PARTY_NOTICES.md")), "the tarball carries different third-party notices");
  for (const file of ["LAWS.bend", "PROOF.bend", "proof-gate.test.ts", "tsconfig.json"]) {
    check(!Bun.file(join(pkg, file)).size, `the tarball must not ship ${file}`);
  }
  check(!Bun.file(join(pkg, "scripts", "build-bend.mjs")).size, "the tarball must not ship build tooling");

  // The Pi host supplies peer packages; link the installed ones so resolution
  // matches a real install instead of failing on an absent node_modules.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const target = join(root, "node_modules", name);
    check(Bun.file(join(target, "package.json")).size > 0, `peer ${name} must be installed to verify the artifact`);
    if (Bun.file(join(target, "package.json")).size > 0) {
      mkdirSync(join(pkg, "node_modules", name.split("/").slice(0, -1).join("/")), { recursive: true });
      symlinkSync(target, join(pkg, "node_modules", name), "dir");
    }
  }

  const zero = join(workspace, "zero");
  const probe = `
import assert from "node:assert/strict";
import { evaluateIntervals, evaluateAudit } from ${JSON.stringify(join(pkg, "generated", "policy.mjs"))};
import { reconcileIntervals, auditTurnReceipts } from ${JSON.stringify(join(pkg, "native.ts"))};
import { appendJsonl } from ${JSON.stringify(join(pkg, "ledger.ts"))};
import { buildWorkReport } from ${JSON.stringify(join(pkg, "report.ts"))};
const value = (result) => { assert.equal(result.$, "Some"); return result.value; };
assert.equal(value(evaluateIntervals("0,5,20\\n0,0,10\\n0,5,20\\n0,30,40\\n0,20,25")), "worktime-v1\\n0,35\\n");
assert.deepEqual(evaluateIntervals("0,20,10"), { $: "None" });
assert.equal(value(evaluateAudit("0,60000,1,1,60000,1,0")), "worktime-audit-v1\\n0,0,60000,1\\n");
// A year of receipts must not overflow the stack in the emitted policy.
const many = Array.from({ length: 12000 }, (_, i) => "0," + (1000000 + i * 60000) + "," + (1000000 + i * 60000 + 180000)).join("\\n");
assert.equal(value(evaluateIntervals(many)), "worktime-v1\\n0," + (11999 * 60000 + 180000) + "\\n");
const manyAudit = Array.from({ length: 12000 }, (_, i) => i + ",300000,1,1,300000,1," + i).join("\\n");
const auditedLines = value(evaluateAudit(manyAudit)).trimEnd().split("\\n");
assert.equal(auditedLines.length, 12001);
assert.equal(auditedLines[12000], "11999,0,300000,1");
// The default lane must ignore a broken native pointer instead of shelling out.
assert.deepEqual(reconcileIntervals([[{ start: 0, end: 10 }, { start: 5, end: 20 }]]), [20]);
assert.throws(() => reconcileIntervals([[{ start: 0, end: 10 }]], { nativeExecutable: ${JSON.stringify(join(zero, "missing"))} }), /Bend reconciliation failed/);
const scope = "pack-pi-turn";
const at = (min) => new Date(Date.parse("2026-09-27T00:00:00Z") + min * 60000).toISOString();
const chunk = (id, from, to) => ({ version: 2, turnId: id, scope, start: at(from), end: at(to), ms: (to - from) * 60000, capped: false });
const turn = (id, ms) => ({ version: 1, id, startedAt: at(0), endedAt: at(20), observedMs: ms, outcome: "settled", scope, intervalVersion: 2 });
const logs = (name) => ${JSON.stringify(zero)} + "/" + name;
appendJsonl(logs("chunks"), chunk("t1", 0, 10));
appendJsonl(logs("chunks"), chunk("t1", 5, 15));
appendJsonl(logs("turns"), turn("t1", 900000));
const report = buildWorkReport({ root: ${JSON.stringify(zero)}, scopePrefix: "pack", timezones: ["UTC"], now: Date.parse("2026-09-27T12:00:00Z"), sinceDay: null, turnsLog: logs("turns"), chunksLog: logs("chunks"), sessionsLog: logs("sessions"), activitiesLog: logs("notes") });
// Two 10-minute receipts overlapping by 5 minutes reconcile to 15 minutes, not the naive 25.
assert.match(report.summary, /0\\.25 h/);
assert.doesNotMatch(report.summary, /0\\.42 h/);
assert.equal(auditTurnReceipts([turn("t1", 900000)], [chunk("t1", 0, 10), chunk("t1", 5, 15)]).get("t1").status, "consistent");
console.log("packaged artifact works with no compiler: " + JSON.stringify(report.summary));
`;
  const probePath = join(workspace, "probe.mts");
  writeFileSync(probePath, probe);
  const result = run([node, "--experimental-strip-types", "--no-warnings", probePath], {
    env: { PATH: "/nonexistent", HOME: zero, XDG_STATE_HOME: zero, XDG_CACHE_HOME: zero },
  });
  check(result.exitCode === 0, `packaged probe failed under ${nodeVersion}: ${text(result).slice(-1200)}`);
  process.stdout.write(text(result));
  // An explicit prebuilt-binary override must select the native lane, not silently fall back.
  const nativeOnly = run([node, "--experimental-strip-types", "--no-warnings", "-e", `import(${JSON.stringify(join(pkg, "native.ts"))}).then((m) => m.reconcileIntervals([[{ start: 0, end: 10 }]]));`], {
    env: { PATH: "/nonexistent", HOME: zero, WORKTIME_BEND_BINARY: join(zero, "missing-binary") },
  });
  check(nativeOnly.exitCode !== 0 && text(nativeOnly).includes("Bend reconciliation failed"), "WORKTIME_BEND_BINARY must select the native lane instead of falling back");
  if (failures.length) {
    console.error(`\nPackaged artifact is not installable (${failures.length} problem${failures.length === 1 ? "" : "s"}):`);
    for (const message of failures) console.error(` - ${message}`);
    process.exit(1);
  }
  console.log(`Packaged artifact OK on ${nodeVersion} (floor ${floor}): compiled-free policy, receipts and report verified with no Bend, Clang or Bun.`);
} finally { rmSync(workspace, { recursive: true, force: true }); }
