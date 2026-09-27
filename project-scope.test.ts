import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimeTrackingExtension } from "./extension";
import { readTurnRecords } from "./ledger";

function host(factory: ReturnType<typeof createTimeTrackingExtension>, root: string) {
  const events = new Map<string, any>(), commands = new Map<string, any>();
  const notices: string[] = [];
  const ctx = { cwd: root, mode: "json", sessionManager: { getSessionId: () => root }, ui: { notify: (s: string) => notices.push(s), setStatus: () => {} } };
  factory({ on: (n: string, fn: any) => events.set(n, fn), registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: () => {} } as any);
  return { ctx, notices, events, commands, emit: (name: string, data: any = {}) => events.get(name)(data, ctx) };
}

test("default root comes from the Pi context and stays isolated across reused factories", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-time-tracker-scope-"));
  try {
    const aRoot = join(parent, "a"), bRoot = join(parent, "b"); mkdirSync(aRoot); mkdirSync(bRoot);
    let now = Date.parse("2026-09-27T00:00:00Z");
    const factory = createTimeTrackingExtension(undefined, { now: () => now, timezones: ["UTC"], databasePath: join(parent, "shared.sqlite") });
    const a = host(factory, aRoot), b = host(factory, bRoot);
    expect(existsSync(join(aRoot, "exports"))).toBe(false);
    a.emit("session_start"); b.emit("session_start");
    a.emit("agent_start"); b.emit("agent_start"); now += 60000;
    a.emit("agent_settled"); b.emit("agent_settled");
    for (const root of [aRoot, bRoot]) {
      const rows = readTurnRecords(join(root, "exports", "pi-worktime.jsonl"));
      expect(rows).toHaveLength(1); expect(rows[0].scope).toBe("work-pi-turn"); expect(rows[0].observedMs).toBe(60000);
    }
    mkdirSync(join(aRoot, "sub")); a.ctx.cwd = join(aRoot, "sub"); a.emit("agent_start"); now += 60000; a.emit("agent_settled");
    expect(readTurnRecords(join(aRoot, "exports", "pi-worktime.jsonl"))).toHaveLength(2);
    a.ctx.cwd = bRoot; a.emit("agent_start"); now += 60000; a.emit("agent_settled");
    expect(readTurnRecords(join(bRoot, "exports", "pi-worktime.jsonl"))).toHaveLength(1);
    a.ctx.cwd = aRoot; await a.commands.get("work").handler("report", a.ctx);
    expect(readFileSync(join(aRoot, "exports", "work-report.md"), "utf8")).toContain("native Bend");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("an explicit project adapter preserves scope, command aliases and timezones", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-time-tracker-adapter-"));
  try {
    let now = 1000;
    const h = host(createTimeTrackingExtension(root, { scopePrefix: "client", legacyCommandNames: ["client-time"], timezones: ["UTC"], now: () => now, databasePath: join(root, "db.sqlite") }), root);
    h.emit("session_start"); h.emit("agent_start"); now += 2000; h.emit("agent_settled");
    expect(h.commands.has("client-time")).toBe(true);
    expect(readTurnRecords(join(root, "exports", "pi-worktime.jsonl"))[0].scope).toBe("client-pi-turn");
    await h.commands.get("work").handler("report", h.ctx);
    expect(readFileSync(join(root, "exports", "work-report.md"), "utf8")).toContain("## UTC");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
