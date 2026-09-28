import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticClock, DEFAULT_IDLE_GAP_MS, isHumanInput } from "./automatic";
import { ProjectStore, type Workspace } from "./project-store";

const roots: string[] = [];
const stores = new Set<ProjectStore>();
const openStore = (path: string) => { const store = new ProjectStore(path); stores.add(store); return store; };
const closeStore = (store: ProjectStore) => { store.close(); stores.delete(store); };
afterAll(() => {
  try { for (const store of stores) store.close(); }
  finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "automatic-clock-"));
  roots.push(root);
  const path = join(root, "tracker.sqlite");
  const store = openStore(path);
  const ws: Workspace = { root, client: "Coral" };
  return { path, store, ws };
}

test("classifies key presence without treating terminal replies as work", () => {
  expect(isHumanInput("a")).toBe(true);
  expect(isHumanInput("\r")).toBe(true);
  expect(isHumanInput("hello typed text")).toBe(true);
  expect(isHumanInput("\x1b[200~pasted content\x1b[201~")).toBe(true);
  expect(isHumanInput("")).toBe(false);
  expect(isHumanInput("\x1b[I")).toBe(false);
  expect(isHumanInput("\x1b[O")).toBe(false);
  expect(isHumanInput("\x1b[<0;12;3M")).toBe(false);
  expect(isHumanInput("\x1b]52;c:aGVsbG8\x07")).toBe(false);
  expect(isHumanInput("\x1b[?1;2c")).toBe(false);
  expect(DEFAULT_IDLE_GAP_MS).toBe(15 * 60_000);
});

test("first signal opens a zero-length window, short gaps join, long gaps become excluded evidence", () => {
  const { store, ws } = fixture();
  const clock = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  clock.touch(1_000);
  clock.touch(1_500);
  clock.flush();
  clock.touch(301_500); // a five-minute review gap joins
  clock.flush();
  let rows = store.windows(ws.root);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "work", start: 1_000, end: 301_500, client: "Coral", task: "invoices", sessionId: "sess-1" });
  clock.touch(1_501_500); // twenty minutes later: excluded, not counted
  clock.touch(1_506_500);
  clock.flush();
  rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ kind: "gap", start: 301_500, end: 1_501_500 });
  expect(rows[2]).toMatchObject({ kind: "work", start: 1_501_500, end: 1_506_500 });
  clock.touch(1_400_000); // a backward clock never manufactures time
  clock.flush();
  rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[2]).toMatchObject({ kind: "work", start: 1_501_500, end: 1_506_500 });
});

test("a restored clock continues a live session but never counts idle session lifetime", () => {
  const { store, path, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  closeStore(store);
  const reopened = openStore(path);
  const resumed = new AutomaticClock(reopened, ws, "sess-1", "invoices", 900_000);
  resumed.touch(402_000); resumed.flush();
  let rows = reopened.windows(ws.root);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ start: 2_000, end: 402_000 });
  const later = new AutomaticClock(reopened, ws, "sess-1", "invoices", 900_000);
  later.touch(2_402_000); later.flush();
  rows = reopened.windows(ws.root);
  expect(rows).toHaveLength(4);
  expect(rows[2]).toMatchObject({ kind: "gap", start: 402_000, end: 2_402_000 });
  expect(rows[3]).toMatchObject({ kind: "work", start: 2_402_000, end: 2_402_000 });
  closeStore(reopened);
});

test("a backward checkpoint flushes pending forward evidence without accepting regressed time", () => {
  const { store, ws } = fixture();
  const clock = new AutomaticClock(store, ws, "sess", "task");
  clock.touch(10_000);
  clock.touch(15_000);
  expect(store.latest(ws.root, "sess")?.end).toBe(10_000);
  clock.touch(1_000, true);
  expect(store.latest(ws.root, "sess")).toMatchObject({ start: 10_000, end: 15_000 });
  const restored = new AutomaticClock(store, ws, "sess", "task");
  restored.touch(0, true); restored.flush();
  expect(store.windows(ws.root)).toHaveLength(1);
  expect(store.latest(ws.root, "sess")?.end).toBe(15_000);
});

for (const change of ["client", "task"] as const) test(`long quiet gaps survive a ${change} change`, () => {
  const { store, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess", "old task", 10_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  const switched = new AutomaticClock(store, change === "client" ? { ...ws, client: "Other" } : ws, "sess", change === "task" ? "new task" : "old task", 10_000);
  switched.touch(20_000, true);
  const rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ kind: "gap", client: "Coral", task: "old task", start: 2_000, end: 20_000 });
  expect(rows[2]).toMatchObject({ kind: "work", client: change === "client" ? "Other" : "Coral", task: change === "task" ? "new task" : "old task", start: 20_000, end: 20_000 });
});

test("client or task changes open a fresh window and never reattribute recorded rows", () => {
  const { store, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  const switched = new AutomaticClock(store, ws, "sess-1", "onboarding", 900_000);
  switched.touch(60_000); switched.flush();
  const relabeled = new AutomaticClock(store, { ...ws, client: "Other" }, "sess-1", "onboarding", 900_000);
  relabeled.touch(61_000); relabeled.touch(62_000); relabeled.flush();
  const rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ task: "invoices", end: 2_000 });
  expect(rows[1]).toMatchObject({ client: "Coral", task: "onboarding", start: 60_000, end: 60_000 });
  expect(rows[2]).toMatchObject({ client: "Other", task: "onboarding", start: 61_000, end: 62_000 });
  expect(() => new AutomaticClock(store, ws, "sess-1", "task", 0)).toThrow("positive integer");
});
