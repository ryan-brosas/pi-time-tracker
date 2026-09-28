import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTimeTrackingExtension } from "./extension.ts";

export { createTimeTrackingExtension, parseReportDay, type TimeTrackingOptions } from "./extension.ts";
export { ProjectStore, containsPath, repositoryRoot, defaultDatabasePath, projectText, type WorkWindow, type Workspace } from "./project-store.ts";
export { AutomaticClock, isHumanInput, DEFAULT_IDLE_GAP_MS } from "./automatic.ts";
export { buildAutomaticReport, type AutomaticReportOptions } from "./report.ts";

/** Default package activation tracks the host's initial working directory. */
export default function piTimeTracker(pi: ExtensionAPI): void {
  createTimeTrackingExtension()(pi);
}
