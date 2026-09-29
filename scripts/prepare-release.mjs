#!/usr/bin/env bun
// Decides whether a main push should release and which version it ships. Read-only:
// it never edits the checkout, creates a tag, publishes, or writes to the registry.
// The publish job stamps the planned version and source commit into the tarball only,
// so a release never needs a version commit back to main.
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import semver from "semver";

const fail = (message) => {
  console.error(`prepare-release: ${message}`);
  process.exit(1);
};

const run = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) fail(`could not run git ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
};

// Exit 0 and 1 are answers; anything else is an infrastructure failure that must not
// be read as "not an ancestor", which would publish a superseded commit.
const isAncestor = (ancestor, descendant) => {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8" });
  if (result.error) fail(`could not run git merge-base: ${result.error.message}`);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
};

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = manifest.name;
if (typeof name !== "string" || name.length === 0) fail("package.json has no usable name");

const sourceVersion = manifest.version;
if (typeof sourceVersion !== "string" || sourceVersion.length === 0) fail("package.json has no usable version");
// Checked before the canonical pass so the reason names the actual problem.
if (sourceVersion.includes("+")) fail(`package.json version ${sourceVersion} carries build metadata, which npm cannot publish as a release version`);
if (semver.valid(sourceVersion) === null || semver.clean(sourceVersion) !== sourceVersion) {
  fail(`package.json version ${JSON.stringify(sourceVersion)} is not a canonical SemVer release`);
}

const head = run(["rev-parse", "HEAD^{commit}"]);
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
  fail(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match the checked-out HEAD ${head}`);
}

const registry = (process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
}).catch((error) => fail(`could not read ${registry}/${name}: ${error?.message ?? error}`));

// A 404 packument means the package was never published. Every other failure is
// ambiguous between "absent" and "unavailable", and must not be treated as absent.
const published = new Map();
if (response.status === 404) {
  console.log(`${name} has no published versions yet`);
} else if (!response.ok) {
  fail(`${registry}/${name} returned HTTP ${response.status}; refusing to plan a release against unusable registry state`);
} else {
  const packument = await response.json().catch((error) => fail(`registry metadata is not valid JSON: ${error?.message ?? error}`));
  if (packument === null || typeof packument !== "object" || Array.isArray(packument)) fail("registry metadata is not a package document");
  if (packument.versions === undefined) fail("registry metadata has no versions map");
  if (packument.versions === null || typeof packument.versions !== "object" || Array.isArray(packument.versions)) fail("registry versions is not a map");
  for (const [version, entry] of Object.entries(packument.versions)) {
    if (semver.valid(version) === null || semver.clean(version) !== version) fail(`registry lists a non-canonical version ${JSON.stringify(version)}`);
    const gitHead = entry !== null && typeof entry === "object" ? entry.gitHead : undefined;
    if (gitHead !== undefined && typeof gitHead !== "string") fail(`registry metadata for ${version} has a non-string gitHead`);
    published.set(version, gitHead);
  }
}

// Published versions and Git tags are both release truth: npm can still be processing
// a version whose GitHub release already exists, and a tag reserves a version whose
// registry write has not become readable yet.
const tagCommits = new Map();
for (const tag of run(["tag", "--list"]).split("\n")) {
  if (!tag.startsWith("v")) continue;
  const version = tag.slice(1);
  if (semver.valid(version) === null || semver.clean(version) !== version) continue;
  tagCommits.set(version, run(["rev-parse", `refs/tags/${tag}^{commit}`]));
}

const known = new Set([...published.keys(), ...tagCommits.keys()]);
const write = (release, version, reason) => {
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\nversion=${version}\n`);
  // Outputs were delivered; nothing else this step could add.
  process.exit(0);
};

const alreadyTagged = [...tagCommits.entries()].filter(([, commit]) => commit === head).map(([version]) => version);
if (alreadyTagged.length > 0) write(false, "", `${head.slice(0, 12)} is already released as v${alreadyTagged.sort(semver.rcompare)[0]}; nothing to publish`);

if (known.size === 0) {
  // First publication: the declared source version is the release version.
  write(true, sourceVersion, `no published release yet; releasing declared version ${sourceVersion}`);
}

const highest = [...known].sort(semver.rcompare)[0];
const highestTagCommit = tagCommits.get(highest);
const highestGitHead = published.get(highest);
if (!highestTagCommit) {
  if (highestGitHead === head) {
    fail(`${name}@${highest} is published for ${head.slice(0, 12)} but tag v${highest} is missing; republish nothing. Re-run only the failed release job with the retained artifact, or finish the release from the draft, then retag the published version`);
  }
  fail(`${name}@${highest} exists without tag v${highest}; a partially completed release would be republished. Repair or retag the published version first`);
}
if (highestGitHead === head && highestTagCommit !== head) {
  fail(`${name}@${highest} was published from ${head.slice(0, 12)} but v${highest} points to ${highestTagCommit.slice(0, 12)}; republish nothing and reconcile the published version with its tag`);
}

const previous = highestTagCommit;
if (previous !== head) {
  if (isAncestor(previous, head)) {
    console.log(`previous release v${highest} (${previous.slice(0, 12)}) is an ancestor of ${head.slice(0, 12)}`);
  } else if (isAncestor(head, previous)) {
    write(false, "", `${head.slice(0, 12)} is older than the published v${highest} (${previous.slice(0, 12)}); skipping this superseded run`);
  } else {
    fail(`${head.slice(0, 12)} and the published v${highest} (${previous.slice(0, 12)}) have diverged; refusing to publish an unrelated history`);
  }
}

// A declared version newer than every known release is maintainer intent: publish it
// as declared, whether that promotes a prerelease to stable or skips the patch series.
if ([...known].every((version) => semver.lt(version, sourceVersion))) {
  write(true, sourceVersion, `releasing declared version ${sourceVersion} from ${head.slice(0, 12)} (previous release v${highest})`);
}

const stable = [...known].filter((version) => semver.prerelease(version) === null).sort(semver.rcompare);
const highestStable = stable[0];
const sourcePrerelease = semver.prerelease(sourceVersion);

if (sourcePrerelease === null) {
  // An explicit newer version in package.json is maintainer intent for a minor or
  // major release; otherwise the next patch is generated automatically.
  const next = highestStable !== undefined && !semver.gt(sourceVersion, highestStable)
    ? semver.inc(highestStable, "patch")
    : sourceVersion;
  if (next === null) fail(`could not raise ${sourceVersion} to the next patch release`);
  write(true, next, `releasing ${next} from ${head.slice(0, 12)} (previous release v${highest})`);
}

// Prereleases stay on the `next` dist-tag. A prerelease of an already-stable base
// would sort below that stable release, so it needs an explicit newer declaration.
const base = `${semver.major(sourceVersion)}.${semver.minor(sourceVersion)}.${semver.patch(sourceVersion)}`;
const stableAtOrAbove = stable.find((version) => semver.gte(version, base));
if (stableAtOrAbove) fail(`${sourceVersion} is a prerelease of published stable ${stableAtOrAbove}; declare a higher version instead of publishing a downgrade`);
const sameBase = [...known]
  .filter((version) => semver.prerelease(version) !== null && `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}` === base)
  .sort(semver.rcompare);
const channel = typeof sourcePrerelease[0] === "string" ? sourcePrerelease[0] : "rc";
const next = semver.inc(sameBase[0] ?? sourceVersion, "prerelease", channel);
if (next === null) fail(`could not raise ${sameBase[0] ?? sourceVersion} to the next ${channel} prerelease`);
write(true, next, `releasing prerelease ${next} from ${head.slice(0, 12)}`);
