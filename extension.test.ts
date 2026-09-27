import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTimeTrackingExtension, type TimeTrackingOptions } from "./extension";
import { readChunks, readTurnRecords, readWorkSessions } from "./ledger";
import { reconcileIntervals } from "./native";

function harness(root: string, options: TimeTrackingOptions) {
  const events = new Map<string, (event: any, ctx: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => void }>();
  const pi = {
    on: (name: string, handler: (event: any, ctx: unknown) => void) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => void }) => commands.set(name, command),
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  createTimeTrackingExtension(root, options)(pi);
  return { events, commands };
}

test("records turns, deduplicates concurrent tabs by interval union, and supports the /work commands", () => {
  const root = mkdtempSync(join(tmpdir(), "worktime-ext-"));
  const logs = {
    turnsLog: join(root, "t.jsonl"), chunksLog: join(root, "c.jsonl"),
    sessionsLog: join(root, "s.jsonl"), reportFile: join(root, "report.md"),
  };
  let clock = 1_000_000;
  const options: TimeTrackingOptions = {
    ...logs, scopePrefix: "test", commandPrefix: "work", databasePath: join(root, "auto.sqlite"),
    timezones: ["Asia/Manila"], legacyCommandNames: ["legacy-time"], now: () => clock,
  };
  const a = harness(root, options);
  const b = harness(root, options);
  const notices: string[] = [];
  const ctx = { cwd: root, mode: "tui", ui: { notify: (message: string) => notices.push(message), setStatus: () => {} } };
  const emit = (h: ReturnType<typeof harness>, name: string, at: number, context: object = ctx, event: object = {}) => {
    clock = at;
    const handler = h.events.get(name);
    if (!handler) throw new Error(`Event not registered: ${name}`);
    handler(event, context);
  };

  // wrong-workspace runs stay inert
  emit(a, "session_start", 1_000_000, { ...ctx, cwd: tmpdir() });
  emit(a, "agent_start", 1_000_000, { ...ctx, cwd: tmpdir() });
  emit(a, "agent_settled", 1_100_000, { ...ctx, cwd: tmpdir() });
  expect(readTurnRecords(logs.turnsLog)).toHaveLength(0);
  expect(readChunks(logs.chunksLog)).toHaveLength(0);

  // a settled turn records a summary plus interval evidence that sums to the same time
  emit(a, "session_start", 1_000_000);
  emit(a, "agent_start", 1_000_000);
  emit(a, "message_update", 1_060_000);
  emit(a, "agent_settled", 1_120_000);
  expect(readTurnRecords(logs.turnsLog)).toHaveLength(1);
  expect(readTurnRecords(logs.turnsLog)[0].observedMs).toBe(120_000);
  expect(readChunks(logs.chunksLog).reduce((s, c) => s + c.ms, 0)).toBe(120_000);

  // concurrent tabs overlap; only the interval union is meaningful
  emit(a, "agent_start", 2_000_000); emit(b, "agent_start", 2_060_000);
  emit(a, "message_update", 2_300_000); emit(b, "tool_execution_end", 2_200_000);
  emit(a, "agent_settled", 2_400_000); emit(b, "agent_settled", 2_500_000);
  const [unionMs] = reconcileIntervals([readChunks(logs.chunksLog).map(c => ({ start: Date.parse(c.start), end: Date.parse(c.end) }))]);
  const rawMs = readTurnRecords(logs.turnsLog).reduce((s, t) => s + t.observedMs, 0);
  expect(unionMs).toBe(620_000);
  expect(rawMs).toBe(960_000);

  // waiting on a blocking prompt is excluded
  emit(a, "agent_start", 4_000_000);
  emit(a, "message_update", 4_060_000);
  emit(a, "ui_prompt_start", 4_100_000);
  emit(a, "ui_prompt_end", 9_000_000);
  emit(a, "agent_settled", 9_050_000);
  expect(readTurnRecords(logs.turnsLog).at(-1)!.observedMs).toBe(150_000);

  // user-attested sessions and commands
  const work = a.commands.get("work")!;
  expect(a.commands.has("legacy-time")).toBe(true);
  work.handler("start pricing page", ctx);
  clock += 3_600_000;
  work.handler("stop wrapping up", ctx);
  const sessions = readWorkSessions(logs.sessionsLog);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].label).toBe("pricing page");
  expect(sessions[0].endedAt! - sessions[0].startedAt).toBe(3_600_000);

  work.handler("time", ctx);
  expect(notices.at(-1)).toContain("settled Pi turns");
  expect(notices.at(-1)).toContain("working hours");

  work.handler("report", ctx);
  expect(existsSync(logs.reportFile)).toBe(true);
  const reportText = readFileSync(logs.reportFile, "utf8");
  expect(reportText).toContain("user-attested 1.00 h");
  expect(reportText).toContain("tracked working hours");
  expect(reportText).toContain("wall-clock union");
  expect(reportText).toContain("legacy pre-chunk turns");
  expect(reportText).toContain("Labels (tracked, draft)");
  expect(notices.at(-1)).toContain("Full draft");

  // commands outside the workspace root stay inert
  work.handler("start stray", { ...ctx, cwd: tmpdir() });
  expect(readWorkSessions(logs.sessionsLog)).toHaveLength(1);
});

test("labels each turn from the request text, with tool names as fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "worktime-labels-"));
  const logs = {
    turnsLog: join(root, "t.jsonl"), chunksLog: join(root, "c.jsonl"),
    sessionsLog: join(root, "s.jsonl"), reportFile: join(root, "report.md"),
  };
  let clock = 1_000_000;
  const options: TimeTrackingOptions = { ...logs, scopePrefix: "test", databasePath: join(root, "auto.sqlite"), timezones: ["Asia/Manila"], now: () => clock };
  const a = harness(root, options);
  const notices: string[] = [];
  const ctx = { cwd: root, mode: "tui", ui: { notify: (message: string) => notices.push(message), setStatus: () => {} } };
  const emit = (name: string, at: number, event: object = {}) => {
    clock = at;
    a.events.get(name)!(event, ctx);
  };

  emit("session_start", 1_000_000);
  emit("before_agent_start", 1_000_000, { prompt: "can we improve this tracker thing so we do not do this again" });
  emit("agent_start", 1_000_000);
  emit("message_update", 1_060_000);
  emit("tool_execution_end", 1_180_000);
  emit("agent_settled", 1_300_000);
  const first = readTurnRecords(logs.turnsLog).at(-1)!;
  expect(first.label).toBe("time-tracking");
  expect(first.labelSource).toBe("prompt");

  emit("before_agent_start", 2_000_000, { prompt: "please proceed with the pass" });
  emit("agent_start", 2_000_000);
  emit("tool_execution_start", 2_060_000, { toolName: "posthog.query" });
  emit("agent_settled", 2_120_000);
  const second = readTurnRecords(logs.turnsLog).at(-1)!;
  expect(second.label).toBe("analytics");
  expect(second.labelSource).toBe("tools");

  // session clock labels normalize to registry keys
  a.commands.get("work")!.handler("start design system buttons", ctx);
  expect(readWorkSessions(logs.sessionsLog).at(-1)!.label).toBe("design-system");

  a.commands.get("work")!.handler("report", ctx);
  const reportText = readFileSync(logs.reportFile, "utf8");
  expect(reportText).toContain("Labels (tracked, draft)");
  expect(reportText).toContain("time-tracking 0.08 h");
  expect(reportText).toContain("analytics 0.02 h");
  expect(reportText).toContain("unlabeled 0.02 h");
});
