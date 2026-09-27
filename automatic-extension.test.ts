import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimeTrackingExtension } from "./extension";
import { ProjectStore } from "./project-store";
import { readTurnRecords } from "./ledger";

function harness(root: string, dbPath: string, sessionId: string, opts: Record<string, unknown> = {}) {
  const events = new Map<string, (event: any, ctx: any) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => void }>();
  const notices: string[] = [];
  const inputHandlers = new Set<(data: string) => unknown>();
  let clock = 1_000_000;
  const ctx: any = {
    cwd: root, mode: "tui", sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string) => notices.push(message), setStatus: () => {},
      onTerminalInput: (handler: (data: string) => unknown) => { inputHandlers.add(handler); return () => { inputHandlers.delete(handler); }; },
    },
  };
  createTimeTrackingExtension(root, {
    turnsLog: join(root, "t.jsonl"), chunksLog: join(root, "c.jsonl"), sessionsLog: join(root, "s.jsonl"),
    activitiesLog: join(root, "a.jsonl"), reportFile: join(root, "report.md"), databasePath: dbPath,
    scopePrefix: "test", timezones: ["UTC"], now: () => clock, ...opts,
  })({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerTool: () => {} } as any);
  const emit = (name: string, at: number, event: any = {}) => { clock = at; events.get(name)!(event, ctx); };
  const type = (data: string, at: number) => { clock = at; for (const handler of [...inputHandlers]) handler(data); };
  const command = (name: string, args: string) => { commands.get(name)!.handler(args, ctx); };
  return {
    ctx, notices, emit, type, command, listenerCount: () => inputHandlers.size,
    store: () => new ProjectStore(dbPath),
    report: () => readFileSync(join(root, "report.md"), "utf8"),
    allReport: () => readFileSync(join(root, "work-report.md"), "utf8"),
  };
}

test("tracks work automatically: short gaps join, long gaps stay excluded, no start or stop", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-ext-capture-"));
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
  const root = mkdtempSync(join(tmpdir(), "auto-ext-idle-"));
  const h = harness(root, join(root, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.emit("session_shutdown", 1_000_000 + 86_400_000); // a full idle day passes
  const store = h.store();
  expect(store.windows(root)).toHaveLength(0);
  store.close();
});

test("workspace labels, session tasks and resume survive reloads via the shared database", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-ext-restore-"));
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
});

test("a failing store disables automatic tracking but never breaks legacy turn receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-ext-fail-"));
  const target = mkdtempSync(join(tmpdir(), "auto-ext-target-"));
  const dbPath = join(root, "link.sqlite");
  symlinkSync(join(target, "gone.sqlite"), dbPath);
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
  const root = mkdtempSync(join(tmpdir(), "auto-ext-cancel-"));
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
  const repo = mkdtempSync(join(tmpdir(), "auto-ext-scope-"));
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

test("/project validates its arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-ext-args-"));
  const h = harness(root, join(root, "db.sqlite"), "sess-1");
  h.emit("session_start", 1_000_000);
  h.command("project", "report 2026-02-31");
  expect(h.notices.at(-1)).toContain("failed");
  h.command("project", "bogus");
  expect(h.notices.at(-1)).toContain("unknown");
  h.command("project", "task");
  expect(h.notices.at(-1)).toContain("Session task: unlabeled");
  h.emit("session_shutdown", 1_000_000);
});
