# pi-time-tracker

Local working-hours receipts for Pi, with native Bend reconciliation and consistency checks.

[Repository](https://github.com/ryan-brosas/pi-time-tracker) · [CI](https://github.com/ryan-brosas/pi-time-tracker/actions/workflows/ci.yml)

The source repository is public; work records stay private and local. This is not an npm release. No open-source license has been granted: the package remains `UNLICENSED` and `private: true` until the owner chooses a distribution license.

## What it does

- Automatically records Pi activity in the tracked project and its real subdirectories.
- Excludes blocking prompt waits and limits silent gaps to five minutes.
- Saves event-driven checkpoints so a missing final summary does not erase all evidence.
- Uses native Bend to deduplicate overlapping intervals and audit missing, duplicate or conflicting receipts.
- Provides a separate explicit session clock and a `work_note` tool for concise, sanitized outcomes.
- Produces daily working-hours drafts. No external sync, model calls, background service or automatic invoicing.

Tracking is partial evidence, not a confirmed full-day timesheet. Missing coverage and open session ends stay Unknown. Notes never create additional duration. Review working hours before using them in a timesheet or invoice.

## Install and activate

Requirements: a Pi 0.87.1-compatible host, a native Bend compiler (tested with 2.0.7 and 2.0.31), Clang compatible with that compiler, and Bun for development checks. CI uses Bun 1.4.0, Bend 2.0.31 and Clang 19 on Linux x64. Install Bend using its [official instructions](https://bend-lang.com/); older and current releases have different installation layouts.

```sh
git clone https://github.com/ryan-brosas/pi-time-tracker.git
cd pi-time-tracker
bun install --frozen-lockfile --ignore-scripts
BEND_NO_TELEMETRY=1 bend --help
bun run check
bun run test
```

Add the local package to a project with `pi install /absolute/path/to/pi-time-tracker --local`, or add `/absolute/path/to/pi-time-tracker/index.ts` to that project's `.pi/settings.json` extensions list. Load it only once: choose the package entry point or a project adapter, not both. Approve project trust yourself and use `/reload` at an idle boundary.

The default entry point binds to Pi's initial context working directory, not the package checkout and not `process.cwd()`. It uses the `work` scope and the host's local timezone. That root remains pinned for the loaded runtime; reload when changing projects. Each factory invocation has independent state.

For a project-specific adapter, import `createTimeTrackingExtension` from `index.ts` and supply an explicit root and options:

```ts
import { createTimeTrackingExtension } from "/absolute/path/to/pi-time-tracker/index.ts";

export default createTimeTrackingExtension("/absolute/path/to/project", {
  scopePrefix: "client",
  timezones: ["UTC"],
  legacyCommandNames: ["client-time"],
});
```

Commands, file paths, the clock and native executable/cache paths are configurable through `TimeTrackingOptions`. The built-in draft label registry lives in `labels.ts`; labels are heuristics, not verified descriptions of all work.

## Commands

- `/work start [label]`, `/work stop [note]`, `/work status`: explicit session clock.
- `/work time`: native interval-union total, excluding legacy aggregates.
- `/work report [YYYY-MM-DD]`: per-day report in the configured timezones. The optional date selects days on or after it.
- `work_note`: model-callable tool recording one sanitized outcome with a verification status and evidence references. The agent receives guidance to use it at completed milestones, but a note is not guaranteed for every turn.

Session-clock hours and tracked activity are separate views. Do not add overlapping time twice. A note's recording time does not prove the publication time of an older artifact. Unsupported activity-level duration remains Unallocated.

## Native Bend responsibilities

`engine.bend` owns interval ordering, merging and totals. `audit.bend` owns receipt classification: consistent, legacy, missing intervals, checkpoint-only, mismatched totals and conflicting summaries.

Exact duplicate summaries are idempotent. Summaries sharing an ID but differing in normalized metadata are conflicts, not a last-writer-wins update. Ambiguous summary labels and legacy amounts are excluded from the report, while independent interval evidence is retained. Unsupported interval markers and fractional milliseconds are rejected rather than silently treated as legacy. These are consistency checks, not cryptographic authentication.

`native.ts` prepares numeric transport and manages bounded child processes. `extension.ts` owns Pi hooks, `ledger.ts` owns persistence/calendar boundaries, `activities.ts` owns evidence notes, and `report.ts` renders native results. There is no parallel JavaScript implementation of interval union or receipt classification.

The first data-bearing command compiles an engine into `$XDG_CACHE_HOME/pi-worktime-native`, defaulting to `~/.cache/pi-worktime-native`. The cache hash includes every local `.bend` module. Build calls disable Bend launcher telemetry and automatic updates. Nothing upgrades or installs a compiler automatically.

`BEND_EXECUTABLE` selects the compiler. `WORKTIME_BEND_BINARY` selects a trusted prebuilt engine. Factory options also include `bendExecutable`, `nativeExecutable` and `cacheDir`. Prebuilt engines must be rebuilt after Bend changes. The original interval CLI protocol remains supported; receipt auditing adds the `audit` mode. Each numeric batch is limited to just under 8 MiB and fails explicitly if too large. There is no silent JavaScript fallback.

## Storage and privacy

The default files belong to the tracked project, under its `exports/` directory:

- `pi-worktime.jsonl`: per-turn summaries.
- `pi-worktime-chunks.jsonl`: counted intervals and checkpoint identity.
- `work-sessions.jsonl`: explicit session-clock events.
- `work-activities.jsonl`: timestamped outcome notes.
- `work-report.md`: generated draft.

Ignore these files in every project where tracking is enabled. They are written with mode 0600. Automatic capture does not persist prompts, tool arguments or file contents. Keep credentials, customer data and private messages out of all free-text labels and notes. Note validation rejects common email/credential patterns and query-bearing URLs, but is not a complete data-loss-prevention system.

Bend receives numeric group IDs, timestamps, durations, counts, flags and interned variant IDs in private temporary files, removed after each command. No summary text or labels are sent to it. Existing ledgers are not rewritten or migrated; malformed lines and missing/conflicting evidence are disclosed.

Checkpoints support process recovery, not power-loss guarantees or backups. Non-Pi work, work before tracking began, uncaptured gaps and breaks need separate evidence or confirmation.

## Development checks

Keep Pi callbacks, filesystem access and IANA timezone handling in their host adapter. Put deterministic accounting policy in the side-effect-free Bend reducer, not a per-event subprocess. Preserve or version wire contracts, include imported modules in the build hash, and test the actual compiled executable and Pi loader. Accumulate output rows and join once rather than repeatedly appending a growing string.

Tests cover interval properties, checkpoints, pauses, scope escapes, independent host projects, midnight/DST boundaries, privacy, receipt replay/conflicts, wire rejection, imported-module cache invalidation and real Pi registration. Use `bun run check` and `bun run test` before changing a consuming project's adapter. The test timeout accommodates cold native compilation.

The `CI` workflow runs those same gates on pushes to `main` and pull requests, with read-only permissions and SHA-pinned Actions. `scripts/install-bend-ci.sh` downloads an exact official Bend release, verifies its SHA-256, and installs only into a new explicitly supplied directory. It does not modify an existing compiler. Update its version and digest together and verify the full suite before changing the pin. Dependabot proposes weekly Action-pin updates; it does not merge them.

Use synthetic reproductions in issues and pull requests. Never publish your `exports/` directory or real activity notes.

## Source-grounded reference

Sourcebot supplied pinned source from [inloopstudio-team/pi-ledger](https://github.com/inloopstudio-team/pi-ledger) at `29cd1b0edd99727bac2cbb9b2003bebbb457c593`:

- [`verifySidecarChain`](https://github.com/inloopstudio-team/pi-ledger/blob/29cd1b0edd99727bac2cbb9b2003bebbb457c593/extensions/pi-ledger/index.ts#L966-L1015).
- Its [direct integrity tests](https://github.com/inloopstudio-team/pi-ledger/blob/29cd1b0edd99727bac2cbb9b2003bebbb457c593/extensions/pi-ledger/__tests__/notarization.test.ts#L234-L281).

Adapted: inspectable receipts, explicit evidence states, and reporting inconsistencies instead of silently accepting them. Omitted: signing/key management, token-normalized billing and the reference's business policy. No reference source code was copied. Our audit cannot provide its cryptographic guarantees.

This working tree and the Bend compiler were not indexed during that review. Local source, installed `Base` definitions, SDK checks and regression tests establish current behavior. The indexed reference is prior art, not proof that this code works.
