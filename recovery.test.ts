import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimeTrackingExtension } from "./extension";
import { Turn, appendJsonl, readChunks, readTurnRecords, inspectJsonl, splitIntervalByLocalDay } from "./ledger";
import { appendActivity, readActivities } from "./activities";
import { buildWorkReport } from "./report";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worktime-recovery-"));
  const options = { root, scopePrefix: "test", timezones: ["America/Los_Angeles", "Asia/Manila"], now: Date.parse("2026-09-27T12:00:00Z"), sinceDay: null, databasePath: join(root, "db.sqlite"), turnsLog: join(root, "turns"), chunksLog: join(root, "chunks"), sessionsLog: join(root, "sessions"), activitiesLog: join(root, "notes") };
  return options;
}

test("append after a torn JSONL tail preserves the next complete record and reports the damaged line", () => {
  const f = fixture(); writeFileSync(f.turnsLog, '{"version":1', { mode: 0o644 });
  const turn = new Turn("test-pi-turn", () => {}, 0); const record = turn.settle(2000)!;
  appendJsonl(f.turnsLog, record);
  expect(readTurnRecords(f.turnsLog)).toEqual([record]); expect(inspectJsonl(f.turnsLog).malformedLines).toBe(1);
  expect(readFileSync(f.turnsLog, "utf8").startsWith('{"version":1\n')).toBe(true);
  expect(statSync(f.turnsLog).mode & 0o777).toBe(0o600);
});

test("backward settlement clocks do not invalidate already-observed duration", () => {
  const f = fixture(); const turn = new Turn("test-pi-turn", c => appendJsonl(f.chunksLog, c), 1000);
  turn.event(61000); const record = turn.settle(5000)!; appendJsonl(f.turnsLog, record);
  expect(record.endedAt).toBe(new Date(61000).toISOString()); expect(readTurnRecords(f.turnsLog)[0].observedMs).toBe(60000);
});

test("nested prompts, session replacement and workspace escapes never add waiting time", async () => {
  const f = fixture(); let now = 1000; const events = new Map<string, any>(); const commands = new Map<string, any>();
  const ctx = { cwd: f.root, mode: "json", sessionManager: { getSessionId: () => "s1" }, ui: { notify: () => {}, setStatus: () => {} } };
  createTimeTrackingExtension(f.root, { ...f, now: () => now })({ on: (n: string, h: any) => events.set(n, h), registerTool: () => {}, registerCommand: (n: string, h: any) => commands.set(n, h) } as any);
  const event = (name: string, at: number, data: any = {}) => { now = at; return events.get(name)(data, ctx); };
  event("session_start", 1000); expect(statSync(f.databasePath).mode & 0o777).toBe(0o600);
  event("before_agent_start", 1000, { prompt: "Reddit research" }); event("agent_start", 1000);
  event("ui_prompt_start", 2000); event("ui_prompt_start", 3000); event("ui_prompt_end", 300000); event("message_update", 350000); event("ui_prompt_end", 400000); event("message_update", 402000);
  event("session_before_switch", 900000);
  event("session_shutdown", 900000); // only a confirmed replacement tears down the runtime
  expect(readTurnRecords(f.turnsLog)[0].observedMs).toBe(3000); expect(readTurnRecords(f.turnsLog)[0].outcome).toBe("interrupted");
  event("session_start", 1000000); event("agent_start", 1000000); event("message_update", 1001000);
  ctx.cwd = tmpdir(); event("message_update", 1100000); event("agent_settled", 1200000);
  expect(readTurnRecords(f.turnsLog)[1].observedMs).toBe(1000);
  ctx.cwd = f.root; const outside = mkdtempSync(join(tmpdir(), "worktime-outside-")); symlinkSync(outside, join(f.root, "escape")); ctx.cwd = join(f.root, "escape");
  event("agent_start", 1300000); event("agent_settled", 1400000); expect(readTurnRecords(f.turnsLog)).toHaveLength(2);
  ctx.cwd = f.root; await commands.get("work").handler("report 2026-02-31", ctx);
});

test("notes are idempotent, sanitized, scoped and cannot add a duration", () => {
  const f = fixture(); const context = { callId: "note-1", scope: "test-activity", at: f.now, sessionId: "s1" };
  const input = { label: "reddit", summary: "Checked the existing comment permalink", status: "verified" as const, evidence: ["https://www.reddit.com/r/example/comments/abc/"] };
  appendActivity(f.activitiesLog, input, context); appendActivity(f.activitiesLog, input, context);
  expect(readActivities(f.activitiesLog)).toHaveLength(1); expect(readFileSync(f.activitiesLog, "utf8")).not.toContain("observedMs");
  expect(() => appendActivity(f.activitiesLog, { ...input, summary: "Contact person@example.com" }, context)).toThrow("Remove email");
  expect(() => appendActivity(f.activitiesLog, { ...input, evidence: ["https://example.com/?token=secret"] }, context)).toThrow();
  const report = buildWorkReport(f).text;
  expect(report).toContain("duration Unallocated"); expect(report).toContain("Unknown (no interval evidence)");
});

test("report detects partially lost checkpoints, deduplicates intervals and excludes foreign scopes", () => {
  const f = fixture();
  appendJsonl(f.turnsLog, { version: 1, intervalVersion: 2, id: "partial", scope: "test-pi-turn", startedAt: "2026-09-27T00:00:00Z", endedAt: "2026-09-27T00:02:00Z", observedMs: 120000, outcome: "settled", label: "reddit" });
  const chunk = { version: 2, turnId: "partial", scope: "test-pi-turn", start: "2026-09-27T00:00:00Z", end: "2026-09-27T00:01:00Z", ms: 60000, capped: false };
  appendJsonl(f.chunksLog, chunk); appendJsonl(f.chunksLog, chunk);
  appendJsonl(f.chunksLog, { ...chunk, turnId: "foreign", scope: "other-pi-turn" });
  appendJsonl(f.chunksLog, { ...chunk, turnId: "invalid", ms: 999999 });
  const report = buildWorkReport(f).text;
  expect(report).toContain("Interval mismatch for turn partial: summary 2.0 min, durable intervals 1.0 min");
  expect(report).toContain("Legacy aggregate records: 0"); expect(report).not.toContain("foreign"); expect(report).toContain("invalid turn/interval records: 1");
  expect(readChunks(f.chunksLog)).toHaveLength(3);
});

test("calendar splitting preserves short and long DST days", () => {
  const spring = splitIntervalByLocalDay(Date.parse("2026-03-08T08:00:00Z"), Date.parse("2026-03-09T07:00:00Z"), "America/Los_Angeles");
  expect(spring).toEqual([{ day: "2026-03-08", ms: 23 * 3600000 }]);
  const fall = splitIntervalByLocalDay(Date.parse("2026-11-01T07:00:00Z"), Date.parse("2026-11-02T08:00:00Z"), "America/Los_Angeles");
  expect(fall).toEqual([{ day: "2026-11-01", ms: 25 * 3600000 }]);
});
