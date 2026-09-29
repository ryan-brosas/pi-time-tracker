import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = import.meta.dir;

test("pack:test rejects a missing supplied artifact instead of repacking the checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-release-pack-"));
  try {
    const result = spawnSync("bun", [join(root, "scripts/pack-test.mjs"), join(dir, "missing.tgz")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("supplied tarball does not exist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release workflow promotes one verified artifact only after main's manual npm publish", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/npm-publish.yml"), "utf8")) as any;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const { publish, release } = workflow.jobs;
  expect(publish.if).toBe("github.ref == 'refs/heads/main'");
  expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(release.needs).toBe("publish");
  expect(release.if).toBeUndefined(); // Default success() must not be bypassed by always().
  expect(release.permissions).toEqual({ contents: "write" });
  expect(publish.outputs.version).toBe("${{ steps.pack.outputs.version }}");
  expect(publish.outputs.tarball).toBe("${{ steps.pack.outputs.tarball }}");
  expect(publish.outputs["artifact-id"]).toBe("${{ steps.archive.outputs.artifact-id }}");
  const steps = publish.steps;
  const pack = steps.findIndex((step: any) => step.id === "pack");
  const probe = steps.findIndex((step: any) => step.run === 'bun run pack:test "$TARBALL"');
  const archive = steps.findIndex((step: any) => step.id === "archive");
  const publishIndex = steps.findIndex((step: any) => step.run?.includes("npm publish"));
  expect(pack).toBeGreaterThan(-1);
  expect(probe).toBeGreaterThan(pack);
  expect(archive).toBeGreaterThan(probe);
  expect(publishIndex).toBeGreaterThan(archive);
  expect(steps[probe].env.TARBALL).toBe("${{ runner.temp }}/${{ steps.pack.outputs.tarball }}");
  expect(steps[archive].with.path).toBe(steps[probe].env.TARBALL);
  expect(steps[archive].with["if-no-files-found"]).toBe("error");
  expect(steps[publishIndex].env.TARBALL).toBe("${{ steps.pack.outputs.tarball }}");
  expect(steps[publishIndex].run).toContain('npm publish "./$TARBALL"');
  expect(steps[publishIndex].run).toContain('--tag "$dist_tag" --provenance');
  const download = release.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download.with["artifact-ids"]).toBe("${{ needs.publish.outputs.artifact-id }}");
  expect(download.with["merge-multiple"]).toBe(true);
  expect(download.with["digest-mismatch"]).toBe("error");
  const cut = release.steps.at(-1);
  expect(cut.run).toBe("bash scripts/github-release.sh");
  expect(cut.env.RELEASE_VERSION).toBe("${{ needs.publish.outputs.version }}");
  expect(cut.env.RELEASE_TARBALL).toBe("${{ runner.temp }}/release/${{ needs.publish.outputs.tarball }}");
  for (const job of [publish, release]) {
    expect(JSON.stringify(job.env ?? {})).not.toContain("runner.");
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.run) expect(step.run).not.toContain("${{");
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
    }
  }
});

test.each([
  ["new stable release", "0.2.0", "none", 0, 0],
  ["prerelease", "0.3.0-rc.1", "none", 0, 0],
  ["matching lightweight tag", "0.2.0", "matching", 0, 0],
  ["matching annotated tag", "0.2.0", "annotated", 0, 0],
  ["conflicting tag", "0.2.0", "conflict", 0, 1],
  ["unreachable origin", "0.2.0", "unreachable", 0, 1],
  ["missing tarball", "0.2.0", "missing-artifact", 0, 1],
  ["GitHub failure", "0.2.0", "none", 7, 7],
] as const)("GitHub release: %s", (_name, version, scenario, ghStatus, status) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-github-release-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("commit", "--allow-empty", "-qm", "release fixture");
    if (scenario === "conflict") git("tag", `v${version}`);
    git("commit", "--allow-empty", "-qm", "release target");
    const sha = git("rev-parse", "HEAD");
    if (scenario === "matching") git("tag", `v${version}`);
    if (scenario === "annotated") git("tag", "-a", `v${version}`, "-m", "release fixture");
    git("remote", "add", "origin", scenario === "unreachable" ? join(dir, "absent-origin") : dir);
    const bin = join(dir, "bin"), calls = join(dir, "calls.txt"), tarball = join(dir, `pi-time-tracker-${version}.tgz`);
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELEASE_CALLS"\nexit "${GH_EXIT_CODE:-0}"\n');
    chmodSync(join(bin, "gh"), 0o755);
    if (scenario !== "missing-artifact") writeFileSync(tarball, "test fixture; no registry involved");
    const result = spawnSync("bash", [join(root, "scripts/github-release.sh")], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: "example/repo", GITHUB_SHA: sha, RELEASE_VERSION: version, RELEASE_TARBALL: tarball, RELEASE_CALLS: calls, GH_EXIT_CODE: String(ghStatus) },
    });
    if (status === 1) {
      expect(result.status).not.toBe(0);
      expect(existsSync(calls)).toBe(false);
      if (scenario === "conflict") expect(result.stderr).toContain("points to another commit");
      if (scenario === "missing-artifact") expect(result.stderr).toContain("tarball is missing");
    } else {
      expect(result.status).toBe(status);
      const args = readFileSync(calls, "utf8").trimEnd().split("\n");
      const expected = ["release", "create", `v${version}`, tarball, "--repo", "example/repo", "--target", sha, "--title", `pi-time-tracker v${version}`, "--generate-notes", "--notes", `npm package: https://www.npmjs.com/package/pi-time-tracker/v/${version}. The attached tarball is the package published to npm.`, ...(version.includes("-") ? ["--prerelease", "--latest=false"] : ["--latest"])];
      expect(args).toHaveLength(expected.length);
      expect(args).toEqual(expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
