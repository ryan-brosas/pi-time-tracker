import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The planner is release truth: it decides whether a main push publishes and which
// version ships. These fixtures run the real CLI against disposable Git history and a
// loopback registry so every branch is deterministic (Bun.spawn, not spawnSync, because
// the registry fixture is served by this same event loop).
const planner = join(import.meta.dir, "scripts", "prepare-release.mjs");

const gitIn = (dir: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Release Planner", "-c", "user.email=planner@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.status}`);
  return result.stdout.trim();
};

type Fixture = { dir: string; commits: string[]; head: string; output: string };

const makeFixture = (options: { version: string; commits?: number; tags?: Array<{ version: string; at?: number | "head" }> }): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "pi-release-plan-"));
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-pkg", version: options.version }, null, 2));
  gitIn(dir, "add", "package.json");
  gitIn(dir, "commit", "-qm", "base");
  const commits = [gitIn(dir, "rev-parse", "HEAD")];
  for (let i = 1; i < (options.commits ?? 2); i++) {
    gitIn(dir, "commit", "--allow-empty", "-qm", `change ${i}`);
    commits.push(gitIn(dir, "rev-parse", "HEAD"));
  }
  for (const tag of options.tags ?? []) gitIn(dir, "tag", `v${tag.version}`, tag.at === "head" || tag.at === undefined ? commits.at(-1)! : commits[tag.at]);
  return { dir, commits, head: gitIn(dir, "rev-parse", "HEAD"), output: join(dir, "github-output.txt") };
};

const packument = (versions: Record<string, { gitHead?: "head" | "previous" } | null>) => ({ name: "fixture-pkg", versions });
type RegistrySpec = { status: number; body?: unknown } | { unreachable: true };

const verifyUnchanged = (fixture: Fixture, before: string) => {
  expect(readFileSync(join(fixture.dir, "package.json"), "utf8")).toBe(before);
  expect(gitIn(fixture.dir, "status", "--porcelain", "--", "package.json")).toBe("");
};

type RunOptions = { registry: RegistrySpec; githubSha?: string; detachTo?: number };

const launch = async (fixture: Fixture, options: RunOptions) => {
  const before = readFileSync(join(fixture.dir, "package.json"), "utf8");
  if (options.detachTo !== undefined) gitIn(fixture.dir, "checkout", "-q", fixture.commits[options.detachTo]);
  const head = gitIn(fixture.dir, "rev-parse", "HEAD");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let registry: string;
  if ("unreachable" in options.registry) {
    registry = "http://127.0.0.1:1";
  } else {
    const spec = options.registry;
    const resolve = (value: unknown): unknown => {
      if (typeof value === "string" && (value === "head" || value === "previous")) return value === "head" ? fixture.head : fixture.commits[0];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
      }
      return value;
    };
    server = Bun.serve({ port: 0, fetch: () => new Response(spec.body === undefined ? "" : typeof spec.body === "string" ? spec.body : JSON.stringify(resolve(spec.body)), { status: spec.status }) });
    registry = `http://127.0.0.1:${server.port}`;
  }
  try {
    const proc = Bun.spawn([process.execPath, planner], {
      cwd: fixture.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NPM_CONFIG_REGISTRY: registry, GITHUB_OUTPUT: fixture.output, GITHUB_SHA: options.githubSha ?? head },
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const outputs = existsSync(fixture.output) ? readFileSync(fixture.output, "utf8") : "";
    verifyUnchanged(fixture, before);
    return {
      exitCode,
      stdout,
      stderr,
      release: outputs.match(/^release=(.*)$/m)?.[1] ?? "",
      version: outputs.match(/^version=(.*)$/m)?.[1] ?? "",
      message: `${stdout}${stderr}`,
    };
  } finally {
    server?.stop(true);
  }
};

type Case = {
  name: string;
  version?: string;
  commits?: number;
  tags?: Array<{ version: string; at?: number | "head" }>;
  registry: RegistrySpec;
  githubSha?: "mismatch";
  detachTo?: number;
  exitCode: number;
  release?: string;
  plannedVersion?: string;
  message?: string;
};

const cases: Case[] = [
  { name: "releases the declared version on a first publication", version: "0.2.0", registry: { status: 404 }, exitCode: 0, release: "true", plannedVersion: "0.2.0" },
  { name: "generates the next patch from the published release", version: "0.2.0", tags: [{ version: "0.2.0", at: 0 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" } }) }, exitCode: 0, release: "true", plannedVersion: "0.2.1" },
  { name: "keeps patching while the declared baseline is unchanged", version: "0.2.0", commits: 3, tags: [{ version: "0.2.0", at: 0 }, { version: "0.2.1", at: 1 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" }, "0.2.1": null }) }, exitCode: 0, release: "true", plannedVersion: "0.2.2" },
  { name: "releases an explicitly declared minor version", version: "0.3.0", tags: [{ version: "0.2.7", at: 0 }], registry: { status: 200, body: packument({ "0.2.7": { gitHead: "previous" } }) }, exitCode: 0, release: "true", plannedVersion: "0.3.0" },
  { name: "releases an explicitly declared major version", version: "1.0.0", tags: [{ version: "0.9.4", at: 0 }], registry: { status: 200, body: packument({ "0.9.4": { gitHead: "previous" } }) }, exitCode: 0, release: "true", plannedVersion: "1.0.0" },
  { name: "skips a commit that is already released", version: "0.2.0", tags: [{ version: "0.2.0" }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "head" } }) }, exitCode: 0, release: "false", plannedVersion: "", message: "already released" },
  { name: "skips a superseded run for an older commit", version: "0.2.0", tags: [{ version: "0.2.0" }], detachTo: 0, registry: { status: 200, body: packument({ "0.2.0": { gitHead: "head" } }) }, exitCode: 0, release: "false", plannedVersion: "", message: "older than the published" },
  { name: "reserves versions from tags the registry has not caught up with", version: "0.2.0", commits: 3, tags: [{ version: "0.2.0", at: 0 }, { version: "0.2.1", at: 1 }], registry: { status: 200, body: packument({ "0.2.0": null }) }, exitCode: 0, release: "true", plannedVersion: "0.2.2" },
  { name: "publishes a declared prerelease as the next channel", version: "0.3.0-rc.1", tags: [{ version: "0.2.0", at: 0 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" } }) }, exitCode: 0, release: "true", plannedVersion: "0.3.0-rc.1" },
  { name: "increments an existing prerelease series", version: "0.3.0-rc.1", commits: 3, tags: [{ version: "0.2.0", at: 0 }, { version: "0.3.0-rc.1", at: 1 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" }, "0.3.0-rc.1": null }) }, exitCode: 0, release: "true", plannedVersion: "0.3.0-rc.2" },
  { name: "promotes a stable version over its prereleases", version: "0.3.0", commits: 3, tags: [{ version: "0.2.0", at: 0 }, { version: "0.3.0-rc.1", at: 1 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" }, "0.3.0-rc.1": null }) }, exitCode: 0, release: "true", plannedVersion: "0.3.0" },
  { name: "refuses a prerelease below a published stable", version: "0.2.0-rc.1", tags: [{ version: "0.2.0", at: 0 }], registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" } }) }, exitCode: 1, message: "prerelease of published stable" },
  { name: "refuses a published version without its tag", version: "0.2.0", registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" } }) }, exitCode: 1, message: "without tag v0.2.0" },
  { name: "refuses a published commit whose release is missing", version: "0.2.0", registry: { status: 200, body: packument({ "0.2.0": { gitHead: "head" } }) }, exitCode: 1, message: "tag v0.2.0 is missing" },
  { name: "fails closed on a registry server error", version: "0.2.0", registry: { status: 500 }, exitCode: 1, message: "HTTP 500" },
  { name: "fails closed on a registry authorization error", version: "0.2.0", registry: { status: 401 }, exitCode: 1, message: "HTTP 401" },
  { name: "fails closed on unreadable registry metadata", version: "0.2.0", registry: { status: 200, body: "not json" }, exitCode: 1, message: "not valid JSON" },
  { name: "fails closed on a malformed versions map", version: "0.2.0", registry: { status: 200, body: { name: "fixture-pkg", versions: "nope" } }, exitCode: 1, message: "versions is not a map" },
  { name: "fails closed on a non-canonical published version", version: "0.2.0", registry: { status: 200, body: packument({ "0.2": { gitHead: "head" } }) }, exitCode: 1, message: "non-canonical version" },
  { name: "fails closed when the registry is unreachable", version: "0.2.0", registry: { unreachable: true }, exitCode: 1, message: "could not read" },
  { name: "rejects a declared version that is not canonical SemVer", version: "1.2", registry: { status: 404 }, exitCode: 1, message: "canonical SemVer" },
  { name: "rejects a declared version with build metadata", version: "0.2.0+build.1", registry: { status: 404 }, exitCode: 1, message: "build metadata" },
  { name: "rejects a checked-out commit that disagrees with the event", version: "0.2.0", registry: { status: 404 }, githubSha: "mismatch", exitCode: 1, message: "does not match the checked-out HEAD" },
];

for (const spec of cases) {
  test(`release planner: ${spec.name}`, async () => {
    const fixture = makeFixture({ version: spec.version ?? "0.2.0", commits: spec.commits, tags: spec.tags });
    try {
      const result = await launch(fixture, {
        registry: spec.registry,
        githubSha: spec.githubSha === "mismatch" ? "0".repeat(40) : undefined,
        detachTo: spec.detachTo,
      });
      expect(result.exitCode, result.message).toBe(spec.exitCode);
      if (spec.exitCode === 0) {
        expect(result.release).toBe(spec.release ?? "");
        expect(result.version).toBe(spec.plannedVersion ?? "");
      } else {
        expect(result.release).toBe("");
        expect(result.version).toBe("");
      }
      if (spec.message) expect(result.message).toContain(spec.message);
    } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
  });
}

test("release planner: refuses an unrelated history instead of publishing it", async () => {
  const fixture = makeFixture({ version: "0.2.0", tags: [{ version: "0.2.0" }] });
  try {
    gitIn(fixture.dir, "checkout", "-q", "--orphan", "unrelated");
    gitIn(fixture.dir, "commit", "--allow-empty", "-qm", "unrelated root");
    const result = await launch(fixture, { registry: { status: 200, body: packument({ "0.2.0": { gitHead: "previous" } }) } });
    expect(result.exitCode, result.message).toBe(1);
    expect(result.message).toContain("diverged");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});
