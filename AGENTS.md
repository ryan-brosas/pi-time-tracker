# Agent Rules

The user's global `AGENTS.md` supplies standing rules. This file adds
project-specific context, not exceptions. Surface conflicts for clarification.

## Context

[README.md](README.md) owns the project's purpose, usage, architecture and
non-goals. Use its [development setup](README.md#run-from-source) and
[release procedure](README.md#publishing-a-release), rather than creating parallel
setup or release instructions. [SECURITY.md](SECURITY.md) owns reporting and
private-data boundaries. [REVIEW.md](REVIEW.md) is historical evidence, not a
current verification result.

## Checks

```sh
bun run check
bun run test
bun run pack:check
```

The full suite needs the pinned Bend binary, matching compiler source and Clang;
follow the README setup even though normal package use is compiler-free. For
policy or release changes, also run the drift, proof and compiler-free artifact
checks defined in [CI](.github/workflows/ci.yml).

## Project rules and traps

- Change accounting policy in `engine.bend`, `audit.bend` and `batch.bend`, then
  regenerate with `bun run build:bend`. Do not hand-edit `generated/policy.mjs`
  or add a second interval-union/receipt-classification implementation in
  TypeScript. The generated and native lanes share the same Bend sources.
- Keep the default report path compiler-free. In `native.ts`, `BEND_EXECUTABLE`
  and `WORKTIME_BEND_BINARY` explicitly select the native lane; unset them when
  verifying the generated default. A configured native failure must not silently
  fall back to another engine.
- Preserve the distinction between measured agent intervals, user-attested
  sessions and inferred work windows. Missing evidence stays Unknown or
  Unallocated, not zero or a guessed full-day total; outcome notes do not prove
  duration. Keep report totals separated by timezone (`report.test.ts`).
- `session_before_switch` can be vetoed: checkpoint there without tearing down
  tracking. Confirmed teardown belongs to `session_shutdown`; preserve the
  cancelled-switch regression in `automatic-extension.test.ts`.
- A checkout and an npm package with the same version need not contain the same
  code. Verify the published artifact before changing install claims. Merging
  does not publish npm; follow the README's explicit release workflow.
