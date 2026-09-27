import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("package manifest loads through Pi/Jiti and registers its public integration points", async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-time-tracker-loader-"));
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
    expect(manifest.name).toBe("pi-time-tracker");
    const paths = manifest.pi.extensions.map((p: string) => resolve(import.meta.dir, p));
    const loaded = await loadExtensions(paths, project);
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions[0];
    expect([...extension.tools.keys()]).toContain("work_note");
    expect([...extension.commands.keys()]).toEqual(["work"]);
    for (const event of ["session_start", "before_agent_start", "agent_start", "message_update", "tool_execution_start", "tool_execution_end", "ui_prompt_start", "ui_prompt_end", "agent_settled", "session_before_switch", "session_shutdown"]) expect(extension.handlers.has(event)).toBe(true);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
