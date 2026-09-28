import { readActivities, type ActivityNote } from "./activities.ts";
import { inspectJsonl, localDayKey, readChunks, readTurnRecords, readWorkSessions, splitIntervalByLocalDay, type Interval, type TimeRecord } from "./ledger.ts";
import { auditTurnReceipts, reconcileIntervals, type NativeOptions } from "./native.ts";
import type { WorkWindow } from "./project-store.ts";

export const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
export const hours = (ms: number) => `${(ms / 3600000).toFixed(2)} h`;
export interface ReportOptions extends NativeOptions {
  root: string; scopePrefix: string; timezones: string[]; now: number; sinceDay: string | null;
  turnsLog: string; chunksLog: string; sessionsLog: string; activitiesLog: string;
  /** Inferred elapsed-work windows from the shared tracker database. */
  automatic?: { windows: WorkWindow[]; idleGapMs: number };
}
export interface AutomaticReportOptions extends NativeOptions {
  windows: WorkWindow[]; timezones: string[]; now: number; sinceDay: string | null; idleGapMs: number; scope: string;
}
const safe = (text: string) => text.replace(/[\r\n]/g, " ").replace(/[<>|`]/g, "");
interface Detail { group: number; label: string; start: number; end: number; turnId: string; sessionId?: string; state: string; capped: boolean }
interface Day {
  agent: number; session: number; labels: Map<string, number>; details: Map<string, Detail>;
  legacy: TimeRecord[]; missing: TimeRecord[]; conflicts: Set<string>; notes: ActivityNote[]; open: number[];
  auto: number; autoSplit: Map<string, number>; gaps: Interval[];
}

/** Share calendar partitioning/filtering; interval unions still belong to native Bend. */
function reportDayVisitor<T>(tz: string, sinceDay: string | null, day: (key: string) => T) {
  return (start: number, end: number, fn: (d: T, interval: Interval) => void) => {
    let cursor = start;
    for (const part of splitIntervalByLocalDay(start, end, tz)) {
      const interval = { start: cursor, end: cursor + part.ms }; cursor = interval.end;
      if (sinceDay === null || part.day >= sinceDay) fn(day(part.day), interval);
    }
  };
}

/** Calendar preparation/rendering in JS; every interval union is owned by native Bend. */
export function buildWorkReport(options: ReportOptions): { text: string; summary: string } {
  const { scopePrefix, timezones, sinceDay } = options;
  const automatic = options.automatic;
  const allChunks = readChunks(options.chunksLog), allTurns = readTurnRecords(options.turnsLog);
  const chunks = allChunks.filter(c => c.scope === `${scopePrefix}-pi-turn`);
  const scopedTurns = allTurns.filter(t => t.scope === `${scopePrefix}-pi-turn`);
  const audits = auditTurnReceipts(scopedTurns, chunks, options);
  const conflicts = new Set([...audits].filter(([, a]) => a.status === "conflict").map(([id]) => id));
  // Keep ambiguous summaries as evidence, never as authoritative label/duration fallbacks.
  const turns = new Map(scopedTurns.filter(t => !conflicts.has(t.id)).map(t => [t.id, t]));
  const sessions = readWorkSessions(options.sessionsLog).filter(s => s.scope === `${scopePrefix}-user-session`);
  const notes = readActivities(options.activitiesLog).filter(n => n.scope === `${scopePrefix}-activity`);
  const legacy = [...turns.values()].filter(t => audits.get(t.id)?.status === "legacy");
  const missing = [...turns.values()].filter(t => audits.get(t.id)?.status === "missing");
  const checkpointOnly = [...audits.values()].filter(a => a.status === "checkpoint-only").length;
  const groups: Interval[][] = [];
  const group = () => { groups.push([]); return groups.length - 1; };
  const allAgent = group();
  for (const c of chunks) groups[allAgent].push({ start: Date.parse(c.start), end: Date.parse(c.end) });
  const zones = new Map<string, Map<string, Day>>();
  for (const tz of timezones) {
    const days = new Map<string, Day>(); zones.set(tz, days);
    const day = (key: string): Day => {
      let value = days.get(key);
      if (!value) { value = { agent: group(), session: group(), auto: group(), autoSplit: new Map(), gaps: [], labels: new Map(), details: new Map(), legacy: [], missing: [], conflicts: new Set(), notes: [], open: [] }; days.set(key, value); }
      return value;
    };
    const eachPart = reportDayVisitor(tz, sinceDay, day);
    for (const c of chunks) eachPart(Date.parse(c.start), Date.parse(c.end), (d, interval) => {
      groups[d.agent].push(interval);
      const label = c.label ?? turns.get(c.turnId)?.label ?? "unlabeled";
      let labelGroup = d.labels.get(label);
      if (labelGroup === undefined) { labelGroup = group(); d.labels.set(label, labelGroup); }
      groups[labelGroup].push(interval);
      const key = JSON.stringify([c.turnId, label]);
      let detail = d.details.get(key);
      if (!detail) {
        detail = { group: group(), label, ...interval, turnId: c.turnId, sessionId: c.sessionId ?? turns.get(c.turnId)?.sessionId, state: conflicts.has(c.turnId) ? "Conflicting summaries" : turns.get(c.turnId)?.outcome ?? "Unsettled/checkpoint-only", capped: false };
        d.details.set(key, detail);
      }
      detail.start = Math.min(detail.start, interval.start); detail.end = Math.max(detail.end, interval.end); detail.capped ||= c.capped;
      groups[detail.group].push(interval);
    });
    for (const s of sessions) {
      if (s.endedAt === null) { const key = localDayKey(s.startedAt, tz); if (sinceDay === null || key >= sinceDay) day(key).open.push(s.startedAt); }
      else eachPart(s.startedAt, s.endedAt, (d, interval) => groups[d.session].push(interval));
    }
    if (automatic) for (const w of automatic.windows) {
      if (w.kind === "work") eachPart(w.start, w.end, (d, interval) => {
        groups[d.auto].push(interval);
        const key = `${w.client} · ${w.task}`;
        let sub = d.autoSplit.get(key);
        if (sub === undefined) { sub = group(); d.autoSplit.set(key, sub); }
        groups[sub].push(interval);
      });
      else if (w.kind === "gap") eachPart(w.start, w.end, (d, interval) => { d.gaps.push(interval); });
    }
    for (const t of legacy) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).legacy.push(t); }
    for (const t of missing) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).missing.push(t); }
    for (const t of scopedTurns) if (conflicts.has(t.id)) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).conflicts.add(t.id); }
    for (const note of notes) { const key = localDayKey(Date.parse(note.at), tz); if (sinceDay === null || key >= sinceDay) day(key).notes.push(note); }
  }
  const totals = reconcileIntervals(groups, options);
  const mismatched = [...turns.values()].filter(t => audits.get(t.id)?.status === "mismatch");
  const oldBotLabels = [...turns.values()].filter(t => t.label === "antibot" && t.labelSource === "tools").length;
  const lines: string[] = ["# Work-time report (draft)", "", `Generated ${new Date(options.now).toISOString()} · scope ${safe(options.root)}${sinceDay ? ` · since ${sinceDay}` : ""}`, "", "Reconciliation engine: native Bend (worktime-v1; worktime-audit-v1).", ""];
  const summaries: string[] = [];
  for (const [tz, days] of zones) {
    const time = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(at));
    lines.push(`## ${tz}`, "");
    let agentTotal = 0, sessionTotal = 0, autoTotal = 0, hasAgent = false, hasSession = false, hasAuto = false;
    const labelTotals = new Map<string, number>();
    for (const [key, d] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      const measured = groups[d.agent].length > 0, attested = groups[d.session].length > 0;
      agentTotal += totals[d.agent]; sessionTotal += totals[d.session]; hasAgent ||= measured; hasSession ||= attested;
      autoTotal += totals[d.auto]; hasAuto ||= groups[d.auto].length > 0;
      lines.push(`### ${key}`, "", `- Tracked working hours: ${measured ? hours(totals[d.agent]) : "Unknown (no interval evidence)"}.`, `- Session clock: ${attested ? `user-attested ${hours(totals[d.session])}` : "Unknown (no closed session)"}.`);
      if (d.legacy.length || d.missing.length || d.conflicts.size || [...d.details.values()].some(v => audits.get(v.turnId)?.status === "mismatch")) lines.push("- Coverage is incomplete. Recorded intervals do not establish this day's full working hours.");
      for (const start of d.open) lines.push(`- Open session since ${new Date(start).toISOString()}; end Unknown.`);
      for (const [label, id] of d.labels) labelTotals.set(label, (labelTotals.get(label) ?? 0) + totals[id]);
      if (d.details.size) {
        lines.push("", "Activity windows (counted time excludes recorded waits):");
        for (const detail of [...d.details.values()].sort((a, b) => a.start - b.start)) lines.push(`- ${time(detail.start)} to ${time(detail.end)} · ${safe(detail.label)} · ${minutes(totals[detail.group])} · ${detail.state}${detail.capped ? " · capped gap" : ""} · turn ${safe(detail.turnId)}${detail.sessionId ? ` · session ${safe(detail.sessionId)}` : ""}`);
      }
      if (automatic && (groups[d.auto].length || d.gaps.length)) {
        lines.push("", "Automatic work windows (inferred elapsed time):");
        if (groups[d.auto].length) lines.push(`- Inferred work union: ${hours(totals[d.auto])} (concurrent sessions counted once).`);
        for (const [key, id] of [...d.autoSplit].sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${safe(key)}: ${hours(totals[id])} (overlaps possible; not additive).`);
        for (const g of [...d.gaps].sort((a, b) => a.start - b.start || a.end - b.end)) lines.push(`- Excluded quiet gap ${time(g.start)} to ${time(g.end)} · ${hours(g.end - g.start)} · Unknown; review before invoicing.`);
      }
      if (d.legacy.length) lines.push(`- Legacy aggregate records: ${d.legacy.length}; raw ${hours(d.legacy.reduce((sum, t) => sum + t.observedMs, 0))}. Not a full-day total, not allocated or added to interval totals.`);
      for (const t of d.missing) lines.push(`- Interval evidence missing for turn ${safe(t.id)}; duration Unallocated. Summary retained for reconciliation.`);
      for (const id of d.conflicts) lines.push(`- Conflicting summaries for turn ${safe(id)} mention this date; duration and summary labels Unallocated pending review.`);
      if (d.notes.length) {
        lines.push("", "Detailed evidence notes:");
        for (const note of d.notes) lines.push(`- ${time(Date.parse(note.at))} · ${safe(note.label)} · ${note.status} · ${safe(note.summary)} · duration Unallocated${note.turnId ? ` · linked turn ${safe(note.turnId)}` : ""}${note.evidence?.length ? ` · ${note.evidence.map(safe).join(" · ")}` : ""}`);
      }
      lines.push("");
    }
    lines.push(`- Labels (tracked, draft): ${[...labelTotals].sort(([a], [b]) => a.localeCompare(b)).map(([label, ms]) => `${safe(label)} ${hours(ms)}`).join(", ") || "none yet"}.`);
    const summary = `${tz}: user-attested ${hasSession ? hours(sessionTotal) : "Unknown"}; tracked working hours ${hasAgent ? hours(agentTotal) : "Unknown"}${automatic ? `; inferred elapsed work ${hasAuto ? hours(autoTotal) : "Unknown"}` : ""}`;
    summaries.push(summary); lines.push(`- Total shown: ${summary}.`, "");
  }
  const malformed = [options.turnsLog, options.chunksLog, options.sessionsLog, options.activitiesLog].reduce((n, p) => n + inspectJsonl(p).malformedLines, 0);
  const invalid = inspectJsonl(options.turnsLog).rows.length - allTurns.length + inspectJsonl(options.chunksLog).rows.length - allChunks.length;
  lines.push("Notes:",
    `- Tracked working hours are the wall-clock union of recorded intervals (all dates: ${hours(totals[allAgent])}). Concurrent tabs and duplicate receipts are deduplicated by native Bend.`,
    `- Legacy aggregate records: ${legacy.length} (all dates). Only unpaired, pre-marker summaries are legacy pre-chunk turns; never add them to interval totals.`,
    `- Unsettled/checkpoint-only turns: ${checkpointOnly}; missing interval evidence: ${missing.length} (all dates).`,
    `- Rejected JSON lines: ${malformed}; invalid turn/interval records: ${invalid}. Source ledgers are not rewritten.`,
    ...mismatched.map(t => `- Interval mismatch for turn ${safe(t.id)}: summary ${minutes(t.observedMs)}, durable intervals ${minutes(audits.get(t.id)!.durableMs)}. Reconcile missing or conflicting evidence before invoicing.`),
    ...[...conflicts].map(id => `- Conflicting summaries for turn ${safe(id)}: no last-writer selection. Original receipts retained; only independent interval evidence contributes to tracked totals.`),
    `- Native receipt audit: ${conflicts.size} conflicting groups; ${[...audits.values()].filter(a => a.status !== "conflict" && a.summaryCopies > 1).length} exact-duplicate summary groups, counted once. This is consistency checking, not cryptographic verification.`,
    ...(oldBotLabels ? [`- Historical tool-only antibot labels needing review: ${oldBotLabels}. Generic browser use is not anti-bot evidence; old records are retained unchanged.`] : []),
    "- Session-clock hours and tracked turn hours are separate measures; never add the same time twice. Review before invoicing.",
    "- A capped silent gap (max 5 min per gap) is an estimate, not continuous evidence. Missing coverage and open ends stay Unknown.",
    ...(automatic ? [
      `- Automatic work windows are inferred elapsed time around observed activity; quiet gaps up to ${minutes(automatic.idleGapMs)} join and longer gaps are excluded. They are not proof of continuous human presence and capture nothing outside Pi.`,
      "- Inferred elapsed work, tracked agent turns and the manual session clock are separate measures; never add the same time twice.",
    ] : []),
    "- Labels are heuristic drafts unless explicitly supplied. Per-label totals may overlap across concurrent sessions.",
    "- Notes document outcomes, not extra duration. A verification date is not a publication date. No external sync is performed.", "");
  return { text: lines.join("\n"), summary: summaries.join(" | ") };
}

/** Cross-workspace draft over inferred work windows only; agent/manual receipts stay in their per-project reports. */
export function buildAutomaticReport(options: AutomaticReportOptions): { text: string; summary: string } {
  const { timezones, sinceDay } = options;
  const work = options.windows.filter(w => w.kind === "work");
  const gaps = options.windows.filter(w => w.kind === "gap");
  const groups: Interval[][] = [];
  const group = () => { groups.push([]); return groups.length - 1; };
  interface AutoDay { union: number; split: Map<string, number>; roots: Map<string, number>; gaps: Array<Interval & { root: string }> }
  const zones = new Map<string, Map<string, AutoDay>>();
  for (const tz of timezones) {
    const days = new Map<string, AutoDay>(); zones.set(tz, days);
    const day = (key: string): AutoDay => {
      let value = days.get(key);
      if (!value) { value = { union: group(), split: new Map(), roots: new Map(), gaps: [] }; days.set(key, value); }
      return value;
    };
    const eachPart = reportDayVisitor(tz, sinceDay, day);
    for (const w of work) eachPart(w.start, w.end, (d, interval) => {
      groups[d.union].push(interval);
      const key = `${w.client} · ${w.task}`;
      let sub = d.split.get(key);
      if (sub === undefined) { sub = group(); d.split.set(key, sub); }
      groups[sub].push(interval);
      let rootGroup = d.roots.get(w.root);
      if (rootGroup === undefined) { rootGroup = group(); d.roots.set(w.root, rootGroup); }
      groups[rootGroup].push(interval);
    });
    for (const w of gaps) eachPart(w.start, w.end, (d, interval) => { d.gaps.push({ ...interval, root: w.root }); });
  }
  const totals = reconcileIntervals(groups, options);
  const lines: string[] = ["# Automatic work-window report (draft)", "", `Generated ${new Date(options.now).toISOString()} · database ${safe(options.scope)}${sinceDay ? ` · since ${sinceDay}` : ""}`, "", "Inferred elapsed work windows across workspaces, reconciled by native Bend (worktime-v1).", ""];
  const summaries: string[] = [];
  for (const [tz, days] of zones) {
    const time = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(at));
    lines.push(`## ${tz}`, "");
    let total = 0, hasAny = false;
    for (const [key, d] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      const measured = groups[d.union].length > 0;
      hasAny ||= measured; total += totals[d.union];
      lines.push(`### ${key}`, "", `- Inferred elapsed work (union): ${measured ? hours(totals[d.union]) : "Unknown (no interval evidence)"}.`);
      for (const [root, id] of [...d.roots].sort(([a], [b]) => a.localeCompare(b))) lines.push(`- Workspace ${safe(root)}: ${hours(totals[id])} (overlaps possible across concurrent sessions; not additive).`);
      for (const [label, id] of [...d.split].sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${safe(label)}: ${hours(totals[id])} (client/task subtotal; overlaps possible; not additive).`);
      for (const g of [...d.gaps].sort((a, b) => a.start - b.start || a.end - b.end || a.root.localeCompare(b.root))) lines.push(`- Excluded quiet gap ${time(g.start)} to ${time(g.end)} · ${hours(g.end - g.start)} · workspace ${safe(g.root)} · Unknown; review before invoicing.`);
      lines.push("");
    }
    const summary = `${tz}: inferred elapsed work ${hasAny ? hours(total) : "Unknown (no interval evidence)"}`;
    summaries.push(summary); lines.push(`- Total shown: ${summary}.`, "");
  }
  lines.push("Notes:",
    `- Windows join observed activity across quiet gaps of at most ${minutes(options.idleGapMs)}; longer gaps are excluded and stay Unknown. This is a configurable inference policy, not proof of continuous human work.`,
    "- Per-workspace and per-client/task subtotals may overlap; only the daily union deduplicates concurrent sessions. Never add subtotals.",
    "- Windows survive restarts and /reload in the shared SQLite database. Repository-local agent turn receipts and manual session clocks are separate measures and are not included here.",
    "- Nothing outside Pi is observed; there is no external activity detector. Review before invoicing; no external sync is performed.", "");
  return { text: lines.join("\n"), summary: summaries.join(" | ") };
}
