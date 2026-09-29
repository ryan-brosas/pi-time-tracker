<div align="center">

# pi-time-tracker

**Automatic work tracking for Pi.**

_Track client work across projects, keep records local, and review your hours._

<p>
  <img src="assets/cover.png" alt="Blue clock and pi-time-tracker wordmark"
       width="960">
</p>

[![checks][checks-badge]][checks]
[![npm version][npm-badge]][npm]
[![Pi extension][pi-badge]](index.ts)
[![License: MIT][license-badge]](LICENSE)

</div>

## Run

After [installing](#install), tracking starts automatically. In Pi:

```text
/project report
```

Workspace reports go to `exports/work-report.md`. Keep `exports/` out of Git.
Hours are inferred from Pi activity, not confirmed billable time; review them
before using them in a timesheet or invoice.

## Why pi-time-tracker?

| | Capability | What it unlocks |
| :-: | --- | --- |
| ⏱️ | **Automatic tracking** | Infer work windows without managing a timer. |
| 🔀 | **No double-counting** | Count overlapping sessions once; long idle gaps stay Unknown. |
| 🔒 | **Local records** | Built-in SQLite; no external sync or automatic prompt/transcript capture. |
| 📝 | **Reviewable reports** | Markdown drafts, optional outcome notes and a separate manual clock. |

## How it fits

Pi activity → local SQLite and receipts → Markdown reports.
See the [architecture and development guide][development] for details.

## Install

Requires Node.js >=22.19.0 and a Pi 0.87.1-compatible host.

```sh
pi install npm:pi-time-tracker
```

Use `--local` to install for just the current project. Approve project trust when
prompted, then use `/reload` in Pi. If switching from Git or a local checkout,
remove the previous install first rather than loading both.

## Usage

Optional labels and reports across projects:

```text
/project set Coral   # optional client name; defaults to the folder name
/project task docs   # optional task for this session
/project report all  # report across tracked workspaces
```

## Documentation

- [Commands, configuration and privacy][usage]
- [Development, architecture and releases][development]
- [Report a bug][issues] · [Security](SECURITY.md)

## License

[MIT](LICENSE). Copyright © 2026 Ryan Brosas.

---

Powered by [Coral Bricks](https://coralbricks.ai).

[checks-badge]: https://img.shields.io/github/actions/workflow/status/ryan-brosas/pi-time-tracker/ci.yml?branch=main&style=for-the-badge&label=checks
[checks]: https://github.com/ryan-brosas/pi-time-tracker/actions/workflows/ci.yml
[npm-badge]: https://img.shields.io/npm/v/pi-time-tracker?style=for-the-badge&logo=npm
[npm]: https://www.npmjs.com/package/pi-time-tracker
[pi-badge]: https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge
[license-badge]: https://img.shields.io/badge/license-MIT-2ea44f?style=for-the-badge
[usage]: https://github.com/ryan-brosas/pi-time-tracker/blob/main/docs/usage.md
[development]: https://github.com/ryan-brosas/pi-time-tracker/blob/main/docs/development.md
[issues]: https://github.com/ryan-brosas/pi-time-tracker/issues
