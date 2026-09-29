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

// Asking for hours must be one tool call over recorded receipts, not a shell
// reconstruction of the ledgers, and the answer must carry the note detail.
test("work_report summarizes recorded hours and keeps note evidence in the same draft", async () => {
  const h = setup(); h.emit("session_start");
  h.emit("before_agent_start", { prompt: "Reddit research" }); h.emit("agent_start");
  h.at("2026-09-26T16:01:00Z"); h.emit("agent_settled");
  await h.tools.get("work_note").execute("note-call", { label: "reddit", summary: "Verified existing comment permalink", status: "verified", evidence: ["https://www.reddit.com/r/example/comments/abc/test/def/"] }, undefined, undefined, h.ctx);
  const result = await h.tools.get("work_report").execute("report-call", {}, undefined, undefined, h.ctx);
  const report = readFileSync(h.logs.reportFile, "utf8");
  expect(report).toContain("Verified existing comment permalink");
  expect(report).toContain("verified"); expect(report).toContain("Detailed evidence notes");
  expect(result.content[0].text).toContain("Full draft");
  expect(result.details).toEqual({ summary: result.details.summary, reportFile: h.logs.reportFile, sinceDay: null });
  expect(result.details.summary).toContain("tracked working hours");
  expect(result.details.summary).not.toContain("user-attested 0.0 h");
  // The tool and the slash command share one builder, so both produce that draft.
  expect(h.report()).toBe(report);
});

test("work_report filters by day, rejects a bad day and stays inside the workspace", async () => {
  const h = setup();
  h.at("2026-09-25T01:00:00Z"); h.emit("session_start");
  h.emit("before_agent_start", { prompt: "Reddit research" }); h.emit("agent_start");
  h.at("2026-09-25T01:02:00Z"); h.emit("message_update"); h.emit("agent_settled");
  h.at("2026-09-26T01:00:00Z"); h.emit("agent_start");
  h.at("2026-09-26T01:04:00Z"); h.emit("message_update"); h.emit("agent_settled");
  await h.tools.get("work_report").execute("all", {}, undefined, undefined, h.ctx);
  const unfiltered = readFileSync(h.logs.reportFile, "utf8");
  expect(unfiltered).toContain("### 2026-09-25");
  expect(unfiltered).toContain("### 2026-09-26");
  const filtered = await h.tools.get("work_report").execute("c1", { sinceDay: "2026-09-26" }, undefined, undefined, h.ctx);
  expect(filtered.details.sinceDay).toBe("2026-09-26");
  const draft = readFileSync(h.logs.reportFile, "utf8");
  expect(draft).not.toContain("### 2026-09-25");
  expect(draft).toContain("### 2026-09-26");
  await expect(h.tools.get("work_report").execute("c2", { sinceDay: "26-09-2026" }, undefined, undefined, h.ctx)).rejects.toThrow("Expected report");
  await expect(h.tools.get("work_report").execute("c3", {}, undefined, undefined, { ...h.ctx, cwd: tmpdir() })).rejects.toThrow("limited to this workspace");
});

test("work_report discloses absent outcome notes instead of inventing history", async () => {
  const h = setup(); h.emit("session_start");
  h.at("2026-09-26T16:01:00Z"); h.emit("agent_start"); h.emit("message_update");
  h.at("2026-09-26T16:05:00Z"); h.emit("agent_settled");
  await h.tools.get("work_report").execute("c1", {}, undefined, undefined, h.ctx);
  const report = readFileSync(h.logs.reportFile, "utf8");
  expect(report).toContain("No outcome notes were recorded for this day");
  expect(report).not.toContain("Detailed evidence notes");
  expect(report).toContain("Bend receipt audit"); expect(report).not.toContain("Native receipt audit");
  expect(report).toContain("Prompts, transcripts and file contents are never captured");
});

test("a configured command prefix names both workspace tools consistently", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-time-tracker-prefix-")); roots.push(root);
  const tools = new Map<string, { name: string }>();
  createTimeTrackingExtension(root, { scopePrefix: "gig", commandPrefix: "gigtime", commandPrefix2: undefined, databasePath: join(root, "db.sqlite"), turnsLog: join(root, "t.jsonl"), chunksLog: join(root, "c.jsonl"), sessionsLog: join(root, "s.jsonl"), activitiesLog: join(root, "a.jsonl"), reportFile: join(root, "report.md") } as never)({ on: () => {}, registerCommand: () => {}, registerTool: (definition: never) => tools.set((definition as { name: string }).name, definition) } as never);
  expect([...tools.keys()].sort()).toEqual(["gigtime_note", "gigtime_report"]);
});
