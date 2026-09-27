import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "./ledger";
import { buildAutomaticReport, buildWorkReport } from "./report";
import type { WorkWindow } from "./project-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worktime-report-")); roots.push(root);
  return { root, scopePrefix: "test", timezones: ["UTC"], now: Date.parse("2026-09-28T12:00:00Z"), sinceDay: null as string | null,
    turnsLog: join(root, "turns"), chunksLog: join(root, "chunks"), sessionsLog: join(root, "sessions"), activitiesLog: join(root, "notes") };
}
function window(start: string, end: string, kind: "work" | "gap" = "work"): WorkWindow {
  return { id: "window", root: "/client", client: "Coral", sessionId: "session", task: "invoices", start: Date.parse(start), end: Date.parse(end), kind };
}

test("all-dates agent total retains the scoped interval union even when the daily report is filtered", () => {
  const f = fixture();
  const chunk = { version: 2, turnId: "turn", scope: "test-pi-turn", start: "2026-09-27T00:00:00Z", end: "2026-09-27T01:00:00Z", ms: 3_600_000, capped: false };
  appendJsonl(f.chunksLog, chunk); appendJsonl(f.chunksLog, chunk);
  appendJsonl(f.chunksLog, { ...chunk, scope: "other-pi-turn", end: "2026-09-27T02:00:00Z", ms: 7_200_000 });
  for (const sinceDay of [null, "2026-09-28"]) {
    const report = buildWorkReport({ ...f, sinceDay });
    expect(report.text).toContain("all dates: 1.00 h");
    if (sinceDay) expect(report.text).not.toContain("### 2026-09-27");
  }
});

test("automatic summaries apply the since-day filter independently in each timezone", () => {
  const f = fixture();
  const windows = [window("2026-09-26T23:30:00Z", "2026-09-27T00:30:00Z")];
  const opts = { ...f, timezones: ["UTC", "Asia/Manila"], sinceDay: "2026-09-27", idleGapMs: 900_000 };
  const local = buildWorkReport({ ...opts, automatic: { windows, idleGapMs: opts.idleGapMs } });
  const all = buildAutomaticReport({ ...opts, windows, scope: f.root });
  for (const summary of [local.summary, all.summary]) {
    expect(summary.split(" | ")[0]).toContain("inferred elapsed work 0.50 h");
    expect(summary.split(" | ")[1]).toContain("inferred elapsed work 1.00 h");
  }
});

test("gap-only dates remain Unknown rather than becoming measured zero hours", () => {
  const f = fixture();
  const windows = [window("2026-09-27T10:00:00Z", "2026-09-27T11:00:00Z", "gap")];
  const report = buildAutomaticReport({ ...f, windows, idleGapMs: 900_000, scope: f.root });
  expect(report.text).toContain("Inferred elapsed work (union): Unknown (no interval evidence)");
  expect(report.summary).toContain("inferred elapsed work Unknown (no interval evidence)");
  expect(report.text).toContain("Excluded quiet gap");
});

test("both report paths preserve native union totals across short and long DST days", () => {
  const f = fixture();
  for (const [start, end, expected] of [
    ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", "23.00 h"],
    ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", "25.00 h"],
  ]) {
    const w = window(start, end), windows = [w, { ...w, id: "concurrent", sessionId: "other" }];
    const opts = { ...f, timezones: ["America/Los_Angeles"], idleGapMs: 900_000 };
    expect(buildWorkReport({ ...opts, automatic: { windows, idleGapMs: opts.idleGapMs } }).summary).toContain(`inferred elapsed work ${expected}`);
    expect(buildAutomaticReport({ ...opts, windows, scope: f.root }).summary).toContain(`inferred elapsed work ${expected}`);
  }
});
