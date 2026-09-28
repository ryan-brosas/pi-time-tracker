import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimeTrackingExtension } from "./extension";
import { labelFor } from "./labels";
import { appendJsonl, readChunks, readTurnRecords } from "./ledger";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-time-tracker-audit-"));
  roots.push(root);
  let clock = Date.parse("2026-09-26T15:59:00Z");
  const events = new Map<string, any>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const notices: string[] = [];
  const logs = { databasePath: join(root, "db.sqlite"), turnsLog: join(root, "turns.jsonl"), chunksLog: join(root, "chunks.jsonl"), sessionsLog: join(root, "sessions.jsonl"), activitiesLog: join(root, "activities.jsonl"), reportFile: join(root, "report.md") };
  const ctx = { cwd: root, mode: "json", sessionManager: { getSessionId: () => "test-session" }, ui: { notify: (s: string) => notices.push(s), setStatus: () => {} } };
  createTimeTrackingExtension(root, { ...logs, scopePrefix: "test", timezones: ["Asia/Manila"], now: () => clock })({ on: (n: string, fn: any) => events.set(n, fn), registerCommand: (n: string, d: any) => commands.set(n, d), registerTool: (d: any) => tools.set(d.name, d) } as any);
  return { root, logs, events, commands, tools, ctx, notices, at: (iso: string) => { clock = Date.parse(iso); }, emit: (name: string, event: any = {}) => events.get(name)?.(event, ctx), report: () => { commands.get("work").handler("report", ctx); return readFileSync(logs.reportFile, "utf8"); } };
}

test("generic browser use does not invent anti-bot work; Reddit has its own label", () => {
  expect(labelFor(undefined, ["beacon.navigate"])).toBeUndefined();
  expect(labelFor("update the Reddit engagement tracker")?.label).toBe("reddit");
  expect(labelFor("continue anti-bot signup-holds pass")?.label).toBe("antibot");
});

test("subdirectory work is captured, attributed, checkpointed and survives a missing final summary", () => {
  const h = setup(); mkdirSync(join(h.root, "web")); h.ctx.cwd = join(h.root, "web");
  h.emit("session_start"); expect(existsSync(h.logs.databasePath)).toBe(true); // the configured store, not the default one
  h.emit("before_agent_start", { prompt: "Reddit opportunity research" }); h.emit("agent_start");
  h.at("2026-09-26T16:01:00Z"); h.emit("message_update");
  const chunks = readChunks(h.logs.chunksLog);
  expect(chunks.length).toBeGreaterThan(0);
  expect((chunks[0] as any).label).toBe("reddit");
  expect((chunks[0] as any).sessionId).toBe("test-session");
  expect(readTurnRecords(h.logs.turnsLog)).toHaveLength(0);
  expect(h.report()).toContain("Unsettled/checkpoint-only");
  h.emit("agent_settled");
  expect(readTurnRecords(h.logs.turnsLog)).toHaveLength(1);
});

test("report separates old aggregate records from paired intervals and itemizes each local day", () => {
  const h = setup(); h.emit("session_start");
  appendJsonl(h.logs.turnsLog, { version: 1, id: "legacy", startedAt: "2026-09-25T14:00:00Z", endedAt: "2026-09-25T15:00:00Z", observedMs: 1800000, outcome: "settled", scope: "test-pi-turn" });
  h.emit("before_agent_start", { prompt: "Reddit research" }); h.emit("agent_start");
  h.at("2026-09-26T16:01:00Z"); h.emit("agent_settled");
  const report = h.report();
  expect(report).toContain("2026-09-25"); expect(report).toContain("Unknown (no interval evidence)");
  expect(report).toContain("Legacy aggregate records: 1");
  expect(report).toContain("### 2026-09-26"); expect(report).toContain("### 2026-09-27");
  expect(report).toContain("23:59:00"); expect(report).toContain("00:01:00");
  expect(report).toContain("reddit"); expect(report).not.toContain("user-attested 0.0 h");
});

test("a detailed work note adds evidence but never invents or adds duration", async () => {
  const h = setup(); h.emit("session_start");
  expect(h.tools.has("work_note")).toBe(true);
  const tool = h.tools.get("work_note");
  await tool.execute("note-call", { label: "reddit", summary: "Verified existing comment permalink", status: "verified", evidence: ["https://www.reddit.com/r/example/comments/abc/test/def/"] }, undefined, undefined, h.ctx);
  const report = h.report();
  expect(report).toContain("Verified existing comment permalink");
  expect(report).toContain("verified"); expect(report).toContain("duration Unallocated");
  expect(readChunks(h.logs.chunksLog)).toHaveLength(0);
  const raw = readFileSync(h.logs.activitiesLog, "utf8");
  expect(raw).not.toContain("observedMs");
});
