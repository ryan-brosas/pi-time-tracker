#!/usr/bin/env bun
// Validates the shippable Pi package payload without network or npm access.
// Install command: bun run pack:check
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);

if (manifest.private) fail("package.json is private and cannot be published to npm");
if (manifest.license !== "MIT" || !existsSync(join(root, "LICENSE"))) fail("MIT license metadata and LICENSE file are required");

const patterns = manifest.files;
if (!Array.isArray(patterns) || !patterns.length) fail("package.json needs a non-empty files whitelist to keep the tarball small");

/** Minimal npm semantics for the simple patterns this package uses. */
const select = (list) => {
  const negated = list.filter(p => p.startsWith("!")).map(p => p.slice(1));
  const matched = new Set();
  for (const pattern of list.filter(p => !p.startsWith("!"))) {
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: root, dot: false, onlyFiles: true })) matched.add(normalize(hit));
  }
  for (const pattern of negated) {
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: root, dot: false, onlyFiles: true })) matched.delete(normalize(hit));
  }
  return matched;
};

const shipped = select(patterns ?? []);
if (!shipped.size) fail("the files whitelist matches no files");

const entries = manifest.pi?.extensions;
if (!Array.isArray(entries) || !entries.length) fail("package.json must declare pi.extensions");
for (const entry of entries ?? []) {
  if (entry.includes("..") || !entry.startsWith("./")) fail(`pi.extensions entry must be a relative ./ path: ${entry}`);
  else if (!shipped.has(normalize(entry.slice(2)))) fail(`pi.extensions entry is missing from the package payload: ${entry}`);
}

// The runtime needs every Bend source for the opt-in native lane, plus the
// generated policy that makes a compiler unnecessary by default.
const required = ["index.ts", "engine.bend", "audit.bend", "batch.bend", "generated/policy.mjs", "generated/policy.d.mts", "THIRD_PARTY_NOTICES.md"];
for (const file of required) {
  if (!shipped.has(file)) fail(`${file} must ship in the package payload`);
}

for (const file of shipped) {
  if (/\.test\.ts$/.test(file)) fail(`test file must not ship: ${file}`);
  if (file === "LAWS.bend" || file === "PROOF.bend") fail(`law or proof file must not ship: ${file}`);
  if (file.startsWith("scripts/")) fail(`build tooling must not ship: ${file}`);
  if (file.startsWith(".github/")) fail(`repository automation must not ship: ${file}`);
  if (file === "bun.lock" || file.startsWith("tsconfig")) fail(`development-only file must not ship: ${file}`);
  if (!/\.(ts|bend|mjs|d\.mts|json|md)$/.test(file)) fail(`unexpected file type in payload: ${file}`);
}

// Every local import inside shipped runtime files must itself be shipped, or Pi fails to load the package.
const runtime = [...shipped].filter(f => (f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".d.mts")) || f.endsWith(".mjs"));
for (const file of runtime) {
  const source = readFileSync(join(root, file), "utf8");
  for (const [, specifier] of source.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
    const resolved = normalize(join(dirname(file), specifier));
    // TypeScript resolution may drop an extension it can add back; Node ESM cannot,
    // so a .mjs import must name a file that actually ships.
    const found = shipped.has(resolved) || (file.endsWith(".ts") && (shipped.has(`${resolved}.ts`) || shipped.has(`${resolved}/index.ts`)));
    if (!found) fail(`${file} imports ${specifier}, which the payload does not ship`);
  }
}

// Policy modules import each other; a missing helper breaks both lanes at runtime.
for (const file of [...shipped].filter(f => f.endsWith(".bend"))) {
  const source = readFileSync(join(root, file), "utf8");
  for (const [, specifier] of source.matchAll(/^import\s+\.\/([^\s]+)\s+as\s+/gm)) {
    const resolved = normalize(join(dirname(file), specifier));
    if (!shipped.has(resolved)) fail(`${file} imports ${specifier}, which the payload does not ship`);
  }
}

if (failures.length) {
  console.error(`Package payload is not distributable (${failures.length} problem${failures.length === 1 ? "" : "s"}):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}
console.log(`Package payload OK: ${shipped.size} files, entries ${(entries ?? []).join(", ")}`);
