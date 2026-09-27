import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readTurnRecords, type TimeRecord, type TurnChunk } from "./ledger";
import { auditTurnReceipts, nativeExecutable } from "./native";
import { buildWorkReport } from "./report";

const summary = (id: string, observedMs = 60000, modern = true): TimeRecord => ({ version: 1, id, scope: "test-pi-turn", startedAt: "2026-09-27T00:00:00Z", endedAt: "2026-09-27T00:02:00Z", observedMs, outcome: "settled", label: "reddit", ...(modern ? { intervalVersion: 2 as const } : {}) });
const chunk = (id: string): TurnChunk => ({ version: 2, turnId: id, scope: "test-pi-turn", start: "2026-09-27T00:00:00Z", end: "2026-09-27T00:01:00Z", ms: 60000, capped: false });

test("native Bend classifies receipt coverage without making legacy or missing evidence zero hours", () => {
  const rows = [summary("ok"), summary("old", 60000, false), summary("lost"), summary("partial", 120000), summary("conflict"), summary("conflict", 120000)];
  const audited = auditTurnReceipts(rows, [chunk("ok"), chunk("partial"), chunk("orphan"), chunk("conflict")]);
  expect(Object.fromEntries([...audited].map(([id, r]) => [id, r.status]))).toEqual({ ok: "consistent", old: "legacy", lost: "missing", partial: "mismatch", conflict: "conflict", orphan: "checkpoint-only" });
  expect(audited.get("orphan")?.summaryCopies).toBe(0);
  expect(audited.get("conflict")?.durableMs).toBe(60000);
});

test("exact duplicate summaries are idempotent but metadata conflicts cannot silently choose the last writer", () => {
  const s = summary("same");
  const exact = auditTurnReceipts([s, { ...s }], [chunk("same"), chunk("same")]).get("same")!;
  expect(exact).toEqual({ status: "consistent", durableMs: 60000, summaryCopies: 2 });
  for (const changed of [{ ...s, label: "analytics" }, { ...s, outcome: "interrupted" as const }, { ...s, intervalVersion: undefined }]) {
    for (const rows of [[s, changed], [changed, s]]) expect(auditTurnReceipts(rows, [chunk("same")]).get("same")?.status).toBe("conflict");
  }
});

test("report surfaces conflicting receipts and excludes their ambiguous legacy amounts and label fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "worktime-audit-report-"));
  const opts = { root, scopePrefix: "test", timezones: ["Asia/Manila"], now: Date.parse("2026-09-27T12:00:00Z"), sinceDay: null, turnsLog: join(root, "turns"), chunksLog: join(root, "chunks"), sessionsLog: join(root, "sessions"), activitiesLog: join(root, "notes") };
  appendJsonl(opts.turnsLog, summary("duplicate", 60000, false));
  appendJsonl(opts.turnsLog, { ...summary("duplicate", 120000, false), label: "analytics" });
  appendJsonl(opts.turnsLog, summary("paired"));
  appendJsonl(opts.turnsLog, { ...summary("paired"), label: "analytics" });
  appendJsonl(opts.chunksLog, chunk("paired"));
  const report = buildWorkReport(opts).text;
  expect(report).toContain("Conflicting summaries for turn duplicate");
  expect(report).toContain("Conflicting summaries for turn paired");
  expect(report).toContain("Legacy aggregate records: 0");
  expect(report).toContain("unlabeled");
  expect(report).not.toContain("analytics 0.02 h");
});

test("native audit rejects malformed flags and empty evidence; old interval mode still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-audit-protocol-"));
  try {
    const input = join(dir, "input");
    for (const row of ["0,0,0,2,0,0,0", "0,0,0,1,1,2,0", "0,0,0,0,0,0,0", "0,2,0,1,1,1,0", "0,1,1,0,5,0,0", "0,0,0,1,0.5,1,0"]) {
      writeFileSync(input, row, { mode: 0o600 });
      const result = spawnSync(nativeExecutable(), ["--threads", "1", "--", input, "audit"], { encoding: "utf8", timeout: 10000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("Invalid receipt audit batch");
    }
    writeFileSync(input, "0,1,5\n0,3,7");
    const old = spawnSync(nativeExecutable(), ["--threads", "1", "--", input], { encoding: "utf8", timeout: 10000 });
    expect(old.status).toBe(0); expect(old.stdout).toBe("worktime-v1\n0,6\n");
    expect(() => auditTurnReceipts([summary("scope")], [{ ...chunk("scope"), scope: "foreign-pi-turn" }])).toThrow("one turn scope");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported interval markers and fractional milliseconds are rejected, not silently treated as legacy", () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-audit-schema-")), log = join(dir, "turns");
  try {
    appendJsonl(log, { ...summary("future"), intervalVersion: 3 });
    appendJsonl(log, { ...summary("fraction"), observedMs: 0.5 });
    expect(readTurnRecords(log)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changing an imported Bend policy module invalidates the compiled engine cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-audit-cache-"));
  try {
    for (const file of ["native.ts", "engine.bend", "audit.bend"]) copyFileSync(join(import.meta.dir, file), join(dir, file));
    const cloned = await import(join(dir, "native.ts"));
    const options = { cacheDir: join(dir, "cache") };
    const first = cloned.nativeExecutable(options);
    appendFileSync(join(dir, "audit.bend"), "\n# cache invalidation regression\n");
    const second = cloned.nativeExecutable(options);
    expect(second).not.toBe(first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
