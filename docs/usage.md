# Usage and configuration

For installation and a quick start, see the [README](../README.md). These commands
run inside Pi, not your shell. Load the tracker only once: use the package's
default entry point or a project-specific adapter, never both.

## Automatic tracking and `/project`

Work is detected automatically. The folder or repo you opened Pi in maps to a
client workspace; optionally label it once and sessions — including resume and
`/reload` — inherit it. Without a label, the workspace folder's name is used:

```text
/project set Coral        # label this workspace's client, once
/project task invoices    # optional task for this Pi session
/project status           # client, task, policy and database path
/project report           # daily draft for this workspace
/project report 2025-01-15 # daily draft from this date onward
/project report all       # every workspace, from the shared database
```

- Work windows open on first observed activity — typed input, submitted
  prompts, agent turns and tool traffic — and stop advancing when activity stops.
- Quiet gaps up to `idleGapMs` (default 15 minutes) join into work; longer
  gaps are recorded separately and stay **Unknown**, never silently counted.
- An open session does not bill wall-clock lifetime: time advances only on
  observed activity, so an idle overnight session adds nothing.
- A backward system clock cannot invent time: prior windows stay exactly as
  recorded, capture restarts from a fresh zero-duration window at the observed
  timestamp, and no elapsed time is inferred across the jump.
- Windows carry the client and session task active when they happened; later
  renames never rewrite recorded rows.
- Concurrent sessions in one workspace overlap: reports count the interval
  union once, using the same Bend reconciliation as agent receipts.
- Keep one Pi process per saved session. Resuming one session file in two
  processes at once records overlapping raw window rows for that session;
  reports still count the union once, but review those rows before invoicing.
- A busy shared database no longer stops capture: the clock keeps the latest
  activity in memory, says so in the status line, and retries on the next
  event, report or session handover. Permanent storage failures still disable
  automatic tracking until the next session; missing activity is not reconstructed.
- Inferred elapsed work, agent-turn receipts and the manual `/work` session
  clock stay separate measures; never add the same time twice. Nothing
  outside Pi is observed, and hours are drafts until reviewed — no automatic
  invoicing.

## Session clock and notes

These are Pi slash commands, not shell commands:

```text
/work start documentation
/work status
/work stop finished the README
/work time
/work report
```

| Command or tool | What it does |
| --- | --- |
| `/work start [label]` | Start an explicit session clock. |
| `/work stop [note]` | Close the session; its hours remain pending review. |
| `/work status` | Show whether a session is open. |
| `/work time` | Show the interval-union total, excluding legacy aggregates. |
| `/work report [YYYY-MM-DD]` | Write a daily report, optionally from a date onward. |
| `work_report` | Answer a question about tracked hours from the recorded ledgers and refresh the same draft. |
| `work_note` | Let the agent record a sanitized outcome and evidence status, without adding time. |

`work_report` and `work_note` are model-callable tools, not slash commands. Ask
how many hours you tracked in plain language and the agent calls `work_report`
and quotes the returned per-timezone summary instead of reading receipt logs or
recomputing totals. The tool measures recorded intervals only: days without
evidence stay Unknown, and the user-attested session clock, tracked agent-turn
hours and inferred automatic windows are never added together.

## How detailed is the report?

Timing evidence and narrative evidence are separate, and only one of them is
captured automatically:

- **Automatic:** per-turn intervals, their heuristic labels, session identity,
  capped gaps and the automatic work windows per client and task.
- **Narrative:** a label, a one-line outcome, an evidence status (verified,
  user-reported, draft, blocked or planned), optional links, and the turn or session
  it belongs to — recorded only when `work_note` runs.

The tracker does not automatically capture prompts, transcripts or file contents.
Keep customer data and credentials out of explicitly supplied notes. A day with
no notes reports that no outcome notes were recorded instead of inventing detail.
The extension guides the agent to record milestones, but it cannot guarantee a
note for every turn. The extension makes no model calls of its own.

## Project configuration

By default, the tracker binds to Pi's initial context working directory, not the
package checkout or `process.cwd()`. It uses the `work` scope and your host's
local timezone. The root stays pinned for that loaded runtime; reload when
changing projects. Separate factory invocations keep independent state.

For an explicit project root, scope or timezone, use an adapter:

```ts
import { createTimeTrackingExtension } from "/path/to/pi-time-tracker/index.ts";

export default createTimeTrackingExtension("/path/to/project", {
  scopePrefix: "client",
  timezones: ["UTC"],
  legacyCommandNames: ["client-time"],
});
```

[TimeTrackingOptions](../extension.ts) also exposes command names, storage paths,
the clock and native settings, plus `databasePath`, `idleGapMs` and
`projectCommand` for automatic tracking. An explicit `databasePath` must be
absolute. `projectCommand` is a nonempty token using letters, digits, `_` or `-`,
without a leading slash, and must not collide with another tracker command.
Factory options take precedence over executable, cache and database environment
defaults.

- `WORKTIME_DB_PATH` moves the shared SQLite database; `databasePath` wins.
  Without either override, it lives under `XDG_STATE_HOME` (default
  `~/.local/state`) at `pi-time-tracker/tracker.sqlite`.
- `BEND_EXECUTABLE` opts into the native lane and selects the Bend compiler; without
  a native-lane selector the tracker runs `generated/policy.mjs`. Setting it alone
  compiles the engine on first use and needs Bend plus a Clang-compatible C toolchain
  on `PATH`.
- `WORKTIME_BEND_BINARY` opts into the native lane with a trusted prebuilt engine
  instead of compiling; it needs no local Bend compiler or Clang.
- `XDG_CACHE_HOME` sets the cache base for a compiled engine, defaulting to
  `~/.cache`. The engine lives under `pi-worktime-native` and is unused by the
  generated default.

The corresponding factory options are `databasePath`, `bendExecutable`,
`nativeExecutable` and `cacheDir`. Any of `bendExecutable`, `nativeExecutable`,
`BEND_EXECUTABLE` or `WORKTIME_BEND_BINARY` selects the native lane; `cacheDir`
alone does not. If several selectors are set, `nativeExecutable` takes precedence
over `WORKTIME_BEND_BINARY`, which takes precedence over `bendExecutable`, then
`BEND_EXECUTABLE`; `bendExecutable` likewise takes precedence over the environment
compiler. A native failure is reported, never silently replaced by the generated
policy. Rebuild prebuilt engines after changing Bend policy. Build and proof checks
disable Bend telemetry and automatic updates; native compilation disables telemetry
but does not disable Bend automatic updates.

## Local storage and privacy

Receipt, session, note and workspace-report files belong to the tracked project,
not the extension's checkout. By default, sessions started inside a Git repository
share its root `exports/` directory; without Git, the starting folder is used.
An explicitly configured adapter root still takes precedence. Existing receipts in
subfolder `exports/` directories are not moved or merged automatically; review
them before relying on a repo-root report:

| File under `exports/` | Contents |
| --- | --- |
| `pi-worktime.jsonl` | Per-turn summaries. |
| `pi-worktime-chunks.jsonl` | Counted intervals and checkpoint identity. |
| `work-sessions.jsonl` | Explicit session-clock events. |
| `work-activities.jsonl` | Timestamped outcome notes. |
| `work-report.md` | Generated working-hours draft. |

Automatic windows, workspace mappings and session tasks live in one shared
SQLite database, created with mode `0600`. Its default is
`~/.local/state/pi-time-tracker/tracker.sqlite`; see the environment overrides
above. It uses WAL, a five-second busy timeout and full synchronous writes so
several Pi processes can track concurrently; a symlinked database path is refused.
`/project report all` writes `automatic-work-report.md` next to the database,
independently of `reportFile`. It includes automatic windows across workspaces,
not repository-local agent receipts or manual session clocks.

Exclude the `exports/` files (also written with mode `0600`) from Git in every
tracked project. If the database is inside a repository, also ignore its exact
path, its `-wal`, `-shm` and `-journal` sidecars, and the sibling
`automatic-work-report.md`. Automatic capture does not persist prompts, tool
arguments or file contents. Keep credentials, customer data and private messages
out of free-text labels and notes. The `work_note` validator rejects common
credential and email patterns and query-bearing URLs; it is not complete
data-loss prevention.

Bend receives numeric IDs, timestamps, durations, counts and flags, not summary
text or labels. Its private temporary input files are removed after each command.
Source ledgers are not rewritten; malformed lines and missing or conflicting
evidence are disclosed in the report.

## Reading a report

- Session-clock hours, agent-turn activity and automatic work windows are separate
  views. Do not add the same time twice.
- Automatic windows are inferred elapsed time around observed activity. Excluded
  gaps longer than `idleGapMs` (default 15 minutes) stay **Unknown**; review them
  before invoicing.
- Agent-turn receipts exclude blocking prompt waits and cap silent gaps within
  a turn at five minutes. That cap is an estimate, not proof of uninterrupted
  work; it is separate from the automatic-window join limit.
- Missing coverage and open session ends stay **Unknown**. Work outside Pi and
  uncaptured time need separate evidence or confirmation.
- Labels are heuristic drafts. Per-label totals can overlap across concurrent
  sessions, even though the overall interval total is deduplicated.
- Notes never create duration. Their recording time does not establish an older
  artifact's publication time; unsupported activity duration stays Unallocated.
- Legacy aggregates are not added to interval totals. Conflicting summaries do
  not use last-writer-wins selection; independent interval evidence is retained.

Checkpoints help recover from interrupted processes. They are not backups or
power-loss guarantees. Review the report before using it in a timesheet or invoice.
