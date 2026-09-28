import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test.each([
  ["valid", 0, "Package payload OK"],
  ["private", 1, "private and cannot be published"],
  ["no-license", 1, "LICENSE file are required"],
  ["excluded-entry", 1, "missing from the package payload"],
  ["no-bend", 1, "engine.bend must ship"],
] as const)("package gate: %s", (scenario, status, message) => {
  const root = mkdtempSync(join(tmpdir(), "pi-package-check-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(import.meta.dir, "scripts/check-package.mjs"), join(root, "scripts/check-package.mjs"));
    const manifest = {
      private: scenario === "private",
      license: "MIT",
      files: scenario === "no-bend" ? ["*.ts"] : ["*.ts", "*.bend"],
      pi: { extensions: [scenario === "excluded-entry" ? "./scripts/adapter.ts" : "./index.ts"] },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    for (const file of ["index.ts", "engine.bend", "audit.bend", "scripts/adapter.ts"]) {
      writeFileSync(join(root, file), "");
    }
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
