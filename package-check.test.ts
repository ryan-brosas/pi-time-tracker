import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const baseline = ["*.ts", "!*.test.ts", "*.bend", "!LAWS.bend", "!PROOF.bend", "generated/policy.mjs", "generated/policy.d.mts", "THIRD_PARTY_NOTICES.md"];

test.each([
  ["valid", 0, "Package payload OK"],
  ["private", 1, "private and cannot be published"],
  ["no-license", 1, "LICENSE file are required"],
  ["excluded-entry", 1, "missing from the package payload"],
  ["no-bend", 1, "engine.bend must ship"],
  ["missing-batch", 1, "batch.bend must ship"],
  ["no-generated", 1, "generated/policy.mjs must ship"],
  ["missing-notices", 1, "THIRD_PARTY_NOTICES.md must ship"],
  ["shipped-proof", 1, "proof file must not ship"],
  ["shipped-script", 1, "build tooling must not ship"],
  ["missing-import", 1, "imports ./missing.ts, which the payload does not ship"],
] as const)("package gate: %s", (scenario, status, message) => {
  const root = mkdtempSync(join(tmpdir(), "pi-package-check-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "generated"));
    copyFileSync(join(import.meta.dir, "scripts/check-package.mjs"), join(root, "scripts/check-package.mjs"));
    const files = scenario === "no-bend" ? ["*.ts", "generated/policy.mjs", "generated/policy.d.mts"]
      : scenario === "no-generated" ? ["*.ts", "!*.test.ts", "*.bend", "!LAWS.bend", "!PROOF.bend"]
      : scenario === "shipped-proof" ? [...baseline.filter(p => p !== "!PROOF.bend"), "PROOF.bend"]
      : scenario === "shipped-script" ? [...baseline, "scripts/*.ts"]
      : baseline;
    const manifest = { private: scenario === "private", license: "MIT", files, pi: { extensions: [scenario === "excluded-entry" ? "./scripts/adapter.ts" : "./index.ts"] } };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "index.ts"), scenario === "missing-import" ? 'import { value } from "./missing.ts";\n' : "");
    writeFileSync(join(root, "engine.bend"), "import ./batch.bend as Batch\n");
    for (const file of ["audit.bend", "LAWS.bend"]) writeFileSync(join(root, file), "");
    if (scenario !== "missing-batch") writeFileSync(join(root, "batch.bend"), "");
    writeFileSync(join(root, "generated", "policy.mjs"), "");
    writeFileSync(join(root, "generated", "policy.d.mts"), "");
    if (scenario !== "missing-notices") writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "Third-party notices\n");
    if (scenario !== "no-generated") writeFileSync(join(root, "scripts", "adapter.ts"), "");
    if (scenario === "shipped-script") writeFileSync(join(root, "scripts", "extra.ts"), "");
    if (scenario === "shipped-proof") writeFileSync(join(root, "PROOF.bend"), "");
    if (scenario !== "no-license") writeFileSync(join(root, "LICENSE"), "MIT License\n");
    // The checker uses Bun globs, so spawn the project's own runtime.
    const result = spawnSync("bun", [join(root, "scripts/check-package.mjs")], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toContain(message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
