import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore, containsPath, isSqliteBusy, projectText, repositoryRoot, type WorkWindow } from "./project-store";

const openStores = new Set<ProjectStore>();
const roots: string[] = [];
afterAll(() => {
  try { for (const s of openStores) s.close(); }
  finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});
const closeStore = (s: ProjectStore) => { s.close(); openStores.delete(s); };
const tempDir = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
const openStore = (path: string) => { const s = new ProjectStore(path); openStores.add(s); return s; };

test("writer contention is retryable and unrelated storage failures are not", () => {
  const root = tempDir("project-store-busy-");
  const path = join(root, "tracker.sqlite");
  const store = openStore(path); store.setClient(root, "Coral");
  const holder = new DatabaseSync(path);
  let blocked: DatabaseSync | undefined;
  try {
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO workspaces(root, client) VALUES ('/held', 'Coral')").run();
    blocked = new DatabaseSync(path);
    blocked.exec("PRAGMA busy_timeout = 25");
    let captured: unknown;
    try { blocked.prepare("INSERT INTO workspaces(root, client) VALUES ('/blocked', 'Coral')").run(); }
    catch (error) { captured = error; }
    expect(captured).toBeDefined();
    expect(isSqliteBusy(captured)).toBe(true);
    expect(store.windows(root)).toHaveLength(0);
  } finally {
    blocked?.close();
    holder.exec("ROLLBACK"); holder.close();
  }
  expect(isSqliteBusy(new Error("database is locked"))).toBe(false);
  expect(isSqliteBusy(new Error("disk I/O error"))).toBe(false);
  expect(isSqliteBusy(undefined)).toBe(false);
});

test("persists rows across reopen, keeps the database private and upserts windows by end", () => {
  const root = tempDir("project-store-rows-");
  const path = join(root, "tracker.sqlite");
  const s1 = openStore(path);
  s1.setClient(root, "Coral");
  s1.setTask(root, "sess-1", "invoices");
  s1.save({ id: "w1", root, client: "Coral", sessionId: "sess-1", task: "invoices", start: 1000, end: 2000, kind: "work" });
  s1.save({ id: "w1", root, client: "Coral", sessionId: "sess-1", task: "invoices", start: 1000, end: 3000, kind: "work" });
  closeStore(s1);
  const s2 = openStore(path);
  expect(s2.task(root, "sess-1")).toBe("invoices");
  expect(s2.task(root, "sess-2")).toBe("unlabeled");
  const rows = s2.windows(root);
  expect(rows).toHaveLength(1);
  expect(rows[0].end).toBe(3000);
  s2.setTask(root, "sess-3", "x");
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
});

test("two independent connections share rows through WAL", () => {
  const root = tempDir("project-store-wal-");
  const path = join(root, "tracker.sqlite");
  const a = openStore(path), b = openStore(path);
  a.setClient(root, "Coral");
  b.save({ id: "w-b", root, client: "Coral", sessionId: "s-b", task: "unlabeled", start: 1, end: 2, kind: "work" });
  expect(b.resolveWorkspace(root).client).toBe("Coral");
  expect(a.windows(root)).toHaveLength(1);
  const raw = new DatabaseSync(path);
  try { expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal"); }
  finally { raw.close(); }
});

test("rejects a database written by a newer schema", () => {
  const root = tempDir("project-store-ver-");
  const path = join(root, "tracker.sqlite");
  const s = openStore(path); closeStore(s);
  const raw = new DatabaseSync(path); raw.exec("PRAGMA user_version = 2147483647"); raw.close();
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

test("window reads and writes use canonical workspace roots", () => {
  const parent = tempDir("project-store-canonical-");
  const root = join(parent, "workspace"); mkdirSync(root);
  const alias = join(parent, "alias"); symlinkSync(root, alias);
  const s = openStore(join(parent, "tracker.sqlite"));
  s.setClient(alias, "Coral"); s.setTask(alias, "sess", "task");
  s.save({ id: "w", root: alias, client: "Coral", sessionId: "sess", task: "task", start: 1, end: 2, kind: "work" });
  for (const spelling of [root, alias, `${root}/../workspace`]) {
    expect(s.workspace(spelling)).toEqual({ root, client: "Coral" });
    expect(s.task(spelling, "sess")).toBe("task");
    expect(s.latest(spelling, "sess")).toMatchObject({ root, id: "w" });
    expect(s.windows(spelling)).toHaveLength(1);
    expect(s.windows(spelling)[0].root).toBe(root);
  }
});

test("deleted workspace roots retain historical reads and pending writes", () => {
  const parent = tempDir("project-store-deleted-");
  const root = join(parent, "workspace"); mkdirSync(root);
  const s = openStore(join(parent, "tracker.sqlite"));
  s.setClient(root, "Coral"); s.setTask(root, "sess", "task");
  const window: WorkWindow = { id: "w", root, client: "Coral", sessionId: "sess", task: "task", start: 1, end: 2, kind: "work" };
  s.save(window);
  rmSync(root, { recursive: true });
  expect(s.windows(root)).toEqual([window]);
  expect(s.latest(root, "sess")).toEqual(window);
  expect(s.workspace(root)).toEqual({ root, client: "Coral" });
  expect(s.resolveWorkspace(root)).toEqual({ root, client: "Coral" });
  expect(s.task(root, "sess")).toBe("task");
  expect(repositoryRoot(root)).toBe(root);
  s.setClient(root, "Other"); s.setTask(root, "sess", "new task");
  s.save({ ...window, end: 3 });
  expect(s.windows(root)).toEqual([{ ...window, end: 3 }]);
  closeStore(s);
  const reopened = openStore(join(parent, "tracker.sqlite"));
  expect(reopened.windows(root)).toEqual([{ ...window, end: 3 }]);
  expect(reopened.task(root, "sess")).toBe("new task");
});

test("refuses database symlinks without touching their target and tightens existing files", () => {
  const root = tempDir("project-store-private-");
  const target = join(root, "target"); writeFileSync(target, "untouched"); chmodSync(target, 0o644);
  const link = join(root, "tracker.sqlite"); symlinkSync(target, link);
  expect(() => new ProjectStore(link)).toThrow("symlink");
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(statSync(target).mode & 0o777).toBe(0o644);
  const path = join(root, "existing.sqlite"); writeFileSync(path, ""); chmodSync(path, 0o644);
  openStore(path).setClient(root, "Coral");
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
});

test("validates names, timestamps and window rows", () => {
  const root = tempDir("project-store-valid-");
  const s = openStore(join(root, "tracker.sqlite"));
  s.setClient(root, "Valid client");
  s.setTask(root, "sess", "Valid task");
  for (const invalid of ["", "two\nlines", "two\u0085lines", "two\u2028lines", "two\u2029lines", "x".repeat(121)]) {
    expect(() => s.setClient(root, invalid)).toThrow("single-line");
    expect(() => s.setTask(root, "sess", invalid)).toThrow("single-line");
    expect(s.workspace(root).client).toBe("Valid client");
    expect(s.task(root, "sess")).toBe("Valid task");
  }
  expect(projectText("  Unicode café  ")).toBe("Unicode café");
  expect(() => s.save({ id: "x", root, client: "C", sessionId: "s", task: "t", start: 2000, end: 1000, kind: "work" })).toThrow("timestamps");
  expect(() => s.save({ id: "x", root, client: "C", sessionId: "s", task: "t", start: -1, end: 1, kind: "work" })).toThrow("timestamps");
  expect(s.windows(root)).toHaveLength(0);
  const valid: WorkWindow = { id: "x", root, client: "C", sessionId: "s", task: "t", start: 1, end: 2, kind: "work" };
  s.save(valid);
  expect(() => s.save({ ...valid, end: 0 })).toThrow("timestamps");
  expect(s.windows(root)).toEqual([valid]);
});
