import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("package manifest loads through Pi/Jiti and registers its public integration points", async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-time-tracker-loader-"));
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(manifest.name).toBe("pi-time-tracker");
  const paths = manifest.pi.extensions.map((p: string) => resolve(import.meta.dir, p));
  const dbPath = join(project, "tracker.sqlite");
  const previousDb = process.env.WORKTIME_DB_PATH;
  process.env.WORKTIME_DB_PATH = dbPath;
  try {
    const loaded = await loadExtensions(paths, project);
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions[0];
    expect([...extension.tools.keys()]).toContain("work_note");
    expect([...extension.commands.keys()]).toEqual(["work", "project"]);
    for (const event of ["session_start", "input", "before_agent_start", "agent_start", "message_update", "tool_execution_start", "tool_execution_end", "ui_prompt_start", "ui_prompt_end", "agent_settled", "session_before_switch", "session_shutdown"]) expect(extension.handlers.has(event)).toBe(true);
    expect(existsSync(dbPath)).toBe(false); // loading registers handlers but never opens the shared database
  } finally {
    if (previousDb === undefined) delete process.env.WORKTIME_DB_PATH; else process.env.WORKTIME_DB_PATH = previousDb;
    rmSync(project, { recursive: true, force: true });
  }
});
