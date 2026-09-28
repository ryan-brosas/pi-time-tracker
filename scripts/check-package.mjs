#!/usr/bin/env bun
// Validates the shippable Pi package payload without network or npm access.
// Install command: bun run pack:check
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);

if (manifest.private && process.env.PUBLISH !== "1") {
  // Expected state: the package is intentionally not publishable to npm yet.
  // Release requires an explicit license decision plus npmjs.com trusted-publisher setup.
} else if (!manifest.private && process.env.PUBLISH !== "1") {
  fail('package.json must stay "private": true until npm publishing is enabled (set PUBLISH=1 to check a publishable manifest)');
}

const patterns = manifest.files;
if (!Array.isArray(patterns) || !patterns.length) fail("package.json needs a non-empty files whitelist to keep the tarball small");

/** Minimal npm semantics for the simple patterns this package uses. */
const select = (list, allow) => {
  const negated = list.filter(p => p.startsWith("!")).map(p => p.slice(1));
  const matched = new Set();
  for (const pattern of list.filter(p => !p.startsWith("!"))) {
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: root, dot: false, onlyFiles: true })) matched.add(normalize(hit));
  }
  for (const pattern of negated) {
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: root, dot: false, onlyFiles: true })) matched.delete(normalize(hit));
  }
  for (const entry of allow ? (manifest.pi?.[allow] ?? []) : []) matched.add(normalize(entry.replace(/^\.\//, "")));
  return matched;
};

const shipped = select(patterns ?? [], "extensions");
if (!shipped.size) fail("the files whitelist matches no files");

const entries = manifest.pi?.extensions;
if (!Array.isArray(entries) || !entries.length) fail("package.json must declare pi.extensions");
for (const entry of entries ?? []) {
  if (entry.includes("..") || !entry.startsWith("./")) fail(`pi.extensions entry must be a relative ./ path: ${entry}`);
  else if (!existsSync(join(root, entry))) fail(`pi.extensions entry does not exist: ${entry}`);
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
console.log(`Package payload OK: ${payloadFiles.length} files, entries ${(entries ?? []).join(", ")}${manifest.private ? " (private: npm publishing gated)" : ""}`);
