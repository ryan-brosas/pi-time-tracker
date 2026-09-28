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

for (const required of ["index.ts", "engine.bend", "audit.bend"]) {
  if (!shipped.has(required)) fail(`${required} must ship in the package payload`);
}

for (const file of shipped) {
  if (/\.test\.ts$/.test(file)) fail(`test file must not ship: ${file}`);
  if (file.startsWith(".github/")) fail(`repository automation must not ship: ${file}`);
  if (file === "bun.lock" || file.startsWith("tsconfig")) fail(`development-only file must not ship: ${file}`);
  if (!/\.(ts|bend|json|md)$/.test(file)) fail(`unexpected file type in payload: ${file}`);
}

// Every local import inside shipped TypeScript must itself be shipped, or Pi fails to load the package.
for (const file of [...shipped].filter(f => f.endsWith(".ts"))) {
  const source = readFileSync(join(root, file), "utf8");
  for (const [, specifier] of source.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
    const resolved = normalize(join(dirname(file), specifier));
    if (!shipped.has(resolved) && !shipped.has(`${resolved}.ts`) && !shipped.has(`${resolved}/index.ts`)) {
      fail(`${file} imports ${specifier}, which the payload does not ship`);
    }
  }
}

// Runtime state must never be baked into the package.
const payloadFiles = [...shipped].sort();
if (process.env.DEBUG) console.log(payloadFiles.join("\n"));

if (failures.length) {
  console.error(`Package payload is not distributable (${failures.length} problem${failures.length === 1 ? "" : "s"}):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}
console.log(`Package payload OK: ${payloadFiles.length} files, entries ${(entries ?? []).join(", ")}`);
