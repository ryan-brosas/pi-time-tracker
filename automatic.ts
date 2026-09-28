import { randomUUID } from "node:crypto";
import { isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import { ProjectStore, type WorkWindow, type Workspace } from "./project-store.ts";

export const DEFAULT_IDLE_GAP_MS = 15 * 60_000;
const CHECKPOINT_MS = 10_000;

/** Decode only presence, never persist keys, pasted text, prompts or tool payloads. */
export function isHumanInput(data: string): boolean {
  if (!data || isKeyRelease(data)) return false;
  // Focus reports, device responses and mouse motion are not proof of work.
  if (/^\x1b\[(?:I|O|<)/.test(data) || /^\x1b\]/.test(data)) return false;
  if (parseKey(data) !== undefined) return true;
  const paste = data.replace(/\x1b\[20[01]~/g, "");
  return !paste.includes("\x1b") && /[^\x00-\x1f\x7f]/u.test(paste);
}

/** An evidence-bounded elapsed clock. Open session lifetime never supplies an end. */
export class AutomaticClock {
  private current?: WorkWindow;
  private last?: WorkWindow;
  private persistedEnd = -1;
  constructor(private store: ProjectStore, private workspace: Workspace, private sessionId: string, private task: string, private idleGapMs = DEFAULT_IDLE_GAP_MS) {
    if (!Number.isSafeInteger(idleGapMs) || idleGapMs <= 0) throw new Error("idleGapMs must be a positive integer");
    this.last = store.latest(workspace.root, sessionId);
  }
  touch(at: number, checkpoint = false): void {
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new Error("Invalid activity timestamp");
    let previous = this.current ?? this.last;
    if (previous && at < previous.end) {
      // A backward clock must not manufacture time, but it must not freeze capture either:
      // keep what was already observed, then re-anchor from this observed timestamp.
      this.flush();
      this.current = undefined;
      this.last = undefined;
      previous = undefined;
    }
    const same = previous?.client === this.workspace.client && previous.task === this.task;
    const gap = previous ? at - previous.end : 0;
    if (!this.current || !same || gap > this.idleGapMs) {
      this.flush();
      if (previous && gap > this.idleGapMs) {
        this.store.save({ ...previous, id: randomUUID(), start: previous.end, end: at, kind: "gap" });
      }
      this.current = { ...this.workspace, id: randomUUID(), sessionId: this.sessionId, task: this.task, start: previous && same && gap <= this.idleGapMs ? previous.end : at, end: at, kind: "work" };
      this.persistedEnd = -1;
    } else this.current.end = at;
    if (checkpoint || this.persistedEnd < 0 || at - this.persistedEnd >= CHECKPOINT_MS) this.flush();
  }
  flush(): void {
    if (this.current && this.persistedEnd !== this.current.end) {
      this.store.save(this.current);
      this.persistedEnd = this.current.end;
    }
  }
}
