import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = import.meta.dir;

test("pack:test rejects a missing supplied artifact instead of repacking the checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-release-pack-"));
  try {
    const result = spawnSync(process.execPath, [join(root, "scripts/pack-test.mjs"), join(dir, "missing.tgz")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("supplied tarball does not exist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release pack step publishes the filename npm actually produced", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/npm-publish.yml"), "utf8")) as any;
  const pack = workflow.jobs.publish.steps.find((step: any) => step.id === "pack");
  const dir = mkdtempSync(join(tmpdir(), "pi-pack-step-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "renamed-package", version: "1.2.3", files: ["*"] }));
    writeFileSync(join(dir, "index.js"), "");
    const runnerTemp = join(dir, "runner-temp"), output = join(dir, "github-output.txt");
    mkdirSync(runnerTemp);
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", pack.run], { cwd: dir, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output } });
    expect(result.status, result.stderr).toBe(0);
    const tarball = readFileSync(output, "utf8").match(/^tarball=(.+)$/m)?.[1];
    expect(tarball).toBe("renamed-package-1.2.3.tgz");
    expect(existsSync(join(runnerTemp, tarball!))).toBe(true);
    expect(tarball).not.toContain("pi-time-tracker");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release stamp step writes the generated version and source commit", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/npm-publish.yml"), "utf8")) as any;
  const stamp = workflow.jobs.publish.steps.find((step: any) => step.name === "Stamp the release version and source commit");
  const serialized = JSON.stringify(workflow);
  // Generated versions must never be pushed back to main, and publishing stays on
  // OIDC: a repository token or npm auth secret here would be a legacy pattern.
  expect(serialized).not.toContain("git push");
  expect(serialized).not.toContain("NPM_TOKEN");
  expect(serialized).not.toContain("NODE_AUTH_TOKEN");
  const dir = mkdtempSync(join(tmpdir(), "pi-stamp-step-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-pkg", version: "0.2.0" }, null, 2));
    const sha = "a".repeat(40);
    const result = spawnSync("bash", ["-c", stamp.run], { cwd: dir, encoding: "utf8", env: { ...process.env, RELEASE_VERSION: "0.2.1", GITHUB_SHA: sha } });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(manifest.version).toBe("0.2.1");
    expect(manifest.gitHead).toBe(sha);
    expect(manifest.name).toBe("fixture-pkg");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release workflow automatically versions main pushes and promotes one verified artifact", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/npm-publish.yml"), "utf8")) as any;
  expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  expect(workflow.concurrency.queue).toBe("max");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const { plan, publish, release } = workflow.jobs;
  expect(plan.if).toBe("github.ref == 'refs/heads/main'");
  expect(plan.outputs.version).toBe("${{ steps.version.outputs.version }}");
  expect(plan.outputs.release).toBe("${{ steps.version.outputs.release }}");
  expect(plan.steps.find((step: any) => step.id === "version").run).toBe("bun scripts/prepare-release.mjs");
  expect(plan.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"]).toBe(0);
  expect(publish.needs).toBe("plan");
  expect(publish.if).toBe("needs.plan.outputs.release == 'true'");
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
  const stamp = steps.findIndex((step: any) => step.name === "Stamp the release version and source commit");
  const duplicate = steps.findIndex((step: any) => step.name === "Reject duplicate npm version");
  expect(stamp).toBeGreaterThan(-1);
  expect(duplicate).toBeGreaterThan(stamp);
  expect(pack).toBeGreaterThan(duplicate);
  expect(steps[stamp].env.RELEASE_VERSION).toBe("${{ needs.plan.outputs.version }}");
  expect(steps[stamp].run).toContain('npm pkg set "version=$RELEASE_VERSION" "gitHead=$GITHUB_SHA"');
  const nodeSteps = steps.map((step: any, index: number) => ({ step, index })).filter(({ step }: any) => step.uses?.startsWith("actions/setup-node@"));
  expect(nodeSteps).toHaveLength(2);
  expect(nodeSteps[0].step.with["node-version"]).toBe("22.19.0");
  expect(nodeSteps[0].index).toBeLessThan(probe);
  expect(nodeSteps[1].step.with["node-version"]).toBe("24");
  expect(nodeSteps[1].index).toBeGreaterThan(probe);
  expect(nodeSteps[1].index).toBeLessThan(publishIndex);
  const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as any;
  for (const step of ci.jobs.quality.steps.filter((step: any) => step.run?.startsWith("bun run ") && step.run !== "bun run pack:test")) {
    expect(steps.some((releaseStep: any) => releaseStep.run === step.run)).toBe(true);
  }
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
  // github-release.sh peels the tag with git ls-remote, so the job must have a
  // checkout whose origin is the release repository before it runs.
  const checkoutIndex = release.steps.findIndex((step: any) => step.uses?.startsWith("actions/checkout@"));
  expect(checkoutIndex).toBeGreaterThanOrEqual(0);
  expect(checkoutIndex).toBeLessThan(release.steps.indexOf(cut));
  expect(cut.env.RELEASE_VERSION).toBe("${{ needs.publish.outputs.version }}");
  expect(cut.env.RELEASE_TARBALL).toBe("${{ runner.temp }}/release/${{ needs.publish.outputs.tarball }}");
  for (const job of [plan, publish, release]) {
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
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$RELEASE_CALLS"\nexit "${GH_EXIT_CODE:-0}"\n');
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
