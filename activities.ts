import { Type } from "typebox";
import { createHash } from "node:crypto";
import { appendJsonl, inspectJsonl } from "./ledger.ts";
import { TASK_LABELS } from "./labels.ts";

export const workNoteParameters = Type.Object({
  label: Type.Union(TASK_LABELS.map(l => Type.Literal(l.key))),
  summary: Type.String({ minLength: 1, maxLength: 320, description: "A brief sanitized activity/outcome, never raw conversation or customer data." }),
  status: Type.Union([Type.Literal("verified"), Type.Literal("user-reported"), Type.Literal("draft"), Type.Literal("blocked"), Type.Literal("planned")]),
  evidence: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 5 })),
}, { additionalProperties: false });
export interface WorkNoteInput { label: string; summary: string; status: "verified" | "user-reported" | "draft" | "blocked" | "planned"; evidence?: string[] }
export interface ActivityNote extends WorkNoteInput { version: 1; id: string; scope: string; at: string; sessionId: string; turnId?: string }
const statuses = new Set(["verified", "user-reported", "draft", "blocked", "planned"]);
const privateText = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:sk-|ghp_|xox[baprs]-)[\w-]{8,}|\bbearer\s+[\w.\/+=-]{8,}|\b(?:api[_ -]?key|password|token)\s*[:=]\s*\S+/i;

export function validateNote(input: WorkNoteInput): WorkNoteInput {
  if (!input || !TASK_LABELS.some(l => l.key === input.label) || !statuses.has(input.status)) throw new Error("Use a registered task label and evidence status");
  if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 320 || /[\r\n]/.test(input.summary)) throw new Error("Summary must be one short line (1–320 characters)");
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 5 || evidence.some(e => typeof e !== "string" || !e.trim() || e.length > 240 || /[\r\n]/.test(e))) throw new Error("Use at most five short evidence references");
  if ([input.summary, ...evidence].some(s => privateText.test(s))) throw new Error("Remove email addresses, credentials and private data from the work note");
  for (const ref of evidence) if (ref.includes("://")) {
    const url = new URL(ref);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search) throw new Error("Evidence URLs must not contain credentials or query parameters");
  }
  return { label: input.label, summary: input.summary.trim(), status: input.status, evidence };
}

export function readActivities(path: string): ActivityNote[] {
  const notes = new Map<string, ActivityNote>();
  for (const row of inspectJsonl(path).rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as ActivityNote;
    if (r.version !== 1 || typeof r.id !== "string" || typeof r.scope !== "string" || typeof r.sessionId !== "string" || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
    try { notes.set(r.id, { ...validateNote(r), version: 1, id: r.id, scope: r.scope, at: r.at, sessionId: r.sessionId, ...(typeof r.turnId === "string" ? { turnId: r.turnId } : {}) }); } catch { /* rejected metadata is not evidence */ }
  }
  return [...notes.values()];
}

export function appendActivity(path: string, input: WorkNoteInput, context: { callId: string; scope: string; at: number; sessionId: string; turnId?: string }): ActivityNote {
  const clean = validateNote(input);
  const id = createHash("sha256").update(`${context.scope}:${context.sessionId}:${context.callId}`).digest("hex");
  const previous = readActivities(path).find(n => n.id === id);
  if (previous) return previous;
  const note: ActivityNote = { ...clean, version: 1, id, scope: context.scope, at: new Date(context.at).toISOString(), sessionId: context.sessionId, ...(context.turnId ? { turnId: context.turnId } : {}) };
  appendJsonl(path, note);
  return note;
}
