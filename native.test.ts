import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeExecutable, reconcileIntervals } from "./native";

test("actual native Bend deduplicates nested, touching and unsorted intervals at epoch precision", () => {
  const epoch = Date.parse("2026-09-27T00:00:00Z");
  expect(reconcileIntervals([
    [{ start: 5, end: 20 }, { start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, { start: 20, end: 25 }],
    [{ start: epoch, end: epoch + 60_000 }, { start: epoch + 20_000, end: epoch + 80_000 }],
    [], [{ start: 2 ** 48 - 10, end: 2 ** 48 - 1 }], [{ start: 0, end: 0 }],
  ])).toEqual([35, 80_000, 0, 9, 0]);
}, 90_000);

test("native reducer agrees with a seeded discrete-time coverage oracle", () => {
  let seed = 73;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const groups = Array.from({ length: 50 }, () => Array.from({ length: 35 }, () => { const start = random() % 200; return { start, end: start + random() % 35 }; }));
  const expected = groups.map(ivs => { const covered = new Set<number>(); for (const iv of ivs) for (let t = iv.start; t < iv.end; t++) covered.add(t); return covered.size; });
  expect(reconcileIntervals(groups)).toEqual(expected);
});

test("Bend rejects malformed transport and the bridge fails explicitly without a native executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-bend-test-"));
  try {
    const file = join(dir, "input");
    for (const input of ["0,20,10", "0,-1,20", "0,1,2,3", "secret,1,2", "0,1,281474976710656"]) {
      writeFileSync(file, input, { mode: 0o600 });
      const r = spawnSync(nativeExecutable(), ["--threads", "1", "--", file], { encoding: "utf8", timeout: 10_000 });
      expect(r.status).not.toBe(0); expect(r.stderr + r.stdout).not.toContain(input);
    }
    expect(() => reconcileIntervals([[{ start: 0, end: 10 }]], { nativeExecutable: join(dir, "missing") })).toThrow("Bend reconciliation failed");
    expect(() => reconcileIntervals([[{ start: 0, end: 2 ** 48 }]])).toThrow("Invalid interval bounds");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
