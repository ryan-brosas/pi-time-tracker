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
    else expect(report.text).toContain("### 2026-09-27\n\n- Tracked working hours: 1.00 h.");
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

test("report headers sanitize configurable paths without adding lines or markup", () => {
  const f = fixture(), scope = "/tmp/one\r\n<two>|`db`";
  const reports = [
    buildWorkReport({ ...f, root: scope }),
    buildAutomaticReport({ ...f, windows: [], idleGapMs: 900_000, scope }),
  ];
  for (const report of reports) {
    expect(report.text.split("\n")[2]).toEndWith("/tmp/one  twodb");
    expect(report.text).not.toContain(scope);
  }
});

test("excluded gaps are chronological in both reports and identify their workspace in shared reports", () => {
  const f = fixture();
  const early = { ...window("2026-09-27T09:00:00Z", "2026-09-27T10:00:00Z", "gap"), root: "/a|`client`" };
  const late = { ...window("2026-09-27T11:00:00Z", "2026-09-27T12:00:00Z", "gap"), root: "/b\nclient" };
  const tied = { ...early, root: "/z-client" };
  const windows = [late, tied, early];
  const opts = { ...f, windows, idleGapMs: 900_000, scope: f.root };
  const local = buildWorkReport({ ...f, automatic: { windows, idleGapMs: opts.idleGapMs } });
  const all = buildAutomaticReport(opts);
  const gapLines = (text: string) => text.split("\n").filter(line => line.startsWith("- Excluded quiet gap"));
  for (const report of [local, all]) {
    const lines = gapLines(report.text);
    expect(lines).toHaveLength(3);
    expect(lines.map(line => line.split(" · ")[0])).toEqual([
      "- Excluded quiet gap 09:00:00 to 10:00:00",
      "- Excluded quiet gap 09:00:00 to 10:00:00",
      "- Excluded quiet gap 11:00:00 to 12:00:00",
    ]);
    expect(report.summary).toContain("inferred elapsed work Unknown");
  }
  expect(gapLines(all.text)).toEqual([
    "- Excluded quiet gap 09:00:00 to 10:00:00 · 1.00 h · workspace /aclient · Unknown; review before invoicing.",
    "- Excluded quiet gap 09:00:00 to 10:00:00 · 1.00 h · workspace /z-client · Unknown; review before invoicing.",
    "- Excluded quiet gap 11:00:00 to 12:00:00 · 1.00 h · workspace /b client · Unknown; review before invoicing.",
  ]);
  expect(buildAutomaticReport({ ...opts, windows: [...windows].reverse() }).text).toBe(all.text);
  expect(windows).toEqual([late, tied, early]);
});

test("work-report summary uses consistent Unknown measures", () => {
  const f = fixture();
  const report = buildWorkReport({ ...f, automatic: { windows: [], idleGapMs: 900_000 } });
  expect(report.summary).toBe("UTC: user-attested Unknown; tracked working hours Unknown; inferred elapsed work Unknown");
});

test("both report paths preserve native union totals across short and long DST days", () => {
  const f = fixture();
  for (const [start, end, expected] of [
    ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", "23.00 h"],
    ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", "25.00 h"],
  ]) {
    const w = window(start, end), windows = [w, { ...w, id: "concurrent", sessionId: "other" }];
    const opts = { ...f, timezones: ["America/Los_Angeles"], idleGapMs: 900_000 };
    const local = buildWorkReport({ ...opts, automatic: { windows, idleGapMs: opts.idleGapMs } });
    const all = buildAutomaticReport({ ...opts, windows, scope: f.root });
    for (const report of [local, all]) {
      expect(report.summary).toContain(`inferred elapsed work ${expected}`);
      expect(report.text.split("\n").filter(line => line.startsWith("### "))).toEqual([`### ${start.slice(0, 10)}`]);
    }
    expect(local.text).toContain(`- Inferred work union: ${expected} (concurrent sessions counted once).`);
    expect(all.text).toContain(`### ${start.slice(0, 10)}\n\n- Inferred elapsed work (union): ${expected}.`);
  }
});
