import { beforeAll, afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const script = join(root, "scripts/pack-test.mjs");
let fixture: string;
const command = (args: string[]) => {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
};
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "pi-pack-fixture-"));
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture], { cwd: root, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr);
  command(["tar", "-xzf", join(fixture, JSON.parse(packed.stdout)[0].filename), "-C", fixture]);
});
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const expectFailure = (result: ReturnType<typeof spawnSync>, message: string) => {
  const output = String(result.stdout) + String(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(output).toContain("Packaged artifact is not installable");
  expect(output).toContain(message);
  expect(output).not.toContain("Packaged artifact OK");
  expect(output).not.toContain("ENOENT");
};

test.each(["missing", "non-executable", "version-failed", "invalid-version", "old-version"])("pack:test rejects %s Node before creating a workspace", (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pack-node-"));
  try {
    const node = join(dir, "node");
    if (scenario !== "missing") {
      writeFileSync(node, scenario === "version-failed" ? "#!/bin/sh\necho v99.0.0\nexit 7\n" : `#!/bin/sh\necho ${scenario === "invalid-version" ? "not-node" : "v22.18.0"}\n`);
      chmodSync(node, scenario === "non-executable" ? 0o644 : 0o755);
    }
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, WORKTIME_NODE: node, TMPDIR: dir } });
    expectFailure(result, scenario === "old-version" ? "Node 22.19.0+ is required" : scenario === "missing" || scenario === "non-executable" ? "no Node binary found" : "could not read a valid Node version");
    expect(readdirSync(dir).filter(name => name.startsWith("pi-worktime-pack-"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each([
  ["generated", "the tarball is missing generated/"],
  ["generated/policy.mjs", "the tarball is missing generated/policy.mjs"],
  ["THIRD_PARTY_NOTICES.md", "the tarball is missing THIRD_PARTY_NOTICES.md"],
  ["ledger.ts", "the tarball is missing ledger.ts"],
  ["empty-ledger", "the tarball file is empty or not a regular file: ledger.ts"],
  ["empty-forbidden", "the tarball must not ship tsconfig.json"],
  ["empty-build-script", "the tarball must not ship build tooling"],
  ["different-version", "the tarball name/version differs from package.json"],
] as const)("pack:test reports %s and cleans its workspace", (scenario, message) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pack-invalid-"));
  try {
    const pkg = join(dir, "package");
    cpSync(join(fixture, "package"), pkg, { recursive: true });
    if (scenario === "empty-ledger") writeFileSync(join(pkg, "ledger.ts"), "");
    else if (scenario === "empty-forbidden") writeFileSync(join(pkg, "tsconfig.json"), "");
    else if (scenario === "empty-build-script") {
      mkdirSync(join(pkg, "scripts"));
      writeFileSync(join(pkg, "scripts/build-bend.mjs"), "");
    } else if (scenario === "different-version") {
      const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: "9.9.9" }));
    } else rmSync(join(pkg, scenario), { recursive: true });
    const tarball = join(dir, "broken.tgz");
    command(["tar", "-czf", tarball, "-C", dir, "package"]);
    const result = spawnSync(process.execPath, [script, tarball], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } });
    expectFailure(result, message);
    expect(readdirSync(dir).filter(name => name.startsWith("pi-worktime-pack-"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
