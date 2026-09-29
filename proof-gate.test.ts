import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bendEnv, resolveBendExecutable } from "./scripts/bend-toolchain.mjs";

/** Copied policy files, so a broken variant never touches the repository. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktime-proof-"));
  for (const file of ["engine.bend", "audit.bend", "batch.bend", "LAWS.bend", "PROOF.bend"]) copyFileSync(join(import.meta.dir, file), join(dir, file));
  return dir;
}
const prove = (dir: string) => Bun.spawnSync([resolveBendExecutable(), "PROOF.bend"], { cwd: dir, env: bendEnv });
const output = (result: Bun.SyncSubprocess) => (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

test("every stated audit law is proven on the pinned compiler", () => {
  const dir = fixture();
  try {
    const result = prove(dir);
    expect(output(result)).toContain("All terms check.");
    expect(result.exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a broken conflict implementation fails its law, not the syntax", () => {
  const dir = fixture();
  try {
    expect(prove(dir).exitCode).toBe(0);
    const audit = readFileSync(join(dir, "audit.bend"), "utf8");
    writeFileSync(join(dir, "audit.bend"), audit.replace("    case True{}:\n      5n", "    case True{}:\n      0n"));
    const broken = prove(dir);
    expect(broken.exitCode).not.toBe(0);
    expect(output(broken)).toContain("conflict_wins");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a law without its proof is an open claim the gate rejects", () => {
  const dir = fixture();
  try {
    const proof = readFileSync(join(dir, "PROOF.bend"), "utf8");
    writeFileSync(join(dir, "PROOF.bend"), proof.replace(/def Laws\.checkpoint_only\(intervals, total, expected, modern\):\n  \{==\}\n/, ""));
    const missing = prove(dir);
    expect(missing.exitCode).not.toBe(0);
    // An unproven law is reported as an open claim, never as a syntax or tool error.
    expect(output(missing)).toContain("TODO found");
    expect(output(missing)).not.toContain("All terms check.");
    writeFileSync(join(dir, "PROOF.bend"), proof);
    expect(prove(dir).exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
