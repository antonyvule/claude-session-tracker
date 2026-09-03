# 🗂️ Claude Session Tracker

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6.svg)
![No framework](https://img.shields.io/badge/frontend-no%20framework-informational.svg)

A local dashboard for tracking Claude Code CLI sessions across every project on this
machine — status, notes, tags, priority, and a "needs you" flag that Claude Code's own
session list doesn't provide. Layout: a filterable, colour-coded session list on the
left (grouped by project, priority-ordered); the selected session's full transcript,
cost estimate, status control, and actions on the right.

It's a plain Node/Express server + a no-framework browser UI, not a desktop app. The
server is the only thing resident all the time (tens of MB RAM, near-zero idle CPU);
the browser tab costs nothing extra since a browser is already running anyway.

## 📚 Table of contents

- [✨ Features](#-features)
- [🧩 Requirements](#-requirements)
- [⚙️ Installation](#️-installation)
- [🔧 Configuration](#-configuration)
- [🔁 Running continuously](#-running-continuously)
- [🏗️ Architecture](#️-architecture)
- [📁 Project structure](#-project-structure)
- [🔌 API reference](#-api-reference)
- [📡 Data sources](#-data-sources)
- [🗄️ Data model](#️-data-model)
- [⚠️ Known limitations](#️-known-limitations)
- [🛠️ Troubleshooting](#️-troubleshooting)
- [🚫 Non-goals](#-non-goals)
- [📄 License](#-license)

## ✨ Features

**Session list (left pane)**
- Grouped by project, each group showing a display name, an optional linked ADO
  ticket link, and ↑/↓ buttons to manually reorder projects relative to each other.
- Filter chips at the top: **All** (To Do / In Progress / Blocked — Done and Archived
  are deliberately excluded from "All"), plus one chip per status.
- Each card shows: a colour-coded status pill (📝 To Do, 🔄 In Progress, 🚫 Blocked,
  ✅ Done, 🗄️ Archived), git branch, relative last-active time (absolute on hover), a
  live dot when running, and badges for **Needs You**, **Stale**, and **Pinned**.
  Status is only ever auto-set for "running → In Progress"; Done and Archived are
  explicit-only and never auto-suggested. An In Progress session that goes idle past
  the stale threshold gets a **Stale** badge without its status changing — an
  untouched To Do/Blocked is simply left as-is.
- Drag a card onto another card in the same project to set a manual order — it's a
  tiebreaker only; Needs You/Stale/Pinned still always float to the top regardless.
- Hover any button, badge, or chip for a tooltip explaining it; the **?** button in
  the header opens a full glossary panel.

**Detail pane (right)** — opens when you select a session:
- Fixed header (title, status control, folder, action buttons, rough cost estimate)
  and a fixed footer (rename, notes, tags, pin), with only the transcript itself
  scrolling in between. Opens already scrolled to the latest messages.
- The transcript renders basic markdown (bold/italic, inline and fenced code,
  headers, lists, links) instead of dumping raw text, and visually distinguishes
  your messages (🧑 You) from Claude's (🤖 Claude).
- **Status** dropdown — picking one here marks the session "manually set" so the
  tracker stops auto-managing its status.
- **▶️ Resume** — reopen this exact session (disabled, shows "Already open (pid N)",
  if it's already running elsewhere).
- **🍴 Fork** — start a brand-new session from this one's history, leaving this
  session untouched.
- **⏭️ Continue latest in project** — not tied to the session you're viewing; runs
  Claude Code's own "continue most recent" for that project folder, so it can land on
  a different, newer session. If a session in that project is already running, this
  skips launching anything and tries to bring its window to the foreground instead
  (falls back to just selecting it here if the OS blocks the focus switch).
- **📋 Copy command** — puts the equivalent CLI command on the clipboard as a
  fallback.
- Every launch action opens as a new tab in your existing terminal window rather than
  a separate window, where possible (falls back to a new window if Windows Terminal
  isn't installed).

**➕ New Session** — pick a known project or browse to a folder (scoped to configured
allowed roots + your home folder), optional name/model/effort override, then launches
a fresh `claude` there. It won't appear in the list until you send it a first message
— see [⚠️ Known limitations](#️-known-limitations).

**🔎 Search** — ripgrep-backed full-text search across all transcripts (`/` to focus
it), shown in a dropdown under the search box rather than a panel that covers the
page. Results are one per session (not one per matching line — clicking any result
opens the same transcript regardless), each tagged with that session's status pill,
sorted active-first (In Progress → Blocked → To Do → Done → Archived, then recency).
Selecting a result also switches the list's filter chip and scrolls to the matching
card if needed, the same as selecting it manually.

**🎨 Theme** — dark blue by default (drawn from a shared design reference), with a
lighter variant for anyone whose OS prefers light mode.

**⌨️ Keyboard shortcuts** — `/` focuses search; `Esc` closes whichever overlay
(search results, New Session, Help) is open.

## 🧩 Requirements

- **Windows** — the terminal-spawning and window-focus mechanisms are all
  PowerShell/Win32-specific; this has not been adapted for macOS/Linux.
- **Node.js** — tested on Node 24. No hard minimum is enforced; `better-sqlite3`
  needs either a prebuilt binary for your Node version or a C++ toolchain to build
  from source (see [🛠️ Troubleshooting](#️-troubleshooting)).
- **Claude Code CLI** (`claude`) on PATH — this tool is a dashboard on top of it, not
  a replacement.
- **Git** on PATH — used for the per-card branch display (`git branch
  --show-current`); a project without git simply shows no branch.
- **Windows Terminal** (`wt.exe`) — optional but recommended. Every launch action
  (Resume/Fork/Continue/New Session) opens as a new tab in your existing terminal
  window when it's available, falling back to a plain new PowerShell window if not.
- **ripgrep** (`rg`) on PATH — optional; only the Search feature needs it. Without
  it, search reports itself unavailable rather than failing the whole app.

## ⚙️ Installation

```bash
cd C:\GitHub\claude-session-tracker
npm install
node server.js
```

Open http://127.0.0.1:4756 (port is configurable — see [🔧 Configuration](#-configuration)).

`better-sqlite3` ships a prebuilt binary for most Node versions. If `npm install`
reports a missing binding at startup, run `npm rebuild better-sqlite3` — this requires
a C++ toolchain (Visual Studio Build Tools) if no prebuild matches your Node version.

## 🔧 Configuration

Edited by hand in `config/settings.json` (no UI for this yet — restart the server
after changing it):

| Field | Default | Purpose |
|---|---|---|
| `port` | `4756` | Port the server listens on (bound to `127.0.0.1` only). |
| `pollIntervalMs` | `4000` | How often `claude agents --json --all` is polled for live session status. |
| `staleThresholdHours` | `24` | How long a session can go untouched before it's eligible for the Stale badge (In Progress) or simply left alone (To Do/Blocked) — see [✨ Features](#-features). |
| `allowedBrowseRoots` | `["C:\\GitHub"]` | Folders the New Session directory browser is allowed to look inside, in addition to your home folder. |
| `ado.org`, `ado.project` | `""`, `""` | Azure DevOps org/project used to build the `#<ticket>` link on a project header. Link-out only — nothing is fetched from ADO. |
| `ignoredProjects` | `[]` | Present in the default file but **not currently wired up anywhere in the code — has no effect.** To actually ignore a project, use its `ignored` flag directly via `PATCH /api/projects/:projectKey` (no UI control for this yet either). |

## 🔁 Running continuously

Pick one:

### Option A — Windows Task Scheduler
1. Task Scheduler → Create Task…
2. Trigger: **At log on**
3. Action: **Start a program**
   - Program: `node.exe` (full path, e.g. `C:\Program Files\nodejs\node.exe`)
   - Arguments: `server.js`
   - Start in: `C:\GitHub\claude-session-tracker`
4. Under Settings, consider "Restart task if it fails" for resilience.

### Option B — NSSM (runs as a real background service, survives without a logged-in session)
```powershell
nssm install ClaudeSessionTracker "C:\Program Files\nodejs\node.exe" "server.js"
nssm set ClaudeSessionTracker AppDirectory "C:\GitHub\claude-session-tracker"
nssm start ClaudeSessionTracker
```

Either way, check `GET /api/health` to confirm it's up.

## 🏗️ Architecture

- **Backend**: Node.js + Express, single process, no build step. `better-sqlite3` for
  the status/notes/tags/priority database; `chokidar` for live transcript-file
  detection (native event mode, with a periodic full re-scan as a safety net — see
  [📡 Data sources](#-data-sources)); Server-Sent Events (`/events`) push updates to
  the browser, so the client never polls.
- **Frontend**: plain HTML/CSS/JS in `public/` — no framework, no bundler, no build
  step. A small hand-written markdown renderer handles transcript formatting (not a
  library — kept dependency-free and fully offline).
- **External processes shelled out to**: `claude` (the CLI itself), `git` (branch
  lookup), `wt.exe`/`powershell.exe` (spawning sessions), `rg` (search).
- **Dependencies**: `express`, `better-sqlite3`, `chokidar` — nothing else. The
  transitive `qs` (pulled in by Express) is pinned via an `overrides` entry in
  `package.json` to a patched version; see the commit history for why.

## 📁 Project structure

```
claude-session-tracker/
├── server.js                  # Express app, routes, SSE broadcast, poll loop wiring
├── config/
│   └── settings.json           # user-editable runtime settings (see Configuration)
├── data/
│   └── tracker.db               # SQLite database (gitignored, created on first run)
├── src/
│   ├── db.js                    # schema + migrations + prepared statements
│   ├── agentsPoller.js          # polls `claude agents --json --all`, diffs results
│   ├── historyScanner.js        # transcript file discovery, parsing, cost/needs-you detection
│   ├── statusEngine.js          # merges live + historical + DB data into board cards
│   ├── projects.js              # project-key canonicalisation helpers
│   ├── gitBranch.js             # cached git branch lookups
│   ├── actions.js               # spawns Resume/Fork/Continue/New Session/focus-window
│   ├── browse.js                # scoped directory browser for New Session
│   ├── search.js                # ripgrep-backed transcript search
│   ├── sse.js                   # Server-Sent Events client registry + broadcast
│   ├── health.js                # /api/health state
│   ├── pricing.js                # per-model token pricing table for cost estimates
│   └── ps/
│       └── focus-window.ps1      # Win32 window-focus script (see Known limitations)
└── public/
    ├── index.html                # single page: board, detail pane, modals, help panel
    ├── app.js                    # all client-side logic (SSE handling, rendering, actions)
    └── styles.css                 # theme + layout
```

## 🔌 API reference

All routes are unauthenticated and bound to `127.0.0.1` only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/events` | Server-Sent Events stream — a full snapshot on connect, then deltas. |
| GET | `/api/health` | Liveness + last-poll status. |
| GET | `/api/config` | Read-only client config (stale threshold, ADO org/project). |
| GET | `/api/browse?path=` | Scoped directory listing for the New Session folder picker. |
| GET | `/api/projects/roots` | Known project folders, for the New Session quick-pick list. |
| GET | `/api/search?q=` | ripgrep-backed full-text search across transcripts. |
| GET | `/api/sessions/:sessionId/detail` | Full parsed transcript + rough cost estimate for one session. |
| PATCH | `/api/sessions/:sessionId` | Update status/notes/tags/pinned/title/ignored/order. |
| PATCH | `/api/projects/:projectKey` | Update a project's display name/ADO ticket/priority/ignored. |
| POST | `/api/projects/reorder` | Set manual priority order across projects. |
| POST | `/api/sessions/reorder` | Set manual order for sessions within one project. |
| POST | `/api/actions/resume` | Spawn `claude --resume <sessionId>`. |
| POST | `/api/actions/fork` | Spawn `claude --resume <sessionId> --fork-session`. |
| POST | `/api/actions/continue` | Spawn `claude -c` in a project folder. |
| POST | `/api/actions/focus` | Best-effort: bring a running session's window to the foreground. |
| POST | `/api/actions/new` | Spawn a fresh `claude` session in a chosen folder. |
| GET | `/api/actions/command` | Return the plain-text CLI command for the "copy command" fallback. |

## 📡 Data sources

- **Live sessions** — `claude agents --json --all`, polled every `pollIntervalMs`
  (default 4s) and diffed before anything is pushed to the browser. This is the source
  of truth for "is this session currently running."
- **Historical sessions** — `~/.claude/projects/<slug>/*.jsonl`. Only `stat()`'d for
  the session list (mtime = last-activity); a session's `.jsonl` is only fully parsed
  when its detail pane is opened (transcript, cost estimate). The "Needs You"
  badge is an exception — it reads only the last ~8KB of the file (not a full parse) so
  every card can show it without the cost of a full parse on every poll tick.
  New session files are picked up live via a chokidar file watcher, backed by a
  full re-scan safety net every 60s. The safety net is load-bearing, not
  theoretical: on a 76+ hour uptime instance, the live watcher was observed to
  silently stop delivering events for a project directory — three real, on-disk
  session files went completely undetected (showed live in the list via `claude
  agents`, but their detail pane said "No transcript on disk yet") with no error
  ever surfaced. If you ever see that message for a session that's clearly been
  used, it should self-heal within a minute; if it doesn't, restart the server.
- **Git branch** — `git -C <cwd> branch --show-current`, cached in memory per folder
  and only re-checked when that folder's session activity changes.
- **Project real paths** — never reverse-engineered from the `<slug>` directory name
  (folder names can contain literal dashes, which makes slug→path ambiguous). The real
  `cwd` is always read from the transcript content itself.
- **Subagent (Task-tool) runs are excluded on purpose** from both the board and
  search. These get their own transcript nested under the parent session
  (`<slug>/<parentSessionId>/subagents/agent-<id>.jsonl`, confirmed by direct
  inspection). They're filtered out of the file scanner, the chokidar watcher, and
  the ripgrep search glob — without that, a recursive scan/watch would otherwise
  surface a subagent run as if it were its own top-level session, one you never
  interact with directly and can't act on.

## 🗄️ Data model

SQLite (`data/tracker.db`, gitignored) holds two tables:
- `sessions` — status, notes, tags, pin, manual-order index (drag-to-reorder within a
  project), manual-override flag, ignore flag — keyed by Claude Code's own `sessionId`.
- `projects` — display name, linked ADO ticket id (link-out only, no auto-fetch),
  manual priority order, ignore flag — keyed by a normalized project folder path.

Archiving only ever changes the `status` column. Nothing under `~/.claude/projects/`
or `~/.claude/sessions/` is ever modified, moved, or deleted. The schema is migrated
additively via `PRAGMA user_version` — upgrading never touches existing rows.

**Note on launched sessions**: every action that spawns `claude` sets
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` on the child process. This matters if the
tracker server itself is ever run as a descendant of another Claude Code session (e.g.
during development) — without it, a launched session silently disables its own
transcript saving (`CLAUDE_CODE_CHILD_SESSION` inherited from the parent), so it would
run fine but never show up here. Verified directly against the actual CLI warning.

## ⚠️ Known limitations

- **A freshly-launched "New Session" doesn't appear until you send it a first
  message.** Verified directly: a bare, still-blank `claude` prompt creates no
  transcript file and no `claude agents` entry at all — Claude Code only creates
  a session's record once a real turn happens (confirmed by comparing a blank
  interactive launch against a one-shot `claude -p` prompt, which did create one
  immediately). There's nothing for the poller or the transcript scanner to find
  before that point; this isn't fixable from the tracker's side.
- **"Needs you" detection** covers the reliable case: a pending tool/permission
  approval (the last transcript entry is an assistant turn with `stop_reason ===
  "tool_use"` and nothing after it). It does **not** attempt to detect a free-form
  question in the assistant's text — that would need semantic understanding of the
  reply, which isn't implemented.
- **List-view titles** show the manually-set title or the CLI-assigned session `name`
  only — the fully-derived title (from the session's first real message) is computed
  in the detail pane, not the list, to avoid a full parse of every session's
  transcript on every poll tick. Opening a session shows its full transcript (every
  turn with text), not a windowed preview.
- **Cost estimates are rough.** Token counts come straight from each turn's `usage`
  block; cache write/read multipliers are approximated (1.25x / 0.1x of base input
  price) rather than read from a live pricing API. The price table in `src/pricing.js`
  will go stale as Anthropic pricing changes — update it there.
- **ADO ticket linking is link-out only.** No REST/PAT integration to fetch live ticket
  title or status in this version.
- **Ignore is API-only.** `ignored` exists on both sessions and projects and is fully
  respected by the board-building logic, but there's no button/checkbox in the UI to
  set it yet — only via `PATCH` directly.
- **Settings** (`config/settings.json`) are edited by hand, not through the UI, in this
  version.
- **"Focus its window" (Continue latest in project, when already running) is best-effort.**
  Windows deliberately blocks background processes from stealing focus; the tracker
  works around this with the standard simulated-keypress trick and verifies the
  switch actually happened rather than trusting the API's return value, but it can
  still be silently blocked depending on OS state. Separately, if your machine hosts
  new console windows as tabs inside one shared Windows Terminal window (common on
  Windows 11 — verified true on the dev machine), there's no way to target the exact
  tab from outside (Windows Terminal exposes no public API for it), so it falls back
  to focusing the shared window itself — you may need to switch tabs manually from
  there. Either way, the session is also selected in the tracker itself as a reliable
  fallback.

## 🛠️ Troubleshooting

- **`npm install` / startup fails with a missing `better-sqlite3` binding** — run
  `npm rebuild better-sqlite3`. If that fails too, install the Visual Studio Build
  Tools (C++ workload) so it can compile from source.
- **Port already in use** — find and stop whatever's holding it:
  ```powershell
  netstat -ano | findstr ":4756" | findstr LISTENING
  Stop-Process -Id <pid> -Force
  ```
  Or change `port` in `config/settings.json` and restart.
- **Search says it's unavailable** — install ripgrep (`winget install
  BurntSushi.ripgrep.MSVC` or `choco install ripgrep`) and make sure `rg` is on PATH.
  Everything else in the app works without it.
- **A session's detail pane says "No transcript on disk yet" for a session you've
  clearly used** — see the [📡 Data sources](#-data-sources) note on the chokidar
  watcher; it should self-heal within about a minute via the periodic re-scan. If it
  doesn't, restart the server.
- **A Resume/Fork/New Session window opens and then vanishes within seconds** — this
  was observed specifically when the tracker server itself was launched as a
  descendant of another Claude Code session (e.g. during development inside an
  agent's sandboxed shell), which enforces its own process-tree cleanup. Running the
  server normally (your own terminal, Task Scheduler, or NSSM) does not have this
  problem.
- **New Session / Resume launches but doesn't show up, and you never see a "Transcript
  saving is off" warning** — check that `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is
  actually reaching the child process; see the note under [🗄️ Data model](#️-data-model).

## 🚫 Non-goals

- No Electron/Tauri or any bundled-browser desktop shell.
- No talking to `~/.claude/daemon/` internals — `claude agents --json` is the supported
  equivalent.
- Never modifies/deletes/moves files under `~/.claude/projects/` or `~/.claude/sessions/`.
- No cloud sync, no auth — single-user localhost tool, bound to `127.0.0.1` only.
- No OS-level tray notification without a browser tab open.
- No auto-fetch of ADO ticket data, no export/reporting, no command palette.

## 📄 License

[MIT](./LICENSE) — free to use, modify, and distribute, including commercially, as
long as the copyright notice is kept. See the [`LICENSE`](./LICENSE) file for the
full text.
