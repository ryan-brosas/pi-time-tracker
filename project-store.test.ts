import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore, containsPath, repositoryRoot } from "./project-store";

const openStores: ProjectStore[] = [];
afterAll(() => { for (const s of openStores.splice(0)) s.close(); });
const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const openStore = (path: string) => { const s = new ProjectStore(path); openStores.push(s); return s; };

test("persists rows across reopen, keeps the database private and upserts windows by end", () => {
  const root = tempDir("project-store-rows-");
  const path = join(root, "tracker.sqlite");
  const s1 = openStore(path);
  s1.setClient(root, "Coral");
  s1.setTask(root, "sess-1", "invoices");
  s1.save({ id: "w1", root, client: "Coral", sessionId: "sess-1", task: "invoices", start: 1000, end: 2000, kind: "work" });
  s1.save({ id: "w1", root, client: "Coral", sessionId: "sess-1", task: "invoices", start: 1000, end: 3000, kind: "work" });
  s1.close();
  const s2 = openStore(path);
  expect(s2.task(root, "sess-1")).toBe("invoices");
  expect(s2.task(root, "sess-2")).toBe("unlabeled");
  const rows = s2.windows(root);
  expect(rows).toHaveLength(1);
  expect(rows[0].end).toBe(3000);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("two independent connections share rows through WAL", () => {
  const root = tempDir("project-store-wal-");
  const path = join(root, "tracker.sqlite");
  const a = openStore(path), b = openStore(path);
  a.setClient(root, "Coral");
  b.save({ id: "w-b", root, client: "Coral", sessionId: "s-b", task: "unlabeled", start: 1, end: 2, kind: "work" });
  expect(b.resolveWorkspace(root).client).toBe("Coral");
  expect(a.windows(root)).toHaveLength(1);
});

test("rejects a database written by a newer schema", () => {
  const root = tempDir("project-store-ver-");
  const path = join(root, "tracker.sqlite");
  const s = openStore(path); s.close();
  const raw = new DatabaseSync(path); raw.exec("PRAGMA user_version = 2"); raw.close();
  expect(() => new ProjectStore(path)).toThrow("newer version");
});

test("workspace resolution prefers the most specific explicit parent, falls back to the git root, and rejects symlink escapes", () => {
  const parent = tempDir("project-store-map-");
  const repo = join(parent, "clientA"); mkdirSync(repo); mkdirSync(join(repo, ".git"));
  const nested = join(repo, "web"); mkdirSync(nested);
  const sibling = join(parent, "clientA-other"); mkdirSync(sibling);
  const outside = tempDir("project-store-out-");
  const link = join(parent, "escape"); symlinkSync(outside, link);
  const s = openStore(join(parent, "tracker.sqlite"));
  expect(s.resolveWorkspace(nested).root).toBe(repo);
  expect(s.resolveWorkspace(nested).client).toBe("clientA");
  s.setClient(parent, "Coral");
  expect(s.resolveWorkspace(nested).client).toBe("Coral");
  s.setClient(repo, "Coral Web");
  expect(s.resolveWorkspace(nested).client).toBe("Coral Web");
  expect(s.resolveWorkspace(sibling).client).toBe("Coral");
  const escaped = s.resolveWorkspace(link);
  expect(escaped.root).toBe(outside);
  expect(escaped.client).not.toBe("Coral");
});

test("repositoryRoot walks up to .git and containsPath respects boundaries", () => {
  const parent = tempDir("project-store-git-");
  const repo = join(parent, "repo"); mkdirSync(join(repo, ".git"), { recursive: true });
  const nested = join(repo, "a", "b"); mkdirSync(nested, { recursive: true });
  expect(repositoryRoot(nested)).toBe(repo);
  expect(repositoryRoot(parent)).toBe(parent);
  expect(containsPath(repo, nested)).toBe(true);
  expect(containsPath(repo, join(parent, "repo-other"))).toBe(false);
});

test("validates names, timestamps and window rows", () => {
  const root = tempDir("project-store-valid-");
  const s = openStore(join(root, "tracker.sqlite"));
  expect(() => s.setClient(root, "")).toThrow("nonempty");
  expect(() => s.setClient(root, "two\nlines")).toThrow("single-line");
  expect(() => s.save({ id: "x", root, client: "C", sessionId: "s", task: "t", start: 2000, end: 1000, kind: "work" })).toThrow("timestamps");
  expect(() => s.save({ id: "x", root, client: "C", sessionId: "s", task: "t", start: -1, end: 1, kind: "work" })).toThrow("timestamps");
  expect(s.windows(root)).toHaveLength(0);
});
