# troupe user guide

[← Back to the overview](../README.md) · [简体中文](guide.zh-CN.md)

[Plans](#the-plan) · [Workflows & duties](#workflows-and-duty-roles) · [Commands](#commands) · [Panel](#the-panel) · [Agents](#agents) · [Known limits](#known-limits)

## The plan

Markdown around one fenced yaml block; each task role's assignment is a
`## Role: <name>` section in the Markdown. The default template is
[`templates/plan.md`](../templates/plan.md).

```yaml
troupe: 2
goal: "Refresh tokens rotate on every use, and a reused one is refused"
why: "Stolen refresh tokens stay valid for 30 days today (issue #212)"
workflow: delivery
base: mission/auth-refresh
profiles:
  claude-build:
    duty: builder
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
roles:                                # one task role = one window, worktree and branch
  api:
    duty: builder
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    goal: "Rotate the token on refresh; refuse a reused one"
    touches: [src/api/refresh.ts, src/api/errors.ts]
  web:
    use: claude-build
    model: sonnet
    goal: "Sign the user out when a refresh is refused"
    touches: [web/src/session/]
    depends_on: [api]                 # opens once api's result says done
  review:
    use: claude-build
    duty: reviewer
    goal: "Review each branch as it lands"
    touches: []                       # changes no files
    reviews: [api, web]
```

`troupe check` refuses: an unknown `workflow` or `duty`; missing task roles
for a workflow stage marked `required`; a `duty` not permitted in the role's
`stage` (inferred when unambiguous, required when a duty appears in multiple
stages); violations of a duty's `touches` (`required | optional | none`) or
`reviews` (`required | optional | forbidden`) contract; cross-stage
`depends_on` pointing forward in the workflow; an unknown agent; `flags` that
do not pin the agent's permission (Claude Code: `--permission-mode`; Codex:
`-a` and `-s`); a role with no `## Role: <name>` text; an unknown
`depends_on`, `reviews`, `text` path or profile (plan-local or shared); a dependency cycle; or two
roles whose `touches` overlap without a `depends_on` between them. `model` and
`effort` are passed as written.

## Workflows and duty roles

One workflow-agnostic orchestrator skill (`skills/troupe-mission/SKILL.md`)
drives any workflow by reference (`workflow: <name>` in `plan.md`, or
`-w, --workflow <name>` on `mission new` / `up`).

- **Built-in workflows** ([`workflows/`](../workflows/)):
  - `delivery` (default): `plan -> [plan] -> spec(architect,researcher) -> [spec-ok?] -> build(builder,tester) -> review(reviewer) -> [mr-ok] -> mr -> [merged] -> teardown`
  - `design-first`: `plan -> [plan] -> design(architect,researcher) -> [design-ok] -> build(builder,tester) -> review(reviewer) -> [mr-ok] -> mr -> [merged] -> teardown`
  - `investigation`: `plan -> [plan] -> explore(researcher,architect) -> synthesize(reviewer) -> [report-ok] -> teardown` (read-only; teardown requires neither merge nor push)
  - `direct`: `plan -> [plan] -> spec(architect,researcher) -> [spec-ok?] -> build(builder) -> verify(tester,reviewer) -> integrate -> [accept-ok] -> teardown` (local branch integration without remote push/MR)

  `spec` is optional in `delivery` and `direct`: schedule `architect` or
  `researcher` roles there to settle requirements, an implementation plan, or
  the architecture before building. `[spec-ok?]` declares
  `skip_if_empty: spec`, so the gate is skipped when the plan has no `spec`
  roles. Any workflow can put `skip_if_empty: <stage>` on a non-plan gate that
  follows an optional execution stage.
- **Built-in duty roles** ([`roles/`](../roles/)): `builder`, `reviewer`,
  `architect`, `researcher`, and `tester`. Each defines YAML front matter
  (`name`, `summary`, `touches`, `startup`, `reviews`) and Markdown rules
  injected into every assigned task role's launch brief.
- **Profiles** (`profiles/<name>.md`): reusable task-role personas under
  `~/.config/troupe/profiles/` or `<repo>/.troupe/profiles/` (`repo > user`).
  Front matter presets `summary` (required), `duty`, `agent`, `model`,
  `effort`, `flags`, and `skills`; mission-specific fields (`touches`, `goal`,
  `reviews`, `depends_on`, `stage`, `text`) are refused. The Markdown body is
  injected into the brief as `## Profile: <name>`. A role picks one with
  `use: <name>`; a plan-local `profiles:` entry of the same name wins, and the
  role's own fields override the preset.

  ```markdown
  ---
  summary: UI designer who ships screens with visual sign-off
  duty: builder
  agent: claude
  flags: [--permission-mode, acceptEdits]
  skills: [fbw-frontend-product-design, fbw-frontend-engineering]
  ---
  Start from the states each screen must show; attach screenshots to your result.
  ```
- **Skills**: a workflow stage may declare `skills: [...]` (execution stages
  only). A role's brief lists the union of its stage's, its profile's, and its
  own `skills`, in that order, and tells the agent to continue without (and
  report) any skill it does not have installed.
- **3-tier customization**: add or override workflows under
  `<repo>/.troupe/workflows/<name>.md` or `~/.config/troupe/workflows/<name>.md`,
  and duty roles under `<repo>/.troupe/roles/<duty>.md` or
  `~/.config/troupe/roles/<duty>.md` (`repo > user > built-in`). Edits to the
  active workflow, referenced duty files, or used shared profiles change the plan hash and require
  re-approval before further dispatches.

## Commands

All take `-m, --mission <name>`. Without it, a command acts on the mission
bound to the pane it runs in (a panel follows its orchestrator's), else on
the `mission/<name>` branch checked out where it runs; otherwise it refuses
and lists the open missions with their worktrees. `-m` reads the plan from
the mission's worktree from anywhere, but refuses to name another mission
than the pane's own. Exit 0 on success, 1 when refused (with the reasons), 2
on usage errors.

| Command | What it does |
|---|---|
| `setup [--remove]` | install the orchestrator skill for each harness found |
| `workflow [list \| show <name>] [--json]` | list available workflows (`repo > user > built-in`) or inspect one workflow's stages, gates, teardown policy and playbook |
| `role [list \| show <duty>] [--json]` | list available duty roles (`repo > user > built-in`) or inspect one duty role's contract and rules |
| `profile [list \| show <name>] [--json]` | list shared task-role profiles (`repo > user`) or inspect one profile's presets and persona |
| `mission new <name> [-w <workflow>] [--base <ref>]` | create the mission's worktree on `mission/<name>` with a starter `plan.md` for `<workflow>`, bind this pane to it and open its panel |
| `open [--planning]` | show this pane's mission's panel beside it (one per mission); without a mission it refuses and lists the open ones, except with `--planning`, which shows a panel waiting for `mission new`; `open -m <name>` from an unbound pane makes it that mission's orchestrator, only once the previous orchestrator pane is gone or dead |
| `up -m <name> [-w <workflow>] [--orch claude\|codex\|copilot\|jishubuddy]` | `mission new`, then open the orchestrator in the mission worktree and the panel |
| `panel` | the live panel (`up` runs it; `--once --plain` prints one frame) |
| `check` | check `plan.md`, workflow/duty contracts, and adapters |
| `approve` | approve the plan, from a terminal only |
| `gate <id> ["question"] [--no-wait]` | ask the person in the panel; prints `approve` or `change: <text>` |
| `stage <id>` | move the panel's stage strip (ids from the mission's workflow; refuses if any preceding workflow gate is unapproved) |
| `dispatch <role>` | open a task role in the active workflow stage: worktree, branch, brief, pane |
| `status [--json] [--watch]` | each role's state, commits, changes outside `touches`, result; with no mission resolved, the open missions with their worktree, orchestrator pane and panel pane |
| `send <role> <text…>` | type into a role's window, only when it is ready |
| `wait --role <r> [--ready] \| --gate <id> [--timeout s]` | wait for a result, readiness or an answer |
| `close <role> \| --all` | close troupe's panes; worktrees and branches stay |
| `teardown [--force]` | close role panes and the mission's panel, remove role worktrees, role branches, the mission worktree and temporary mission briefs/results; preserve the mission branch and log |

An open mission has a worktree on its `mission/<name>` branch or a log, and
no teardown event. Explicit `-m` opens any mission, including a finished
one. Until its orchestrator is bound, the panel waits for one.

Once all gates declared by the mission's workflow are approved, run `troupe
teardown -m <mission>`. It closes role panes and the mission's panel, and
unbinds the orchestrator's pane, which stays open. It refuses while any gate
the workflow declares is not approved, and refuses dirty or untracked work,
plus unmerged role commits (`teardown.require_merge`, default `true`) and an
unpushed mission branch (`teardown.require_push`, default `true`) when enabled
by the workflow, unless `--force`. Panes with a different owner marker are skipped. Repeating it
with explicit `-m` reports nothing left. The mission branch and log stay available.

Use `troupe wait --role <r> --ready --timeout 60` after dispatch or before
sending new work. It succeeds on ready, stops with the dialog on waits, and
fails if the pane is gone or the timeout expires.

A role finishes by writing `.troupe/result.md` in its worktree, with front
matter `status: done | blocked | failed` and `summary: "<one line>"`.

## The panel

Title bar, tabs (`1 MISSION`, `2 ROLES`, `3 PLAN`, `4 LOG`, `5 DIFF`), the
needs-you strip (an open gate, each role waiting on you), then roles, stages
and activity on the left and the flow plus the selected role's detail with
its window live on the right. ↑↓ or j/k select a role, `o` opens its pane,
`s` sends it a message (a dead key while it waits on you), `d` diff, `v`
plan, `a` / `c` answer a gate, `?` help, `q` quits. Clicks work where tmux
passes the mouse (`set -g mouse on`).

`中/EN` at the right of the title bar, or `L`, switches the panel between
English and Chinese. The choice is saved in `~/.config/troupe/settings.json`;
until you make one, a `zh` locale starts the panel in Chinese. It also sets
the language the agents write in for you: the plan, gate questions and
results. Roles dispatched later get it in their brief, and the orchestrator
is told when you switch mid-mission. What is already written stays as it is,
and what troupe reads (headings, YAML, `status:`, CLI output) stays English.

## Agents

Built in: `claude`, `codex`, `copilot` and `jishubuddy`. An adapter says how to start the agent with
a first prompt, how to pass model and effort, which flags pin its
permission, and which screen patterns mean waits on you, working and ready.
Add one as `~/.config/troupe/agents/<name>.yaml` or
`<repo>/.troupe/agents/<name>.yaml` (the repository's wins); `src/agents.ts`
holds the built-ins in the same shape.

Adapters may set `promptArgs: [-i]` to place a prompt flag immediately
before the final prompt argument, as Copilot requires. Omitting it preserves
the positional-prompt behavior. `usage` selects the built-in lifecycle
integration; it is not an arbitrary transcript format.

A built-in role's turn comes from its agent, not its screen. Claude roles
start with lifecycle hooks in `--settings` (`UserPromptSubmit`,
`PermissionRequest`, `PostToolBatch`, `Stop`, and the idle notice after an
interrupt) that write `.troupe/activity.json`; Codex roles are read from
their own session log (`task_started`, `task_complete`, `turn_aborted`).
Only that report makes a role ready for `send`. A Claude role's hooks also
report when it waits on you: `PermissionRequest` opens the wait (an approval
or a question), the next tool batch ends it as answered, and a deny or Esc,
which runs no hook, ends it with the interrupt row in the role's transcript.
Each wait's end is kept in the record (the last 50).
Otherwise, while a turn runs, the screen patterns tell waiting on an
approval from working; before the first report they stand in, but never as
ready. An adapter with `usage` unset is read from its screen alone.

The orchestrator is told, not polled. Every troupe command it runs records
its agent session in the run log: Claude Code's `CLAUDE_CODE_SESSION_ID` or
Codex's `CODEX_THREAD_ID`, accepted only when that agent is an ancestor of
the command, and the pane to type to (tmux, or herdr's `HERDR_PANE_ID`).
When a role's agent reports its turn over with a result written, the
person answers a gate in the panel, or the person answers a Claude role's
wait in its window (`Role review was answered in its window and went on
working.`, or `… was stopped in its window …` after a deny or Esc), the
panel types one line into the orchestrator after the orchestrator's own
turn has ended, read from its transcript (Claude's `turn_duration` or
interrupt row) or session log (Codex). Every answered wait is told once,
oldest first, unless the role's finish was told, work was sent to it, or it
wrote a result since. Each line is logged as a `notice`, so none repeats or
is lost across panel restarts. A mission with no recorded session falls back to
the old screen-checked gate answers.

Codex roles open without the "Trust this folder?" dialog: each is started
with `-c projects={"<main checkout>"={trust_level="trusted"}}`, the entry
answering the dialog would save (Codex keys trust by the repository root),
for that run only; `~/.codex/config.toml` is not changed.

Codex roles using `workspace-write` receive `--add-dir` grants for their own
Git worktree metadata, shared `objects`, and `refs/heads/role/<mission>` plus
its reflogs. This allows commits without granting the whole common Git
directory or main-branch refs. Mission refs and objects are shared, so this
is not isolation between roles in the same mission. The approval/sandbox
flags remain the ones in the plan. See the [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

### Copilot and JishuBuddy

Start either orchestrator with `troupe up --orch copilot -m <mission>` or
`troupe up --orch jishubuddy -m <mission>`. The launcher records the exact
session and its activity file in the mission log. Merely opening a panel
beside an existing, uninstrumented session does not install these lifecycle
integrations or take over that session.

Both names are available in plans, including builder and reviewer roles:

```yaml
roles:
  build:
    duty: builder
    agent: copilot
    model: auto
    effort: high
    flags: [--allow-tool=write]
    touches: [src/]
  review:
    duty: reviewer
    agent: jishubuddy
    # Optional: use an ID available in your JishuBuddy model catalog.
    # model: provider/model-id
    effort: low
    flags: [--approval, ask]
    touches: []
    reviews: [build]
```

Include each role's normal `## Role: <name>` instructions. Copilot receives
`--model`, `--reasoning-effort` and `-i <brief prompt>`. Its flags must
explicitly declare a tool allow/deny rule or approval policy; the example
allows writes but does not automatically grant shell commands. Existing
account and local permission policies still apply.

Copilot's per-session `--plugin-dir` plugin lives under
`<worktree>/.troupe/copilot-plugin`. Native prompt, tool, permission and
stop hooks publish `.troupe/activity.json`. No shared Copilot configuration
is rewritten. Disabling hooks, including through organization policy,
prevents reliable readiness: inspect the agent's terminal and re-enable
the integration rather than bypassing `troupe send`.

JishuBuddy's public TUI does not accept a starting prompt or per-run model
options. Instead, troupe starts one persistent `jishubuddy rpc` process per
pane. The bridge sets the requested model and thinking level before sending
the brief and keeps the same session for follow-up work. An unavailable or
ambiguous model fails visibly; use `provider/model-id` to disambiguate.
Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and
`max`, subject to the selected model's support.

`--approval ask` is a **troupe bridge option**, not a native JishuBuddy
flag. It preserves normal JishuBuddy approval behavior without passing
`--yolo`. Only an explicitly approved `flags: [--yolo]` selects bypass mode;
troupe never adds it automatically. Selection dialogs require the displayed
option number; confirmations default to **no**. Replies remain in the
agent's pane, not in `troupe send`. The bridge supports streamed text,
tool activity and select/confirm/input/editor dialogs; editor replies are
one line unless pasted as a bracketed multi-line message. It is not the
original JishuBuddy TUI and does not provide its slash-command menus.

Bridge commands: `/abort` interrupts work, `/cancel` cancels a dialog,
`/exit` closes the session, and `/help` shows these commands. Protocol
errors, startup failures and RPC timeouts are printed to stderr and exit
nonzero. A request response acknowledges acceptance, not completion:
`agent_end` is not considered idle, because a retry may follow.
Readiness requires `agent_settled` and an idle state with no queued prompts
or compaction. These events, and Copilot's stop hook, drive both role
readiness and orchestrator notifications; answered waits use the existing
once-only notice mechanism. Context/token counters are not yet provided
for these two agents.

`troupe setup` installs the Copilot skill under
`$COPILOT_HOME/skills/troupe-mission` (default `~/.copilot/skills`) and the
JishuBuddy skill under `~/.agents/skills/troupe-mission`, shared with Codex.
The shared target is installed or removed only once; unmarked user files
are never overwritten. Run `troupe setup` again after updating your build.
If an agent cannot start, run it directly to check login and provider
configuration, then inspect `troupe status --json` and its pane. An
unreported turn stays unknown rather than being treated as ready.

To roll back locally, close affected mission panes with `troupe close
--all -m <mission>` and use `--orch claude` or `--orch codex` for new
missions. Branches and worktrees remain available; shared agent settings
are unchanged.

## Where things live

| What | Where | In git |
|---|---|---|
| the mission worktree | `.troupe/missions/<mission>` on `mission/<mission>` | no |
| the plan | `docs/missions/<mission>/plan.md` in the mission worktree | yes |
| the run log (approvals, gates, stages, dispatches) | `<git-common-dir>/troupe/<mission>/log.jsonl` | no |
| the role's launch brief | `<worktree>/.troupe/brief.md` (archived beside the run log as `brief-<role>.md`) | no |
| role worktrees | `.troupe/worktrees/<mission>/<role>` (`/.troupe/` is excluded) | no |
| a role's result | `<worktree>/.troupe/result.md` | no |

## Known limits

- The log is advisory, as any file is: it stops a forgetful dispatch, not a
  model set on writing it by hand.
- Screen patterns come from Claude Code 2.1.310 and Codex 0.162.1 in
  English. They no longer decide when a built-in role is ready, only whether
  a running turn waits on you; a screen troupe does not recognise is
  `unknown` and is never typed into.
- Codex logs no approval request, so a Codex role waiting on one shows as
  waits only while its screen pattern matches; either way it is not ready.
  Its answer is not told to the orchestrator.
- Context use comes from each role's transcript. Codex logs its window; for
  Claude, troupe launches the role with a status line (`--settings`) that
  saves the window Claude Code reports to `.troupe/context.json`, then runs
  the status line you configured, so yours still shows. Until it first runs,
  the panel assumes 200k, or 1M once the context passes 200k.

## Development

From a clone: `npm ci && npm run build && npm link` puts your build of
`troupe` on the `PATH`. `./check.sh` (or `npm test`) builds and runs the tests under plain Node; CI
runs them on macOS and Linux with Node 20 and 22. `src/` holds everything:
the plan, duties and workflows (`plan.ts`, `duties.ts`, `workflows.ts`,
`stages.ts`, `yaml.ts`, `touches.ts`), the adapters (`agents.ts`),
the log and the live reads (`log.ts`, `state.ts`), the commands
(`commands.ts`, `role-commands.ts`, `command-context.ts`, `missions.ts`,
`panes.ts`, `setup.ts`), and the panel (`model.ts`, `draw.ts`, `canvas.ts`, `panel*.ts`).
