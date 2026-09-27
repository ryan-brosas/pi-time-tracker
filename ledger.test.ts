import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_UNOBSERVED_MS, Turn, appendJsonl, localDayKey,
  readChunks, readTurnRecords, readWorkSessions,
  splitIntervalByLocalDay, type TurnChunk,
} from "./ledger";

test("interval evidence mirrors counted time, including one capped silent gap", () => {
  const chunks: TurnChunk[] = [];
  const turn = new Turn("test-pi-turn", c => chunks.push(c), 1_000);
  turn.event(61_000);
  turn.event(61_000 + 40 * 60_000); // 40 min silent gap, capped
  turn.event(61_000 + 40 * 60_000 + 5_000);
  const record = turn.settle(61_000 + 40 * 60_000 + 15_000)!;
  expect(record.observedMs).toBe(60_000 + MAX_UNOBSERVED_MS + 5_000 + 10_000);
  expect(chunks.reduce((s, c) => s + c.ms, 0)).toBe(record.observedMs);
  const capped = chunks.find(c => c.capped)!;
  expect(capped.end).toBe(new Date(61_000 + MAX_UNOBSERVED_MS).toISOString());
  expect(record.scope).toBe("test-pi-turn");
});

test("pause excludes waiting time; interrupt truncates at the last event", () => {
  const chunks: TurnChunk[] = [];
  const turn = new Turn("test-pi-turn", c => chunks.push(c), 0);
  turn.event(1_000);
  turn.pause(61_000);
  turn.resume(3_600_000);
  turn.event(3_605_000);
  const record = turn.interrupt(9_999_999)!;
  expect(record.observedMs).toBe(66_000);
  expect(record.outcome).toBe("interrupted");
  expect(record.endedAt).toBe(new Date(3_605_000).toISOString());
  expect(chunks.map(c => [c.start, c.end])).toEqual([
    [new Date(0).toISOString(), new Date(61_000).toISOString()],
    [new Date(3_600_000).toISOString(), new Date(3_605_000).toISOString()],
  ]);
});

test("sub-second turns emit no record, and backward clocks add nothing", () => {
  const chunks: TurnChunk[] = [];
  const turn = new Turn("test-pi-turn", c => chunks.push(c), 5_000);
  turn.event(5_000);
  turn.event(4_000); // clock moved backwards
  expect(turn.settle(5_500)).toBeNull();
  expect(chunks.map(c => c.ms)).toEqual([500]);
});

test("persists private append-only records and readers round-trip, including an open session", () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-"));
  const turnsPath = join(dir, "pi-worktime.jsonl");
  const chunksPath = join(dir, "pi-worktime-chunks.jsonl");
  const sessionsPath = join(dir, "work-sessions.jsonl");
  const sinkChunks: TurnChunk[] = [];
  const turn = new Turn("test-pi-turn", c => { sinkChunks.push(c); appendJsonl(chunksPath, c); }, 0);
  turn.event(90_000);
  const record = turn.settle(120_000)!;
  appendJsonl(turnsPath, record);
  appendJsonl(sessionsPath, { version: 1, kind: "session-start", id: "s1", at: new Date(0).toISOString(), scope: "test-user-session", label: "docs" });
  for (const p of [turnsPath, chunksPath, sessionsPath]) expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(readTurnRecords(turnsPath)).toEqual([record]);
  expect(readChunks(chunksPath)).toEqual(sinkChunks);
  expect(readWorkSessions(sessionsPath)).toEqual([{ id: "s1", label: "docs", startedAt: 0, endedAt: null, scope: "test-user-session" }]);
  appendJsonl(sessionsPath, { version: 1, kind: "session-stop", id: "s1", at: new Date(3_600_000).toISOString(), scope: "test-user-session" });
  expect(readWorkSessions(sessionsPath)[0].endedAt).toBe(3_600_000);
  appendJsonl(turnsPath, { nonsense: true });
  expect(readTurnRecords(turnsPath)).toHaveLength(1);
});

test("intervals split at local midnight", () => {
  const start = Date.UTC(2026, 8, 24, 6); // 2026-09-24 06:00Z
  expect(splitIntervalByLocalDay(start, start + 8 * 3_600_000, "America/Los_Angeles"))
    .toEqual([{ day: "2026-09-23", ms: 3_600_000 }, { day: "2026-09-24", ms: 7 * 3_600_000 }]);
  expect(localDayKey(start, "Asia/Manila")).toBe("2026-09-24");
});
