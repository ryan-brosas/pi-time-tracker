import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SESSION_SCOPE_SUFFIX, TURN_SCOPE_SUFFIX, Turn, appendJsonl, readChunks, readTurnRecords, readWorkSessions, writeFilePrivate, type ActivityIdentity, type TurnChunk } from "./ledger.ts";
import { labelFor, resolveSessionLabel } from "./labels.ts";
import { appendActivity, workNoteParameters, type WorkNoteInput } from "./activities.ts";
import { buildAutomaticReport, buildWorkReport, hours, minutes } from "./report.ts";
import { reconcileIntervals, type NativeOptions } from "./native.ts";
import { ProjectStore, containsPath, defaultDatabasePath, projectText, type WorkWindow, type Workspace } from "./project-store.ts";
import { AutomaticClock, DEFAULT_IDLE_GAP_MS, isHumanInput } from "./automatic.ts";

export interface TimeTrackingOptions extends NativeOptions {
  scopePrefix?: string; commandPrefix?: string; legacyCommandNames?: string[]; timezones?: string[];
  turnsLog?: string; chunksLog?: string; sessionsLog?: string; activitiesLog?: string; reportFile?: string; now?: () => number;
  databasePath?: string; idleGapMs?: number; projectCommand?: string;
}
type Ctx = { cwd: string; mode: string; sessionManager?: { getSessionId: () => string | null }; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void; setStatus: (key: string, text: string | undefined) => void; onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void } };

/** Shared day-argument validation for /work report and /project report. */
export function parseReportDay(args: string): string | null {
  const day = String(args ?? "").trim();
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Expected report [YYYY-MM-DD]");
  return day;
}

export function createTimeTrackingExtension(configuredRoot?: string, options: TimeTrackingOptions = {}) {
  const scopePrefix = options.scopePrefix ?? "work", command = options.commandPrefix ?? "work";
  const projectCommand = options.projectCommand ?? "project";
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  if (projectCommand === command || (options.legacyCommandNames ?? []).includes(projectCommand)) throw new Error(`/${projectCommand} collides with an existing command name`);
  if (!Number.isSafeInteger(idleGapMs) || idleGapMs <= 0) throw new Error("idleGapMs must be a positive integer of milliseconds");
  const timezones = options.timezones ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
  const now = options.now ?? Date.now, turnScope = scopePrefix + TURN_SCOPE_SUFFIX, sessionScope = scopePrefix + SESSION_SCOPE_SUFFIX;
  const statusKey = command + "-time";
  const databasePath = options.databasePath ?? defaultDatabasePath();
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
        return containsPath(realpathSync(root), canonicalCwd);
      } catch { return false; }
    };
    let turn: Turn | undefined, chunkWriteFailed = false, promptDepth = 0;
    let requestLabel: ReturnType<typeof labelFor>, turnTools = new Set<string>();
    let sessionId: string = randomUUID();
    // Automatic work-window state. Kept per loaded runtime; the SQLite store is shared across runtimes.
    let store: ProjectStore | undefined, autoClock: AutomaticClock | undefined, workspace: Workspace | undefined, task = "unlabeled", autoFailed = false, unsubscribeInput: (() => void) | undefined, liveCtx: Ctx | undefined;
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
    const getStore = (ctx: Ctx): ProjectStore | undefined => {
      if (store) return store;
      if (autoFailed) return undefined;
      try { store = new ProjectStore(databasePath); return store; }
      catch (e) { autoFailed = true; warn(ctx, `${projectCommand}: automatic work tracking disabled — ${e instanceof Error ? e.message : String(e)}`); return undefined; }
    };
    const autoInScope = (ctx: Ctx) => { if (!workspace) return false; try { return containsPath(workspace.root, realpathSync(ctx.cwd)); } catch { return false; } };
    const disableAutomatic = (ctx: Ctx, e: unknown) => { autoFailed = true; autoClock = undefined; warn(ctx, `${projectCommand}: automatic work tracking disabled — ${e instanceof Error ? e.message : String(e)}`); };
    const touchAutomatic = (ctx: Ctx) => {
      if (autoFailed || !autoClock || !inScope(ctx.cwd) || !autoInScope(ctx)) return;
      try { autoClock.touch(now()); } catch (e) { disableAutomatic(ctx, e); }
    };
    const flushAutomatic = (ctx: Ctx) => {
      if (!autoClock) return;
      try { autoClock.flush(); } catch (e) { disableAutomatic(ctx, e); }
    };
    const stopAutomatic = (ctx: Ctx) => {
      flushAutomatic(ctx); autoClock = undefined;
      if (unsubscribeInput) { try { unsubscribeInput(); } catch { /* a vanished UI subscription is not evidence */ } unsubscribeInput = undefined; }
    };
    const startAutomatic = (ctx: Ctx) => {
      stopAutomatic(ctx);
      liveCtx = ctx;
      if (autoFailed || !inScope(ctx.cwd)) return;
      const s = getStore(ctx);
      if (!s) return;
      try {
        workspace = s.resolveWorkspace(ctx.cwd);
        task = s.task(workspace.root, sessionId);
        autoClock = new AutomaticClock(s, workspace, sessionId, task, idleGapMs);
        if (typeof ctx.ui.onTerminalInput === "function") unsubscribeInput = ctx.ui.onTerminalInput((data: string) => { if (isHumanInput(data)) touchAutomatic(liveCtx ?? ctx); return undefined; });
        if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, `Automatic work tracking on (${workspace.client}); /${projectCommand} set labels this workspace`);
      } catch (e) { disableAutomatic(ctx, e); }
    };
    const automaticEvidence = (ctx: Ctx): { windows: WorkWindow[]; idleGapMs: number } | undefined => {
      const s = getStore(ctx);
      if (!s || !workspace) return undefined;
      return { windows: s.windows(workspace.root), idleGapMs };
    };
    const renderWorkReport = (day: string | null, ctx: Ctx) => {
      turn?.checkpoint();
      flushAutomatic(ctx);
      const automatic = automaticEvidence(ctx);
      const result = buildWorkReport({ ...options, root, scopePrefix, timezones, now: now(), sinceDay: day, turnsLog, chunksLog, sessionsLog, activitiesLog, ...(automatic ? { automatic } : {}) });
      writeFilePrivate(reportFile, result.text);
      ctx.ui.notify(`${result.summary}. Full draft: ${reportFile}`, "info");
    };
    pi.on("session_start", (_event, ctx) => {
      close(ctx, "interrupted"); sessionId = ctx.sessionManager?.getSessionId() ?? randomUUID(); requestLabel = undefined;
      const scoped = inScope(ctx.cwd);
      if (ctx.mode === "tui" && scoped) ctx.ui.setStatus(statusKey, `Working hours tracked automatically; /${projectCommand} report drafts them`);
      startAutomatic(ctx);
    });
    // A switch can be vetoed; only checkpoint here. Confirmed teardown emits session_shutdown.
    pi.on("session_before_switch", (_event, ctx) => { turn?.checkpoint(); flushAutomatic(ctx); });
    pi.on("before_agent_start", (event, ctx) => {
      if (!inScope(ctx.cwd)) return;
      touchAutomatic(ctx);
      // Classify immediately; never retain or persist the prompt text.
      if (turn) { turn.event(now()); turn.checkpoint(); }
      requestLabel = labelFor(event.prompt);
    });
    pi.on("agent_start", (_event, ctx) => {
      if (!inScope(ctx.cwd)) return;
      touchAutomatic(ctx);
      if (turn) turn.event(now());
      else { turnTools = new Set(); promptDepth = 0; sessionId = ctx.sessionManager?.getSessionId() ?? sessionId; turn = new Turn(turnScope, sink, now()); }
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, "Pi: tracking this turn");
    });
    pi.on("input", (_event, ctx) => { touchAutomatic(ctx); });
    pi.on("message_update", (_event, ctx) => { observe(ctx); touchAutomatic(ctx); });
    pi.on("tool_execution_start", (event, ctx) => {
      observe(ctx);
      touchAutomatic(ctx);
      if (inScope(ctx.cwd) && event.toolName) {
        const next = requestLabel ?? labelFor(undefined, [...turnTools, event.toolName]);
        if (next?.label !== identity().label) turn?.checkpoint();
        turnTools.add(event.toolName);
      }
    });
    pi.on("tool_execution_end", (_event, ctx) => { observe(ctx); touchAutomatic(ctx); });
    pi.on("ui_prompt_start", (_event, ctx) => { if (turn && inScope(ctx.cwd) && promptDepth++ === 0) turn.pause(now()); });
    pi.on("ui_prompt_end", (_event, ctx) => { if (turn && inScope(ctx.cwd) && promptDepth > 0 && --promptDepth === 0) turn.resume(now()); });
    pi.on("agent_settled", (_event, ctx) => { touchAutomatic(ctx); flushAutomatic(ctx); close(ctx, "settled"); });
    pi.on("session_shutdown", (_event, ctx) => { close(ctx, "interrupted"); stopAutomatic(ctx); store?.close(); store = undefined; });

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
      report: (args, ctx) => { renderWorkReport(parseReportDay(args), ctx); },
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
    const mustGetStore = (ctx: Ctx): ProjectStore | undefined => {
      const s = getStore(ctx);
      if (!s) ctx.ui.notify(`/${projectCommand}: automatic work tracking is disabled or unavailable.`, "error");
      return s;
    };
    const projectSubcommands: Record<string, (args: string, ctx: Ctx) => void> = {
      status: (_args, ctx) => {
        ctx.ui.notify(`Client ${workspace ? workspace.client : "Unknown (unbound)"} · session task ${task} · workspace ${workspace?.root ?? (root || "unbound")} · idle join limit ${minutes(idleGapMs)} · database ${databasePath}${autoFailed ? " · automatic tracking disabled (error)" : ""}. Work is detected from activity; no start or stop is needed.`, "info");
      },
      set: (args, ctx) => {
        if (!args.trim()) { ctx.ui.notify(`/${projectCommand} set <client> labels this folder/repo once.`, "warning"); return; }
        const s = mustGetStore(ctx); if (!s) return;
        const wsRoot = workspace?.root ?? root;
        if (!wsRoot) { ctx.ui.notify(`/${projectCommand}: open a session in the workspace first.`, "warning"); return; }
        try { workspace = s.setClient(wsRoot, args); }
        catch (e) { ctx.ui.notify(`/${projectCommand} set failed: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
        startAutomatic(ctx);
        ctx.ui.notify(`Workspace ${workspace.root} labeled "${workspace.client}". Sessions in it inherit this client automatically.`, "info");
      },
      task: (args, ctx) => {
        const s = mustGetStore(ctx); if (!s) return;
        if (!args.trim()) { ctx.ui.notify(`Session task: ${task}. Set with /${projectCommand} task <name>; use "clear" to reset to unlabeled.`, "info"); return; }
        const wsRoot = workspace?.root ?? root;
        if (!wsRoot) { ctx.ui.notify(`/${projectCommand}: open a session in the workspace first.`, "warning"); return; }
        try {
          task = args.trim() === "clear" ? "unlabeled" : projectText(args);
          s.setTask(wsRoot, sessionId, task);
        } catch (e) { ctx.ui.notify(`/${projectCommand} task failed: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
        startAutomatic(ctx);
        ctx.ui.notify(`Session task: ${task} (remembered for session ${sessionId.slice(0, 8)}; restored across /reload and resume).`, "info");
      },
      report: (args, ctx) => {
        if (args.trim() === "all") {
          turn?.checkpoint(); flushAutomatic(ctx);
          const s = mustGetStore(ctx); if (!s) return;
          const result = buildAutomaticReport({ ...options, windows: s.windows(), timezones, now: now(), sinceDay: null, idleGapMs, scope: databasePath });
          const file = join(dirname(databasePath), "work-report.md");
          writeFilePrivate(file, result.text);
          ctx.ui.notify(`${result.summary}. Full draft: ${file}. Repository-local agent and manual receipts are separate measures and are not included.`, "info");
          return;
        }
        renderWorkReport(parseReportDay(args), ctx);
      },
    };
    pi.registerCommand(projectCommand, {
      description: `Automatic work tracking: /${projectCommand} status|set <client>|task <name>|report [YYYY-MM-DD|all]`,
      handler: async (args: string, ctx: Ctx) => {
        if (!inScope(ctx.cwd)) return;
        const [sub = "status", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!projectSubcommands[sub]) { ctx.ui.notify(`/${projectCommand}: unknown "${sub}". Use status|set|task|report.`, "warning"); return; }
        try { projectSubcommands[sub](rest.join(" "), ctx); } catch (e) { ctx.ui.notify(`/${projectCommand} ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
      },
    });
    for (const name of options.legacyCommandNames ?? []) pi.registerCommand(name, { description: `Alias for /${command} time`, handler: async (_args: string, ctx: Ctx) => { if (inScope(ctx.cwd)) { try { subcommands.time("", ctx); } catch (e) { ctx.ui.notify(String(e), "error"); } } } });
  };
}
