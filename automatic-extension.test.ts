import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTimeTrackingExtension } from "./extension";
import { ProjectStore } from "./project-store";
import { readTurnRecords } from "./ledger";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  try { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root;
}

function harness(root: string, dbPath: string, sessionId: string, opts: Record<string, unknown> = {}) {
  const events = new Map<string, (event: any, ctx: any) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => void }>();
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const inputHandlers = new Set<(data: string) => unknown>();
  let clock = 1_000_000;
  const ctx: any = {
    cwd: root, mode: "tui", sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string) => notices.push(message), setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      onTerminalInput: (handler: (data: string) => unknown) => { inputHandlers.add(handler); return () => { inputHandlers.delete(handler); }; },
    },
  };
  createTimeTrackingExtension(root, {
    turnsLog: join(root, "t.jsonl"), chunksLog: join(root, "c.jsonl"), sessionsLog: join(root, "s.jsonl"),
    activitiesLog: join(root, "a.jsonl"), reportFile: join(root, "report.md"), databasePath: dbPath,
    scopePrefix: "test", timezones: ["UTC"], now: () => clock, ...opts,
  })({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerTool: () => {} } as any);
  const emit = (name: string, at: number, event: any = {}) => {
    clock = at;
    const handler = events.get(name);
    if (!handler) throw new Error(`Event not registered: ${name}`);
    handler(event, ctx);
  };
  cleanups.push(() => emit("session_shutdown", clock));
  const type = (data: string, at: number) => { clock = at; for (const handler of [...inputHandlers]) handler(data); };
  const command = (name: string, args: string) => {
    const registered = commands.get(name);
    if (!registered) throw new Error(`Command not registered: ${name}`);
    registered.handler(args, ctx);
  };
  return {
    ctx, notices, statuses, emit, type, command, listenerCount: () => inputHandlers.size,
    store: () => { const store = new ProjectStore(dbPath); cleanups.push(() => store.close()); return store; },
    report: () => readFileSync(join(root, "report.md"), "utf8"),
    allReport: () => {
      const path = join(dirname(dbPath), "automatic-work-report.md");
      expect(existsSync(path)).toBe(true);
      return readFileSync(path, "utf8");
    },
  };
}

test("tracks work automatically: short gaps join, long gaps stay excluded, no start or stop", () => {
  const root = tempRoot("auto-ext-capture-");
  const dbPath = join(root, "db.sqlite");
  const t = 1_000_000;
  const h = harness(root, dbPath, "sess-1");
  h.emit("session_start", t);
  h.type("h", t + 10_000);
  h.type("i", t + 20_000);
  h.emit("input", t + 30_000);
  h.emit("before_agent_start", t + 30_000, { prompt: "draft the invoice" });
  h.emit("agent_start", t + 30_000);
  h.emit("message_update", t + 90_000);
  h.emit("agent_settled", t + 120_000);
  h.type("k", t + 420_000); // a five-minute review gap stays joined
  h.emit("before_agent_start", t + 430_000, { prompt: "second pass" });
  h.emit("agent_start", t + 430_000);
  h.emit("agent_settled", t + 440_000);
  h.type("j", t + 1_640_000); // twenty idle minutes are excluded, not counted
  h.emit("session_shutdown", t + 1_650_000); // shutdown flushes but never advances the end
  const store = h.store();
  const rows = store.windows(root);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ kind: "work", start: t + 10_000, end: t + 440_000, sessionId: "sess-1" });
  expect(rows[1]).toMatchObject({ kind: "gap", start: t + 440_000, end: t + 1_640_000 });
  expect(rows[2]).toMatchObject({ kind: "work", start: t + 1_640_000, end: t + 1_640_000 });
  store.close();
  h.command("work", "report");
  expect(h.report()).toContain("Inferred work union: 0.12 h");
  expect(h.report()).toContain("Excluded quiet gap");
  expect(h.report()).toContain("0.33 h");
  expect(h.report()).toContain("not proof of continuous human presence");
});

test("an open session with no activity never creates windows or hours", () => {
  const root = tempRoot("auto-ext-idle-");
  const h = harness(root, join(root, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.emit("session_shutdown", 1_000_000 + 86_400_000); // a full idle day passes
  const store = h.store();
  expect(store.windows(root)).toHaveLength(0);
  store.close();
});

test("workspace labels, session tasks and resume survive reloads via the shared database", () => {
  const root = tempRoot("auto-ext-restore-");
  const dbPath = join(root, "db.sqlite");
  const t = 1_000_000;
  const opts = { idleGapMs: 14_400_000 };
  const first = harness(root, dbPath, "sess-1", opts);
  first.emit("session_start", t);
  first.command("project", "set Coral");
  first.command("project", "task invoices");
  first.type("a", t + 10_000);
  first.type("b", t + 300_000);
  first.emit("session_shutdown", t + 300_000);
  const second = harness(root, dbPath, "sess-2", opts); // a concurrent session overlaps the first
  second.emit("session_start", t + 150_000);
  second.type("c", t + 150_000);
  second.type("d", t + 500_000);
  second.emit("session_shutdown", t + 500_000);
  const resumed = harness(root, dbPath, "sess-1", opts); // resuming sess-1 restores its task and client
  resumed.emit("session_start", t + 560_000);
  resumed.command("project", "status");
  expect(resumed.notices.at(-1)).toContain("Coral");
  expect(resumed.notices.at(-1)).toContain("invoices");
  resumed.emit("session_shutdown", t + 560_000);
  const store = resumed.store();
  const rows = store.windows(root);
  expect(rows.every(r => r.client === "Coral")).toBe(true);
  expect(rows.filter(r => r.sessionId === "sess-1" && r.kind === "work").every(r => r.task === "invoices")).toBe(true);
  expect(rows.filter(r => r.sessionId === "sess-2" && r.kind === "work").every(r => r.task === "unlabeled")).toBe(true);
  expect(rows).toHaveLength(2);
  store.close();
  const reporter = harness(root, dbPath, "sess-2", opts); // the all-workspaces report unions concurrent sessions
  reporter.emit("session_start", t + 600_000);
  reporter.command("project", "report all");
  const all = reporter.allReport();
  expect(all).toContain("0.14 h");
  expect(all).not.toContain("0.18 h");
  expect(all).toContain("not proof of continuous human work");
  reporter.emit("session_shutdown", t + 600_000);
});

test("a failing store disables automatic tracking but never breaks legacy turn receipts", () => {
  const root = tempRoot("auto-ext-fail-");
  const dbPath = join(root, "invalid.sqlite");
  mkdirSync(dbPath); // A directory cannot be opened as a database, on any platform.
  const t = 1_000_000;
  const h = harness(root, dbPath, "sess-1");
  h.emit("session_start", t);
  expect(h.notices.some(n => n.includes("automatic work tracking disabled"))).toBe(true);
  h.emit("before_agent_start", t + 1_000, { prompt: "keep tracking turns" });
  h.emit("agent_start", t + 1_000);
  h.emit("message_update", t + 2_000);
  h.emit("agent_settled", t + 3_000);
  expect(readTurnRecords(join(root, "t.jsonl"))).toHaveLength(1);
  h.command("work", "report");
  expect(h.report()).not.toContain("Inferred work union");
  h.emit("session_shutdown", t + 3_000);
});

test("a cancelled session switch keeps tracking and a real shutdown removes the input listener", () => {
  const root = tempRoot("auto-ext-cancel-");
  const h = harness(root, join(root, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.type("a", 1_001_000);
  h.emit("session_before_switch", 1_002_000);
  // Another extension vetoes the switch: Pi emits no shutdown/start afterward.
  h.type("b", 1_021_000);
  h.emit("before_agent_start", 1_021_500, { prompt: "still working after the veto" });
  h.emit("agent_start", 1_021_500);
  h.emit("message_update", 1_022_500);
  h.emit("agent_settled", 1_023_000);
  expect(readTurnRecords(join(root, "t.jsonl"))).toHaveLength(1); // turn receipts continue after the veto
  h.command("project", "report all");
  const store = h.store();
  try {
    expect(store.windows()[0].end).toBe(1_023_000);
    expect(h.listenerCount()).toBe(1);
  } finally {
    store.close();
    h.emit("session_shutdown", 1_023_000);
  }
  expect(h.listenerCount()).toBe(0);
});

test("terminal input cannot escape an explicit adapter root inside a larger repository", () => {
  const repo = tempRoot("auto-ext-scope-");
  const root = join(repo, "project"), sibling = join(repo, "sibling");
  for (const dir of [join(repo, ".git"), root, sibling]) mkdirSync(dir);
  const h = harness(root, join(repo, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.type("a", 1_001_000);
  h.type("b", 1_011_000);
  h.ctx.cwd = sibling;
  h.type("c", 1_031_000);
  h.emit("session_shutdown", 1_041_000);
  const store = h.store();
  try { expect(store.windows()[0].end).toBe(1_011_000); }
  finally { store.close(); }
});

test("streaming events share one scope check but recheck cwd on the next event", () => {
  const root = tempRoot("auto-ext-event-scope-");
  const sibling = tempRoot("auto-ext-event-outside-");
  const h = harness(root, join(root, "db.sqlite"), "sess");
  h.emit("session_start", 1_000_000);
  h.emit("agent_start", 1_000_000);
  const realpath = spyOn(fs, "realpathSync");
  try {
    for (const event of ["message_update", "tool_execution_start", "tool_execution_end"]) {
      realpath.mockClear();
      h.emit(event, 1_002_000);
      expect(realpath).toHaveBeenCalledTimes(2); // cwd and configured root, once per event
    }
  } finally { realpath.mockRestore(); }
  h.ctx.cwd = sibling;
  h.emit("message_update", 1_003_000);
  h.emit("session_shutdown", 1_004_000);
  expect(h.store().windows(root)[0]).toMatchObject({ start: 1_000_000, end: 1_002_000 });
  expect(readTurnRecords(join(root, "t.jsonl"))[0]).toMatchObject({ outcome: "interrupted", observedMs: 2_000 });
});

test("factory rejects undispatchable project names and relative database paths", () => {
  for (const projectCommand of ["", "my project", "/project", "project\n"]) {
    expect(() => createTimeTrackingExtension(undefined, { projectCommand })).toThrow("projectCommand");
  }
  expect(() => createTimeTrackingExtension(undefined, { databasePath: "tracker.sqlite" })).toThrow("absolute path");
});

test("explicit databasePath overrides the environment and all-workspace drafts never overwrite local reports", () => {
  const root = tempRoot("auto-ext-paths-");
  const dbPath = join(root, "exports", "db.sqlite"), reportFile = join(root, "exports", "work-report.md");
  const previous = process.env.WORKTIME_DB_PATH;
  const envPath = join(root, "unused.sqlite");
  process.env.WORKTIME_DB_PATH = envPath;
  try {
    const h = harness(root, dbPath, "sess", { reportFile });
    h.emit("session_start", 1_000_000); h.type("a", 1_001_000); h.type("b", 1_021_000);
    expect(existsSync(dbPath)).toBe(true); expect(existsSync(envPath)).toBe(false);
    h.command("work", "report");
    const local = readFileSync(reportFile, "utf8");
    h.command("project", "report all");
    expect(h.allReport()).toContain("Inferred");
    expect(readFileSync(reportFile, "utf8")).toBe(local);
  } finally {
    if (previous === undefined) delete process.env.WORKTIME_DB_PATH; else process.env.WORKTIME_DB_PATH = previous;
  }
});

test("late session identity rebinds automatic windows and restores the stable session task", () => {
  const root = tempRoot("auto-ext-identity-");
  const h = harness(root, join(root, "db.sqlite"), "stable");
  const store = h.store(); store.setTask(root, "stable", "invoices");
  h.ctx.sessionManager = undefined;
  h.emit("session_start", 1_000_000); h.type("a", 1_001_000);
  h.ctx.sessionManager = { getSessionId: () => "stable" };
  h.emit("agent_start", 1_010_000); h.emit("agent_settled", 1_020_000);
  const rows = store.windows(root).filter(r => r.sessionId === "stable");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ task: "invoices", start: 1_010_000, end: 1_020_000 });
  expect(readTurnRecords(join(root, "t.jsonl"))[0].sessionId).toBe("stable");
  expect(h.listenerCount()).toBe(1);
});

test("store failure clears session metadata and listeners and retries on the next session", () => {
  const root = tempRoot("auto-ext-retry-");
  const h = harness(root, join(root, "db.sqlite"), "first");
  h.emit("session_start", 1_000_000);
  h.command("project", "set Coral"); h.command("project", "task invoices"); h.type("a", 1_001_000);
  const fail = spyOn(ProjectStore.prototype, "save").mockImplementationOnce(() => { throw new Error("SQLITE_BUSY"); });
  try { h.type("b", 1_021_000); } finally { fail.mockRestore(); }
  expect(h.statuses.at(-1)).toContain("disabled"); expect(h.listenerCount()).toBe(0);
  h.command("project", "status");
  expect(h.notices.at(-1)).toContain("Client Unknown (unbound)");
  expect(h.notices.at(-1)).toContain("session task unlabeled");
  h.command("project", "task"); expect(h.notices.at(-1)).toContain("Session task: unlabeled");
  h.ctx.sessionManager = { getSessionId: () => "second" };
  h.emit("session_start", 1_030_000); h.type("c", 1_031_000); h.type("d", 1_051_000);
  expect(h.listenerCount()).toBe(1); expect(h.statuses.at(-1)).toContain("tracking on");
  const rows = h.store().windows(root);
  expect(rows.find(r => r.sessionId === "first")?.end).toBe(1_001_000);
  expect(rows.find(r => r.sessionId === "second")).toMatchObject({ client: "Coral", task: "unlabeled", start: 1_031_000, end: 1_051_000 });
});

test("read-only task needs no store and a first store failure notifies once", () => {
  const root = tempRoot("auto-ext-notices-");
  const dbPath = join(root, "invalid.sqlite"); mkdirSync(dbPath);
  const h = harness(root, dbPath, "sess");
  h.command("project", "task");
  expect(h.notices).toEqual(["Session task: unlabeled. Set with /project task <name>; use \"clear\" to reset to unlabeled."]);
  h.command("project", "set Coral");
  expect(h.notices).toHaveLength(2); expect(h.notices[1]).toContain("automatic work tracking disabled");
});

test("/project validates its arguments", () => {
  const root = tempRoot("auto-ext-args-");
  const h = harness(root, join(root, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.command("project", "report 2026-02-31");
  expect(h.notices.at(-1)).toContain("Expected report [YYYY-MM-DD|all]");
  h.command("project", "bogus");
  expect(h.notices.at(-1)).toContain("unknown");
  h.command("project", "task");
  expect(h.notices.at(-1)).toContain("Session task: unlabeled");
  h.emit("session_shutdown", 1_000_000);
});
