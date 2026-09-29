import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SESSION_SCOPE_SUFFIX, TURN_SCOPE_SUFFIX, Turn, appendJsonl, readChunks, readTurnRecords, readWorkSessions, writeFilePrivate, type ActivityIdentity, type TurnChunk } from "./ledger.ts";
import { labelFor, resolveSessionLabel } from "./labels.ts";
import { appendActivity, workNoteParameters, type WorkNoteInput } from "./activities.ts";
import { buildAutomaticReport, buildWorkReport, hours, minutes } from "./report.ts";
import { reconcileIntervals, type NativeOptions } from "./native.ts";
import { ProjectStore, containsPath, defaultDatabasePath, isSqliteBusy, projectText, repositoryRoot, type WorkWindow, type Workspace } from "./project-store.ts";
import { AutomaticClock, DEFAULT_IDLE_GAP_MS, isHumanInput } from "./automatic.ts";

export interface TimeTrackingOptions extends NativeOptions {
  scopePrefix?: string; commandPrefix?: string; legacyCommandNames?: string[]; timezones?: string[];
  turnsLog?: string; chunksLog?: string; sessionsLog?: string; activitiesLog?: string; reportFile?: string; now?: () => number;
  databasePath?: string; idleGapMs?: number; projectCommand?: string;
}
type Ctx = { cwd: string; mode: string; sessionManager?: { getSessionId: () => string | null }; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void; setStatus: (key: string, text: string | undefined) => void; onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void } };

export const reportParameters = Type.Object({
  sinceDay: Type.Optional(Type.String({ description: "Optional earliest local day to include, as YYYY-MM-DD. Omit to include every recorded day." })),
}, { additionalProperties: false });

/** Shared day-argument validation for /work report and /project report. */
export function parseReportDay(args: string, usage = "[YYYY-MM-DD]"): string | null {
  const day = String(args ?? "").trim();
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error(`Expected report ${usage}`);
  return day;
}

export function createTimeTrackingExtension(configuredRoot?: string, options: TimeTrackingOptions = {}) {
  const scopePrefix = options.scopePrefix ?? "work", command = options.commandPrefix ?? "work";
  const projectCommand = options.projectCommand ?? "project";
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  if (!/^[A-Za-z0-9_-]+$/.test(projectCommand)) throw new Error("projectCommand must be a nonempty command name without whitespace or slashes");
  if (projectCommand === command || (options.legacyCommandNames ?? []).includes(projectCommand)) throw new Error(`/${projectCommand} collides with an existing command name`);
  if (!Number.isSafeInteger(idleGapMs) || idleGapMs <= 0) throw new Error("idleGapMs must be a positive integer of milliseconds");
  const timezones = options.timezones ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
  const now = options.now ?? Date.now, turnScope = scopePrefix + TURN_SCOPE_SUFFIX, sessionScope = scopePrefix + SESSION_SCOPE_SUFFIX;
  const statusKey = command + "-time";
  const databasePath = options.databasePath ?? defaultDatabasePath();
  if (!isAbsolute(databasePath)) throw new Error("databasePath must be an absolute path");
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
    /** Canonical cwd when it is inside the root, else null. Callers resolve this once per event. */
    const scopedCwd = (cwd: string): string | null => {
      try {
        const canonicalCwd = realpathSync(cwd);
        if (!root) bindRoot(repositoryRoot(canonicalCwd));
        return containsPath(realpathSync(root), canonicalCwd) ? canonicalCwd : null;
      } catch { return null; }
    };
    let turn: Turn | undefined, chunkWriteFailed = false, promptDepth = 0;
    let requestLabel: ReturnType<typeof labelFor>, turnTools = new Set<string>();
    let sessionId: string = randomUUID();
    // Automatic work-window state. Kept per loaded runtime; the SQLite store is shared across runtimes.
    let store: ProjectStore | undefined, autoClock: AutomaticClock | undefined, workspace: Workspace | undefined, task = "unlabeled", autoFailed = false, unsubscribeInput: (() => void) | undefined, liveCtx: Ctx | undefined;
    // Writer contention is temporary: the clock keeps its evidence in memory and the next event, report or
    // session handover retries it. The value is the earliest observation not yet applied, or null when only the write is pending.
    const DEFERRED_LIMIT = 4;
    const deferredClocks = new Map<AutomaticClock, number | null>();
    let deferralNotified = false;
    const identity = (): ActivityIdentity => {
      const label = requestLabel ?? labelFor(undefined, [...turnTools]);
      return { sessionId, label: label?.label ?? "unlabeled", ...(label ? { labelSource: label.source } : {}) };
    };
    const sink = (chunk: TurnChunk) => { try { appendJsonl(chunksLog, { ...chunk, ...identity() }); } catch { chunkWriteFailed = true; } };
    const warn = (ctx: Ctx, text: string) => { if (ctx.mode === "tui") ctx.ui.notify(text, "warning"); else console.error(text); };
    const close = (ctx: Ctx, outcome: "settled" | "interrupted") => {
      if (!turn) return;
      const current = turn; turn = undefined;
      const record = outcome === "settled" && scopedCwd(ctx.cwd) ? current.settle(now()) : current.interrupt(now());
      if (record) {
        Object.assign(record, identity());
        try { appendJsonl(turnsLog, record); }
        catch { warn(ctx, `${scopePrefix} time: could not save the turn summary; check disk permissions`); }
        if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, `Pi turn: ${minutes(record.observedMs)} (${record.label ?? "unlabeled"}, working hours draft)`);
      }
      if (chunkWriteFailed) warn(ctx, `${scopePrefix} time: some activity intervals could not be saved; report coverage is incomplete`);
      chunkWriteFailed = false; promptDepth = 0; requestLabel = undefined; turnTools.clear();
    };
    const observe = (ctx: Ctx, cwd = scopedCwd(ctx.cwd)) => { if (turn) { if (cwd) turn.event(now()); else close(ctx, "interrupted"); } };
    const getStore = (ctx: Ctx): ProjectStore | undefined => {
      if (autoFailed) return undefined;
      if (store) return store;
      try { store = new ProjectStore(databasePath); return store; }
      catch (e) { disableAutomatic(ctx, e); return undefined; }
    };
    const clearAutomatic = () => {
      autoClock = undefined; workspace = undefined; task = "unlabeled"; liveCtx = undefined;
      if (unsubscribeInput) { try { unsubscribeInput(); } catch { /* a vanished UI subscription is not evidence */ } unsubscribeInput = undefined; }
    };
    const disableAutomatic = (ctx: Ctx, e: unknown) => {
      autoFailed = true; clearAutomatic(); deferredClocks.clear(); deferralNotified = false;
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, "Automatic work tracking disabled (error); retry on next session");
      warn(ctx, `${projectCommand}: automatic work tracking disabled — ${e instanceof Error ? e.message : String(e)}`);
    };
    const deferClock = (clock: AutomaticClock, observation: number | null, ctx: Ctx) => {
      const prior = deferredClocks.get(clock);
      const earliest = prior == null ? observation : observation == null ? prior : Math.min(prior, observation);
      if (prior === undefined && deferredClocks.size >= DEFERRED_LIMIT) {
        const oldest = deferredClocks.keys().next().value;
        if (oldest) deferredClocks.delete(oldest);
        warn(ctx, `${projectCommand}: ${DEFERRED_LIMIT} unsaved work windows are waiting on a busy database; the oldest evidence may be incomplete`);
      }
      deferredClocks.set(clock, earliest);
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, "Automatic work tracking waiting for the database");
      if (!deferralNotified) {
        deferralNotified = true;
        warn(ctx, `${projectCommand}: the shared database is busy; recent activity is kept in memory and retried on the next event`);
      }
    };
    /** Apply one deferred clock's earliest unrecorded observation, then persist. False means it is still deferred. */
    const saveDeferred = (clock: AutomaticClock, ctx: Ctx): boolean => {
      const observation = deferredClocks.get(clock);
      try {
        if (typeof observation === "number") { clock.touch(observation); deferredClocks.set(clock, null); }
        clock.flush();
        deferredClocks.delete(clock);
        return true;
      } catch (e) {
        if (!isSqliteBusy(e)) { deferredClocks.delete(clock); disableAutomatic(ctx, e); return false; }
        if (observation === undefined) deferredClocks.set(clock, null);
        return false;
      }
    };
    /** One blocking attempt per event: stop at the first clock the database still refuses, never spin. */
    const retryDeferred = (ctx: Ctx): boolean => {
      for (const clock of [...deferredClocks.keys()]) if (!saveDeferred(clock, ctx)) return false;
      if (deferralNotified) {
        deferralNotified = false;
        if (ctx.mode === "tui" && workspace) ctx.ui.setStatus(statusKey, `Automatic work tracking on (${workspace.client})`);
      }
      return true;
    };
    const touchAutomatic = (ctx: Ctx, cwd = scopedCwd(ctx.cwd)) => {
      if (!cwd) return;
      const activeSessionId = ctx.sessionManager?.getSessionId();
      if (activeSessionId && activeSessionId !== sessionId) {
        close(ctx, "interrupted"); sessionId = activeSessionId; startAutomatic(ctx);
      }
      if (autoFailed || !autoClock || !workspace || !containsPath(workspace.root, cwd)) return;
      const clock = autoClock, at = now();
      if (deferredClocks.size && !retryDeferred(ctx)) {
        if (!autoFailed) deferClock(clock, at, ctx);
        return;
      }
      try { clock.touch(at); } catch (e) { if (isSqliteBusy(e)) deferClock(clock, at, ctx); else disableAutomatic(ctx, e); }
    };
    const flushAutomatic = (ctx: Ctx) => {
      if (!autoClock) return;
      if (!saveDeferred(autoClock, ctx)) {
        if (!autoFailed) deferClock(autoClock, null, ctx);
        return;
      }
      retryDeferred(ctx);
    };
    const stopAutomatic = (ctx: Ctx) => {
      flushAutomatic(ctx); clearAutomatic();
    };
    const startAutomatic = (ctx: Ctx, retry = false) => {
      stopAutomatic(ctx);
      if (retry) autoFailed = false;
      liveCtx = ctx;
      if (autoFailed || !scopedCwd(ctx.cwd)) return;
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
      if (!s) return undefined;
      const reportWorkspace = workspace ?? s.resolveWorkspace(ctx.cwd);
      return { windows: s.windows(reportWorkspace.root), idleGapMs };
    };
    // One builder for the slash command and the model-facing tool: no second summary
    // path, and the draft is written at most once per call.
    const renderWorkReport = (day: string | null, ctx: Ctx) => {
      turn?.checkpoint();
      flushAutomatic(ctx);
      const automatic = automaticEvidence(ctx);
      const result = buildWorkReport({ ...options, root, scopePrefix, timezones, now: now(), sinceDay: day, turnsLog, chunksLog, sessionsLog, activitiesLog, ...(automatic ? { automatic } : {}) });
      writeFilePrivate(reportFile, result.text);
      return { summary: result.summary, reportFile };
    };
    pi.on("session_start", (_event, ctx) => {
      close(ctx, "interrupted"); sessionId = ctx.sessionManager?.getSessionId() ?? randomUUID(); requestLabel = undefined;
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, undefined);
      startAutomatic(ctx, true);
    });
    // A switch can be vetoed; only checkpoint here. Confirmed teardown emits session_shutdown.
    pi.on("session_before_switch", (_event, ctx) => { turn?.checkpoint(); flushAutomatic(ctx); });
    pi.on("before_agent_start", (event, ctx) => {
      const cwd = scopedCwd(ctx.cwd);
      if (!cwd) return;
      touchAutomatic(ctx, cwd);
      // Classify immediately; never retain or persist the prompt text.
      if (turn) { turn.event(now()); turn.checkpoint(); }
      requestLabel = labelFor(event.prompt);
    });
    pi.on("agent_start", (_event, ctx) => {
      const cwd = scopedCwd(ctx.cwd);
      if (!cwd) return;
      touchAutomatic(ctx, cwd);
      if (turn) turn.event(now());
      else { turnTools = new Set(); promptDepth = 0; turn = new Turn(turnScope, sink, now()); }
      if (ctx.mode === "tui") ctx.ui.setStatus(statusKey, "Pi: tracking this turn");
    });
    pi.on("input", (_event, ctx) => { touchAutomatic(ctx); });
    pi.on("message_update", (_event, ctx) => { const cwd = scopedCwd(ctx.cwd); observe(ctx, cwd); touchAutomatic(ctx, cwd); });
    pi.on("tool_execution_start", (event, ctx) => {
      const cwd = scopedCwd(ctx.cwd);
      observe(ctx, cwd);
      touchAutomatic(ctx, cwd);
      if (cwd && event.toolName) {
        const next = requestLabel ?? labelFor(undefined, [...turnTools, event.toolName]);
        if (next?.label !== identity().label) turn?.checkpoint();
        turnTools.add(event.toolName);
      }
    });
    pi.on("tool_execution_end", (_event, ctx) => { const cwd = scopedCwd(ctx.cwd); observe(ctx, cwd); touchAutomatic(ctx, cwd); });
    pi.on("ui_prompt_start", (_event, ctx) => { if (turn && scopedCwd(ctx.cwd) && promptDepth++ === 0) turn.pause(now()); });
    pi.on("ui_prompt_end", (_event, ctx) => { if (turn && scopedCwd(ctx.cwd) && promptDepth > 0 && --promptDepth === 0) turn.resume(now()); });
    pi.on("agent_settled", (_event, ctx) => { touchAutomatic(ctx); flushAutomatic(ctx); close(ctx, "settled"); });
    pi.on("session_shutdown", (_event, ctx) => {
      close(ctx, "interrupted"); stopAutomatic(ctx);
      if (deferredClocks.size) warn(ctx, `${projectCommand}: ${deferredClocks.size} unsaved work window(s) could not be written before shutdown; the database stayed busy`);
      deferredClocks.clear();
      store?.close(); store = undefined;
    });

    pi.registerTool({
      name: `${command}_note`, label: "Record work evidence",
      description: "Append one sanitized activity/outcome to the local work log. Never adds hours or writes external records.",
      promptSnippet: "Record a concise, timestamped work outcome with evidence and verification status.",
      promptGuidelines: [`For completed work milestones in this workspace, record a concise ${command}_note with the actual outcome and evidence. Keep draft, planned, user-reported, blocked and verified states distinct. Never include raw prompts, customer data, private messages or secrets. Notes do not estimate working hours.`],
      executionMode: "sequential",
      parameters: workNoteParameters,
      execute: async (callId, args, _signal, _update, ctx) => {
        if (!scopedCwd(ctx.cwd)) throw new Error("Work notes are limited to this workspace");
        const context = { callId, scope: `${scopePrefix}-activity`, at: now(), sessionId: ctx.sessionManager?.getSessionId() ?? sessionId, ...(turn ? { turnId: turn.id } : {}) };
        const note = await withFileMutationQueue(activitiesLog, async () => appendActivity(activitiesLog, args as WorkNoteInput, context));
        return { content: [{ type: "text", text: `Recorded ${note.label}: ${note.summary} (${note.status}); duration Unallocated. No external sync.` }], details: { noteId: note.id } };
      },
    });
    // Answer hours questions directly from recorded receipts. Without this, a model
    // reconstructs totals from raw JSONL, which is slow and easy to get wrong.
    pi.registerTool({
      name: `${command}_report`, label: "Working-hours draft",
      description: "Summarize the tracked working hours already recorded for this workspace and refresh the local draft (exports/work-report.md). Use it for any question about how much time was tracked, instead of reading raw receipt logs. The tracked agent-turn union, the user-attested session clock and the inferred automatic windows stay separate measures and are never added together. It writes the normal local draft; it never invoices, syncs or invents missing hours.",
      promptSnippet: "Summarize recorded working hours for this workspace and refresh the local draft.",
      promptGuidelines: [`When the user asks about tracked hours, time spent, or a work report, call ${command}_report instead of reading receipt logs or recomputing totals in the shell.`, `Report the returned per-timezone summary and cite the draft path; keep the session clock, tracked agent-turn hours and inferred windows separate and never add them.`, `Record outcome detail with ${command}_note: ${command}_report only measures recorded intervals and leaves days without evidence Unknown.`],
      executionMode: "sequential",
      parameters: reportParameters,
      execute: async (_toolCallId, args, _signal, _update, ctx) => {
        if (!scopedCwd(ctx.cwd)) throw new Error("Working-hours reports are limited to this workspace");
        const requested = (args as { sinceDay?: string }).sinceDay ?? "";
        const day = parseReportDay(requested);
        const { summary, reportFile: file } = renderWorkReport(day, ctx as unknown as Ctx);
        return {
          content: [{ type: "text", text: `${summary}. Full draft: ${file}\nMeasures stay separate; outcome detail comes only from recorded work notes.` }],
          details: { summary, reportFile: file, sinceDay: day },
        };
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
      report: (args, ctx) => { const { summary, reportFile: file } = renderWorkReport(parseReportDay(args), ctx); ctx.ui.notify(`${summary}. Full draft: ${file}`, "info"); },
    };
    pi.registerCommand(command, {
      description: `Working hours: /${command} start|stop|status|time|report`,
      handler: async (args: string, ctx: Ctx) => {
        if (!scopedCwd(ctx.cwd)) return;
        const [sub = "status", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!subcommands[sub]) { ctx.ui.notify(`/${command}: unknown "${sub}". Use start|stop|status|time|report.`, "warning"); return; }
        try { subcommands[sub](rest.join(" "), ctx); } catch (e) { ctx.ui.notify(`/${command} ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
      },
    });
    const mustGetStore = (ctx: Ctx): ProjectStore | undefined => {
      const alreadyFailed = autoFailed;
      const s = getStore(ctx);
      if (!s && alreadyFailed) ctx.ui.notify(`/${projectCommand}: automatic work tracking is disabled or unavailable.`, "error");
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
        const assigned = s.setClient(wsRoot, args);
        startAutomatic(ctx);
        ctx.ui.notify(`Workspace ${assigned.root} labeled "${assigned.client}". Sessions in it inherit this client automatically.`, "info");
      },
      task: (args, ctx) => {
        if (!args.trim()) { ctx.ui.notify(`Session task: ${task}. Set with /${projectCommand} task <name>; use "clear" to reset to unlabeled.`, "info"); return; }
        const s = mustGetStore(ctx); if (!s) return;
        const wsRoot = workspace?.root ?? root;
        if (!wsRoot) { ctx.ui.notify(`/${projectCommand}: open a session in the workspace first.`, "warning"); return; }
        try {
          const nextTask = args.trim() === "clear" ? "unlabeled" : projectText(args);
          s.setTask(wsRoot, sessionId, nextTask);
        } catch (e) { ctx.ui.notify(`/${projectCommand} task failed: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
        startAutomatic(ctx);
        ctx.ui.notify(`Session task: ${task} (remembered for session ${sessionId.slice(0, 8)}; restored across /reload and resume).`, "info");
      },
      report: (args, ctx) => {
        if (args.trim() === "all") {
          turn?.checkpoint(); flushAutomatic(ctx);
          const s = mustGetStore(ctx); if (!s) return;
          const result = buildAutomaticReport({ ...options, windows: s.windows(), timezones, now: now(), sinceDay: null, idleGapMs, scope: databasePath });
          const file = join(dirname(databasePath), "automatic-work-report.md");
          writeFilePrivate(file, result.text);
          ctx.ui.notify(`${result.summary}. Full draft: ${file}. Repository-local agent and manual receipts are separate measures and are not included.`, "info");
          return;
        }
        const { summary, reportFile: file } = renderWorkReport(parseReportDay(args, "[YYYY-MM-DD|all]"), ctx);
        ctx.ui.notify(`${summary}. Full draft: ${file}`, "info");
      },
    };
    pi.registerCommand(projectCommand, {
      description: `Automatic work tracking: /${projectCommand} status|set <client>|task <name>|report [YYYY-MM-DD|all]`,
      handler: async (args: string, ctx: Ctx) => {
        if (!scopedCwd(ctx.cwd)) return;
        const [sub = "status", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!projectSubcommands[sub]) { ctx.ui.notify(`/${projectCommand}: unknown "${sub}". Use status|set|task|report.`, "warning"); return; }
        try { projectSubcommands[sub](rest.join(" "), ctx); } catch (e) { ctx.ui.notify(`/${projectCommand} ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
      },
    });
    for (const name of options.legacyCommandNames ?? []) pi.registerCommand(name, { description: `Alias for /${command} time`, handler: async (_args: string, ctx: Ctx) => { if (scopedCwd(ctx.cwd)) { try { subcommands.time("", ctx); } catch (e) { ctx.ui.notify(String(e), "error"); } } } });
  };
}
