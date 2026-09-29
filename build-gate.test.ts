import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bendEnv, resolveBendExecutable, resolveBendSource } from "./scripts/bend-toolchain.mjs";

/** An isolated copy of the build inputs, so drift checks never rewrite the repository. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktime-build-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["engine.bend", "audit.bend", "batch.bend"]) copyFileSync(join(import.meta.dir, file), join(dir, file));
  for (const file of ["build-bend.mjs", "bend-toolchain.mjs", "bend-toolchain.json", "bend-entry.ts"]) copyFileSync(join(import.meta.dir, "scripts", file), join(dir, "scripts", file));
  cpSync(join(import.meta.dir, "generated"), join(dir, "generated"), { recursive: true });
  return dir;
}
// The emitter ships only inside the pinned toolchain; say so instead of passing vacuously.
const buildToolchain = (() => {
  try { return { bend: resolveBendExecutable(), source: resolveBendSource() }; } catch { return null; }
})();
const requiresToolchain = buildToolchain === null
  ? "the pinned Bend build toolchain is not installed (run scripts/install-bend-ci.sh or set BEND_SOURCE_DIR)"
  : null;

const check = (dir: string) => Bun.spawnSync(["bun", "scripts/build-bend.mjs", "--check"], {
  cwd: dir,
  env: { ...bendEnv, BEND_EXECUTABLE: buildToolchain?.bend, BEND_SOURCE_DIR: buildToolchain?.source },
});

// The real artifact must already match its sources; a hand edit or a skipped rebuild fails CI.
test.skipIf(buildToolchain === null)(requiresToolchain ?? "the committed generated policy matches its Bend sources", () => {
  const result = check(import.meta.dir);
  expect(result.stdout.toString() + result.stderr.toString()).toContain("generated policy is current");
  expect(result.exitCode).toBe(0);
}, 120_000);

test.skipIf(buildToolchain === null)(requiresToolchain ?? "drifted or missing generated policy fails the build gate", () => {
  const dir = fixture();
  try {
    expect(check(dir).exitCode).toBe(0);
    appendFileSync(join(dir, "generated", "policy.mjs"), "\n// hand edit\n");
    const drifted = check(dir);
    expect(drifted.exitCode).not.toBe(0);
    expect(drifted.stderr.toString()).toContain("missing or stale");
    rmSync(join(dir, "generated", "policy.mjs"));
    const missing = check(dir);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("missing or stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
