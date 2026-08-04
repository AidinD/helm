# Helm

A personal Electron app for running and overseeing Claude Code sessions.
It wraps the real `claude` CLI rather than reimplementing any part of it: every session Helm starts is a headless `claude -p` process, so nothing about Claude's own behaviour is stripped, faked, or frozen at the version this app was written against.

Private project, personal use, one user.
There is no multi-user story, no hosted component, and no intention to add either.

## What it is for

Plain Claude Code is a conversation you drive turn by turn.
Helm is a workspace you oversee: you spin up focused sessions or autonomous runs, step away, and come back when something needs a decision.
The front door is a dashboard of live state and "what needs you now", not a prompt box.

That only works because the durable knowledge lives in files rather than in a long-lived conversation: rules in `CLAUDE.md`, reasoning in `DECISIONS.md`, work in the Jot board Helm reads.
A session can therefore be thrown away without losing anything, which is what makes the whole loop safe.

`docs/USING-HELM.md` is the day-to-day guide: the daily loop, which surface to reach for, and the keyboard layer.
Read that to *use* Helm; read on here to *work on* it.

## The tier model

Work is organised into four tiers, and most of the app's design follows from them:

- **Captain** - you. The only tier that decides.
- **First mate** - rooted in the meta-home above all projects, holds cross-project priority. It coordinates and dispatches; it is denied the tools of doing hands-on work, so it structurally cannot drift into writing code in its own seat.
- **Second mate** - rooted in one project's repo, holds that project's deep state, validates what crew produces, and can consult read-only advisory seats (the personas) for a second opinion.
- **Crew** - an autonomous run in an isolated git worktree, scoped to one task, ephemeral.

`docs/orchestration-model.md` is the conceptual model in full, including why each tier is ephemeral and where the capability gaps are.
Read it before touching anything about dispatch.

## Running it

```bash
npm install
npm start
```

Restarting during development goes through the script, not through killing Electron by name:

```bash
bash scripts/restart-dev.sh
```

`taskkill /IM electron.exe` matches by image name machine-wide and has silently killed unrelated Electron apps running at the same time.
The script only kills processes whose command line actually points at this repo, then confirms a real live process came back rather than grepping a log for the word "error".

## Tests

```bash
npm run test:fast   # everything that does not launch the app (seconds)
npm test            # the full sweep, one Electron launch per app test
node scripts/run-tests.mjs docs jot   # only files whose name matches a term
```

Tests are discovered from `scripts/e2e/test-*.mjs`; a test that imports the CDP harness is treated as an app test and runs one at a time, because several pin a fixed debug port.

Two conventions worth knowing:

- **A test may decline to run itself.** One check spawns the real `claude` CLI and spends tokens, so it is opt-in behind `HELM_LIVE_CLI_TESTS=1`. The runner reports such a test as `skip` and names it at the end rather than counting an un-run check as a pass.
- **The summary counts what ran**, not what exists. `--fast` never starts the app tests and says so, because reporting them as passed would be the kind of green that means nothing.

## Building and releasing

```bash
npm run dist      # package locally into dist/
npm run release   # package and publish a GitHub release
```

The version is derived, not hand-written: `major.minor` comes from `package.json` (bumped by hand) and the third number is the count of commits since whichever commit last changed that `major.minor`, so it resets to 0 on each bump instead of accumulating forever.
A dev checkout computes it from git at startup; a packaged build reads the version stamped in at package time.

Two things that have gone wrong here before, both worth doing every time:

- **Kill any packaged Helm launched by an end-to-end test before building.** It holds `dist/` open and the build fails on a locked file.
- **Delete stale installers when building new ones.** An old setup file left next to a new one has been reinstalled by mistake.

## Layout

```
src/main.js            Electron main process: IPC, session launching, dispatch authority
src/preload.cjs        the renderer's only bridge to main
src/renderer/          the whole UI (renderer.js, style.css, index.html)
src/lib/               56 focused modules: sessions, mates, personas, review records,
                       the goal orchestrator, worktrees, Jot, usage, transcripts.
                       Also the operating manuals each tier is launched with
                       (first-mate-instructions.md, second-mate-instructions.md)
src/mcp/               the stdio MCP server that gives a mate its dispatch tools
scripts/               build, test runner, dev restart, and the e2e suite
docs/                  design docs and the usage guide
```

The app is the single dispatch authority: a mate's dispatch tools do not open a socket back into Electron, they write to an on-disk request queue that the main process watches.
There is no port to babysit.

## State on disk

The JSON and JSONL files at the repo root (`config.json`, `mates.json`, `second-mates.json`, `goal-run-history.json`, `usage-log.jsonl`, and the rest) are live state, not fixtures.
They are gitignored, they differ per machine, and deleting one loses real history.
Helm keeps its own session index in `config.json` rather than writing into Anthropic's private session directory, deliberately: that directory is undocumented and shared with the daily-driver Desktop app.

## Before changing things

`CLAUDE.md` holds the project rules and the hard-won traps a fresh session would otherwise rediscover the expensive way, including two about verifying changes on this machine that have cost real time.
`PLAN.md` is the current build plan and active phase.
`DECISIONS.md` is every decision worth remembering and why, including the alternatives that were rejected.
`docs/review-pipe-status.md` says where the review pipe currently stands, which is the one thing the chronological decision log cannot tell you.

The standing principle for this repo is proper fixes over patches on patches.
When a fix would be the second or third thing mutating the same piece of state, that is the signal to stop and name the root-cause fix instead of layering another override on a model that is already wrong.
