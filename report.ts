import { readActivities, type ActivityNote } from "./activities.ts";
import { inspectJsonl, localDayKey, readChunks, readTurnRecords, readWorkSessions, splitIntervalByLocalDay, type Interval, type TimeRecord } from "./ledger.ts";
import { auditTurnReceipts, reconcileIntervals, type NativeOptions } from "./native.ts";

export const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
export const hours = (ms: number) => `${(ms / 3600000).toFixed(2)} h`;
export interface ReportOptions extends NativeOptions {
  root: string; scopePrefix: string; timezones: string[]; now: number; sinceDay: string | null;
  turnsLog: string; chunksLog: string; sessionsLog: string; activitiesLog: string;
}
const safe = (text: string) => text.replace(/[\r\n]/g, " ").replace(/[<>|`]/g, "");
interface Detail { group: number; label: string; start: number; end: number; turnId: string; sessionId?: string; state: string; capped: boolean }
interface Day {
  agent: number; session: number; labels: Map<string, number>; details: Map<string, Detail>;
  legacy: TimeRecord[]; missing: TimeRecord[]; conflicts: Set<string>; notes: ActivityNote[]; open: number[];
}

/** Calendar preparation/rendering in JS; every interval union is owned by native Bend. */
export function buildWorkReport(options: ReportOptions): { text: string; summary: string } {
  const { scopePrefix, timezones, sinceDay } = options;
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
      if (!value) { value = { agent: group(), session: group(), labels: new Map(), details: new Map(), legacy: [], missing: [], conflicts: new Set(), notes: [], open: [] }; days.set(key, value); }
      return value;
    };
    const eachPart = (start: number, end: number, fn: (d: Day, interval: Interval) => void) => {
      let cursor = start;
      for (const part of splitIntervalByLocalDay(start, end, tz)) {
        const interval = { start: cursor, end: cursor + part.ms }; cursor = interval.end;
        if (sinceDay === null || part.day >= sinceDay) fn(day(part.day), interval);
      }
    };
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
    for (const t of legacy) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).legacy.push(t); }
    for (const t of missing) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).missing.push(t); }
    for (const t of scopedTurns) if (conflicts.has(t.id)) { const key = localDayKey(Date.parse(t.startedAt), tz); if (sinceDay === null || key >= sinceDay) day(key).conflicts.add(t.id); }
    for (const note of notes) { const key = localDayKey(Date.parse(note.at), tz); if (sinceDay === null || key >= sinceDay) day(key).notes.push(note); }
  }
  const totals = reconcileIntervals(groups, options);
  const mismatched = [...turns.values()].filter(t => audits.get(t.id)?.status === "mismatch");
  const oldBotLabels = [...turns.values()].filter(t => t.label === "antibot" && t.labelSource === "tools").length;
  const lines: string[] = ["# Work-time report (draft)", "", `Generated ${new Date(options.now).toISOString()} · scope ${options.root}${sinceDay ? ` · since ${sinceDay}` : ""}`, "", "Reconciliation engine: native Bend (worktime-v1; worktime-audit-v1).", ""];
  const summaries: string[] = [];
  for (const [tz, days] of zones) {
    const time = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(at));
    lines.push(`## ${tz}`, "");
    let agentTotal = 0, sessionTotal = 0, hasAgent = false, hasSession = false;
    const labelTotals = new Map<string, number>();
    for (const [key, d] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      const measured = groups[d.agent].length > 0, attested = groups[d.session].length > 0;
      agentTotal += totals[d.agent]; sessionTotal += totals[d.session]; hasAgent ||= measured; hasSession ||= attested;
      lines.push(`### ${key}`, "", `- Tracked working hours: ${measured ? hours(totals[d.agent]) : "Unknown (no interval evidence)"}.`, `- Session clock: ${attested ? `user-attested ${hours(totals[d.session])}` : "Unknown (no closed session)"}.`);
      if (d.legacy.length || d.missing.length || d.conflicts.size || [...d.details.values()].some(v => audits.get(v.turnId)?.status === "mismatch")) lines.push("- Coverage is incomplete. Recorded intervals do not establish this day's full working hours.");
      for (const start of d.open) lines.push(`- Open session since ${new Date(start).toISOString()}; end Unknown.`);
      for (const [label, id] of d.labels) labelTotals.set(label, (labelTotals.get(label) ?? 0) + totals[id]);
      if (d.details.size) {
        lines.push("", "Activity windows (counted time excludes recorded waits):");
        for (const detail of [...d.details.values()].sort((a, b) => a.start - b.start)) lines.push(`- ${time(detail.start)} to ${time(detail.end)} · ${safe(detail.label)} · ${minutes(totals[detail.group])} · ${detail.state}${detail.capped ? " · capped gap" : ""} · turn ${safe(detail.turnId)}${detail.sessionId ? ` · session ${safe(detail.sessionId)}` : ""}`);
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
    const summary = `${tz}: user-attested ${hasSession ? hours(sessionTotal) : "Unknown"}; tracked working hours ${hasAgent ? hours(agentTotal) : "Unknown"}`;
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
    "- Labels are heuristic drafts unless explicitly supplied. Per-label totals may overlap across concurrent sessions.",
    "- Notes document outcomes, not extra duration. A verification date is not a publication date. No external sync is performed.", "");
  return { text: lines.join("\n"), summary: summaries.join(" | ") };
}
