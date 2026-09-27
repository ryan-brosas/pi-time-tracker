import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Workspace { root: string; client: string }
export interface WorkWindow extends Workspace {
  id: string; sessionId: string; task: string; start: number; end: number; kind: "work" | "gap";
}
export function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function repositoryRoot(cwd: string): string {
  const canonical = realpathSync(cwd);
  for (let dir = canonical; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return canonical;
  }
}
export function defaultDatabasePath(): string {
  return resolve(process.env.WORKTIME_DB_PATH ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-time-tracker", "tracker.sqlite"));
}
export function projectText(text: string): string {
  const value = text.trim();
  if (!value || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Use a nonempty, single-line name (up to 120 characters)");
  return value;
}

/** Owns workspace assignments and inferred work windows, not the independent agent receipts. */
export class ProjectStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Tracker database must not be a symlink");
    const fd = openSync(path, "a", 0o600); closeSync(fd); chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw new Error("Tracker database was created by a newer version");
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspaces (root TEXT PRIMARY KEY, client TEXT NOT NULL, explicit INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS tasks (root TEXT NOT NULL, sessionId TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(root, sessionId));
        CREATE TABLE IF NOT EXISTS windows (
          id TEXT PRIMARY KEY, root TEXT NOT NULL, client TEXT NOT NULL, sessionId TEXT NOT NULL, task TEXT NOT NULL,
          start INTEGER NOT NULL, end INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('work','gap')),
          CHECK(start >= 0 AND end >= start));
        CREATE INDEX IF NOT EXISTS windows_session ON windows(root, sessionId, end);
        PRAGMA user_version = 1;
        COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  resolveWorkspace(cwd: string): Workspace {
    const path = realpathSync(cwd);
    const candidates = this.db.prepare("SELECT root, client FROM workspaces WHERE explicit = 1").all() as unknown as Workspace[];
    const mapped = candidates.filter(w => containsPath(w.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
    return mapped ?? this.workspace(repositoryRoot(path));
  }
  workspace(root: string): Workspace {
    root = realpathSync(root);
    this.db.prepare("INSERT OR IGNORE INTO workspaces(root, client) VALUES (?, ?)").run(root, basename(root) || root);
    return this.db.prepare("SELECT root, client FROM workspaces WHERE root = ?").get(root) as unknown as Workspace;
  }
  setClient(root: string, client: string): Workspace {
    root = realpathSync(root); client = projectText(client);
    this.db.prepare("INSERT INTO workspaces(root, client, explicit) VALUES (?, ?, 1) ON CONFLICT(root) DO UPDATE SET client = excluded.client, explicit = 1").run(root, client);
    return { root, client };
  }
  task(root: string, sessionId: string): string {
    root = realpathSync(root);
    return (this.db.prepare("SELECT task FROM tasks WHERE root = ? AND sessionId = ?").get(root, sessionId) as { task: string } | undefined)?.task ?? "unlabeled";
  }
  setTask(root: string, sessionId: string, task: string): void {
    root = realpathSync(root);
    this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?) ON CONFLICT(root, sessionId) DO UPDATE SET task = excluded.task").run(root, sessionId, projectText(task));
  }
  save(window: WorkWindow): void {
    if (![window.start, window.end].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15) || window.end < window.start) throw new Error("Invalid work-window timestamps");
    this.db.prepare(`INSERT INTO windows VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET end = MAX(windows.end, excluded.end)`).run(window.id, window.root, window.client, window.sessionId, window.task, window.start, window.end, window.kind);
  }
  latest(root: string, sessionId: string): WorkWindow | undefined {
    return this.db.prepare("SELECT * FROM windows WHERE root = ? AND sessionId = ? AND kind = 'work' ORDER BY end DESC, rowid DESC LIMIT 1").get(root, sessionId) as unknown as WorkWindow | undefined;
  }
  windows(root?: string): WorkWindow[] {
    return (root === undefined ? this.db.prepare("SELECT * FROM windows ORDER BY start, id").all() : this.db.prepare("SELECT * FROM windows WHERE root = ? ORDER BY start, id").all(root)) as unknown as WorkWindow[];
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
