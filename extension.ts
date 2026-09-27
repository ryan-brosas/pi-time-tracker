import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SESSION_SCOPE_SUFFIX, TURN_SCOPE_SUFFIX, Turn, appendJsonl, readChunks, readTurnRecords, readWorkSessions, writeFilePrivate, type ActivityIdentity, type TurnChunk } from "./ledger.ts";
import { labelFor, resolveSessionLabel } from "./labels.ts";
import { appendActivity, workNoteParameters, type WorkNoteInput } from "./activities.ts";
import { buildWorkReport, hours, minutes } from "./report.ts";
import { reconcileIntervals, type NativeOptions } from "./native.ts";

export interface TimeTrackingOptions extends NativeOptions {
  scopePrefix?: string; commandPrefix?: string; legacyCommandNames?: string[]; timezones?: string[];
  turnsLog?: string; chunksLog?: string; sessionsLog?: string; activitiesLog?: string; reportFile?: string; now?: () => number;
}
type Ctx = { cwd: string; mode: string; sessionManager?: { getSessionId: () => string | null }; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void; setStatus: (key: string, text: string | undefined) => void } };

export function createTimeTrackingExtension(configuredRoot?: string, options: TimeTrackingOptions = {}) {
  const scopePrefix = options.scopePrefix ?? "work", command = options.commandPrefix ?? "work";
  const timezones = options.timezones ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
  const now = options.now ?? Date.now, turnScope = scopePrefix + TURN_SCOPE_SUFFIX, sessionScope = scopePrefix + SESSION_SCOPE_SUFFIX;
  const statusKey = command + "-time";
  return function (pi: ExtensionAPI) {
    // Bind to the host context, never the package checkout or process.cwd().
    // Keep this state per factory invocation so independent SDK sessions stay isolated.
    let root = "", turnsLog = "", chunksLog = "", sessionsLog = "", activitiesLog = "", reportFile = "";
    const bindRoot = (path: string) => {
      root = path;
      const exportsDir = join(root, "exports");
      turnsLog = options.turnsLog ?? join(exportsDir, "pi-worktime.jsonl");
      chunksLog = options.chunksLog ?? join(exportsDir, "pi-worktime-chunks.jsonl");
      sessionsLog = options.sessionsLog ?? join(exportsDir, "work-sessions.jsonl");
      activitiesLog = options.activitiesLog ?? join(exportsDir, "work-activities.jsonl");
      reportFile = options.reportFile ?? join(exportsDir, "work-report.md");
    };
    if (configuredRoot !== undefined) bindRoot(resolve(configuredRoot));
    const inScope = (cwd: string) => {
      try {
        const canonicalCwd = realpathSync(cwd);
        if (!root) bindRoot(canonicalCwd);
        const rel = relative(realpathSync(root), canonicalCwd);
        return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
      } catch { return false; }
    };
    let turn: Turn | undefined, chunkWriteFailed = false, promptDepth = 0;
    let requestLabel: ReturnType<typeof labelFor>, turnTools = new Set<string>();
    let sessionId: string = randomUUID();
    const identity = (): ActivityIdentity => {
      const label = requestLabel ?? labelFor(undefined, [...turnTools]);
      return { sessionId, label: label?.label ?? "unlabeled", ...(label ? { labelSource: label.source } : {}) };
    };
    const sink = (chunk: TurnChunk) => { try { appendJsonl(chunksLog, { ...chunk, ...identity() }); } catch { chunkWriteFailed = true; } };
    const warn = (ctx: Ctx, text: string) => { if (ctx.mode === "tui") ctx.ui.notify(text, "warning"); else console.error(text); };
    const close = (ctx: Ctx, outcome: "settled" | "interrupted") => {
      if (!turn) return;
      const current = turn; turn = undefined;
      const record = outcome === "settled" && inScope(ctx.cwd) ? current.settle(now()) : current.interrupt(now());
      if (record) {
        Object.assign(record, identity());
        try { appendJsonl(turnsLog, record); }
        catch { warn(ctx, `${scopePrefix} time: could not save the turn summary; check disk permissions`); }
        if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, `Pi turn: ${minutes(record.observedMs)} (${record.label ?? "unlabeled"}, working hours draft)`);
      }
      if (chunkWriteFailed) warn(ctx, `${scopePrefix} time: some activity intervals could not be saved; report coverage is incomplete`);
      chunkWriteFailed = false; promptDepth = 0; requestLabel = undefined; turnTools.clear();
    };
    const observe = (ctx: Ctx) => { if (turn) { if (inScope(ctx.cwd)) turn.event(now()); else close(ctx, "interrupted"); } };
    pi.on("session_start", (_event, ctx) => {
      close(ctx, "interrupted"); sessionId = ctx.sessionManager?.getSessionId() ?? randomUUID(); requestLabel = undefined;
      const scoped = inScope(ctx.cwd);
      if (ctx.mode === "tui" && scoped) ctx.ui.setStatus(statusKey, `Working hours tracked automatically; /${command} start logs a session clock`);
    });
    pi.on("session_before_switch", (_event, ctx) => { close(ctx, "interrupted"); });
    pi.on("before_agent_start", (event, ctx) => {
      if (!inScope(ctx.cwd)) return;
      // Classify immediately; never retain or persist the prompt text.
      if (turn) { turn.event(now()); turn.checkpoint(); }
      requestLabel = labelFor(event.prompt);
    });
    pi.on("agent_start", (_event, ctx) => {
      if (!inScope(ctx.cwd)) return;
      if (turn) turn.event(now());
      else { turnTools = new Set(); promptDepth = 0; sessionId = ctx.sessionManager?.getSessionId() ?? sessionId; turn = new Turn(turnScope, sink, now()); }
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, "Pi: tracking this turn");
    });
    pi.on("message_update", (_event, ctx) => observe(ctx));
    pi.on("tool_execution_start", (event, ctx) => {
      observe(ctx);
      if (inScope(ctx.cwd) && event.toolName) {
        const next = requestLabel ?? labelFor(undefined, [...turnTools, event.toolName]);
        if (next?.label !== identity().label) turn?.checkpoint();
        turnTools.add(event.toolName);
      }
    });
    pi.on("tool_execution_end", (_event, ctx) => observe(ctx));
    pi.on("ui_prompt_start", (_event, ctx) => { if (turn && inScope(ctx.cwd) && promptDepth++ === 0) turn.pause(now()); });
    pi.on("ui_prompt_end", (_event, ctx) => { if (turn && inScope(ctx.cwd) && promptDepth > 0 && --promptDepth === 0) turn.resume(now()); });
    pi.on("agent_settled", (_event, ctx) => close(ctx, "settled"));
    pi.on("session_shutdown", (_event, ctx) => close(ctx, "interrupted"));

    pi.registerTool({
      name: `${command}_note`, label: "Record work evidence",
      description: "Append one sanitized activity/outcome to the local work log. Never adds hours or writes external records.",
      promptSnippet: "Record a concise, timestamped work outcome with evidence and verification status.",
      promptGuidelines: [`For completed work milestones in this workspace, record a concise ${command}_note with the actual outcome and evidence. Keep draft, planned, user-reported, blocked and verified states distinct. Never include raw prompts, customer data, private messages or secrets. Notes do not estimate working hours.`],
      executionMode: "sequential",
      parameters: workNoteParameters,
      execute: async (callId, args, _signal, _update, ctx) => {
        if (!inScope(ctx.cwd)) throw new Error("Work notes are limited to this workspace");
        const context = { callId, scope: `${scopePrefix}-activity`, at: now(), sessionId: ctx.sessionManager?.getSessionId() ?? sessionId, ...(turn ? { turnId: turn.id } : {}) };
        const note = await withFileMutationQueue(activitiesLog, async () => appendActivity(activitiesLog, args as WorkNoteInput, context));
        return { content: [{ type: "text", text: `Recorded ${note.label}: ${note.summary} (${note.status}); duration Unallocated. No external sync.` }], details: { noteId: note.id } };
      },
    });
    const openSession = () => readWorkSessions(sessionsLog).find(s => s.scope === sessionScope && s.endedAt === null) ?? null;
    const subcommands: Record<string, (args: string, ctx: Ctx) => void> = {
      start: (args, ctx) => {
        const open = openSession();
        if (open) { ctx.ui.notify(`/${command}: a session is already open since ${new Date(open.startedAt).toISOString()}. Run /${command} stop first.`, "warning"); return; }
        const label = resolveSessionLabel(args), startedAt = now();
        appendJsonl(sessionsLog, { version: 1, kind: "session-start", id: randomUUID(), at: new Date(startedAt).toISOString(), scope: sessionScope, ...(label ? { label } : {}) });
        ctx.ui.notify(`Work session started${label ? ` (${label})` : ""} at ${new Date(startedAt).toISOString()}. Stop with /${command} stop.`, "info");
      },
      stop: (args, ctx) => {
        const open = openSession();
        if (!open) { ctx.ui.notify(`/${command}: no open work session.`, "warning"); return; }
        const endedAt = now();
        if (endedAt < open.startedAt) throw new Error("Clock precedes session start; cannot close the session");
        appendJsonl(sessionsLog, { version: 1, kind: "session-stop", id: open.id, at: new Date(endedAt).toISOString(), scope: sessionScope, ...(args ? { note: args.slice(0, 320) } : {}) });
        ctx.ui.notify(`Work session closed: ${minutes(endedAt - open.startedAt)}. User-attested hours, pending review.`, "info");
      },
      status: (_args, ctx) => { const open = openSession(); ctx.ui.notify(open ? `Open session since ${new Date(open.startedAt).toISOString()}${open.label ? ` (${open.label})` : ""}.` : `No open session. /${command} start begins one.`, "info"); },
      time: (_args, ctx) => {
        turn?.checkpoint();
        const records = readTurnRecords(turnsLog).filter(r => r.scope === turnScope && r.outcome === "settled");
        const chunks = readChunks(chunksLog).filter(c => c.scope === turnScope);
        const [total] = reconcileIntervals([chunks.map(c => ({ start: Date.parse(c.start), end: Date.parse(c.end) }))], options);
        ctx.ui.notify(`${records.length} settled Pi turns · ${chunks.length ? hours(total) : "Unknown"} tracked working hours (interval union). Legacy aggregates excluded. Log: ${turnsLog}`, "info");
      },
      report: (args, ctx) => {
        if (args && (!/^\d{4}-\d{2}-\d{2}$/.test(args) || !Number.isFinite(Date.parse(args)) || new Date(args).toISOString().slice(0, 10) !== args)) throw new Error("Expected report [YYYY-MM-DD]");
        turn?.checkpoint();
        const result = buildWorkReport({ ...options, root, scopePrefix, timezones, now: now(), sinceDay: args || null, turnsLog, chunksLog, sessionsLog, activitiesLog });
        writeFilePrivate(reportFile, result.text);
        ctx.ui.notify(`${result.summary}. Full draft: ${reportFile}`, "info");
      },
    };
    pi.registerCommand(command, {
      description: `Working hours: /${command} start|stop|status|time|report`,
      handler: async (args: string, ctx: Ctx) => {
        if (!inScope(ctx.cwd)) return;
        const [sub = "status", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!subcommands[sub]) { ctx.ui.notify(`/${command}: unknown "${sub}". Use start|stop|status|time|report.`, "warning"); return; }
        try { subcommands[sub](rest.join(" "), ctx); } catch (e) { ctx.ui.notify(`/${command} ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
      },
    });
    for (const name of options.legacyCommandNames ?? []) pi.registerCommand(name, { description: `Alias for /${command} time`, handler: async (_args: string, ctx: Ctx) => { if (inScope(ctx.cwd)) { try { subcommands.time("", ctx); } catch (e) { ctx.ui.notify(String(e), "error"); } } } });
  };
}
