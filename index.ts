import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTimeTrackingExtension } from "./extension.ts";

export { createTimeTrackingExtension, type TimeTrackingOptions } from "./extension.ts";

/** Default package activation tracks the host's initial working directory. */
export default function piTimeTracker(pi: ExtensionAPI): void {
  createTimeTrackingExtension()(pi);
}
