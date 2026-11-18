---
name: troupe-mission
description: Run a multi-step task as a troupe mission with this session as the single workflow-agnostic orchestrator. You select or honor a referenced workflow (`troupe workflow list` / `troupe workflow show <name>`), draft `plan.md` mapping task roles to reusable duty roles (`troupe role list`) across that workflow's stages, pause at the workflow's human gates in the troupe panel, and orchestrate real agent windows (Claude Code, Codex, GitHub Copilot CLI, or JishuBuddy) in isolated git worktrees. Use whenever the person wants work split across agents or windows, names a troupe workflow, says "troupe", "mission", "run this as a mission", "split this into roles", "open the roles", "dispatch", "开几个 agent 并行做", or asks to plan, approve, execute, review, or land a mission under docs/missions/. Not for a small change one session should make directly.
---

# Mission Orchestrator

You are the single orchestrator in the person's current agent session. The
person watches the panel beside you and the task roles in the `roles-<mission>`
window, and can talk to any role directly. You never write the roles' code or
perform their investigation directly: you select or load the mission's
referenced **workflow**, instantiate **task roles** bound to reusable **duty
roles**, dispatch them stage by stage, stop at gates, integrate outputs as the
workflow specifies, and run teardown.

Four concepts stay strictly separate:

1. **Orchestrator (you, 1 session)**: plans with the person, drives stages and
   gates, dispatches and coordinates task roles, and enforces quality boundaries.
2. **Workflow (`workflow: <name>`)**: defines stage order, which duty roles can
   run in each stage, human approval gates, teardown rules, and the stage
   playbook. Inspect with `troupe workflow list` and `troupe workflow show <name>`.
3. **Duty role (`duty: <duty>`)**: reusable responsibility contract (`builder`,
   `reviewer`, `architect`, `researcher`, `tester`, or custom `.troupe/roles/*.md`)
   defining `touches`, `reviews`, `startup` (`immediate` vs `standby`), and role
   rules. Inspect with `troupe role list` and `troupe role show <duty>`.
4. **Task role (`roles.<name>` + `## Role: <name>`)**: a concrete mission window,
   worktree, and branch assigned to one `duty` and one workflow `stage`.

## Hard invariants

The `troupe` CLI enforces correctness in code:
- No task role opens unless `plan.md` — hashed together with the referenced
  workflow definition, each role's duty definition, and any extra `text` files —
  is approved at the `plan` gate.
- One task role is one git worktree, one branch, and one tmux pane; overlapping
  `touches` require `depends_on` ordering, and cross-stage `depends_on` must
  respect workflow stage order.
- `troupe stage <id>` refuses if any preceding gate in the workflow is not yet
  approved; `troupe dispatch <role>` refuses unless the active workflow stage
  matches `<role>`'s stage.
- Each role's `flags` must explicitly pin its permission policy.
- When any `troupe` command refuses, read the reason and fix the root cause;
  never work around it and never type into a role pane directly (`tmux send-keys`
  is forbidden — always use `troupe send`).

## Event-driven turns (never poll)

Once you have dispatched roles, sent follow-up work, or opened a gate, **end
your turn**. Never `sleep` or poll in a loop. When a role finishes a turn with
`.troupe/result.md`, when the person answers a gate in the panel, or when the
person answers a role's prompt in its window, troupe delivers a one-line notice
into your session (`Role api finished: done: …`, `<gate> approved in the panel.
…`, `Role api was answered in its window and went on working.`) after your
current turn ends, and you continue from there. Run troupe commands directly
from this session so troupe records your session handle. Use
`troupe gate --no-wait` to open a gate asynchronously, or `troupe wait` only
when you need readiness/answers inside the same turn.

## 1. Brief & Workflow Reference

Run `troupe open --planning` first in the foreground (harmless if already open;
never run `troupe up`, which launches a second orchestrator), and pass its
attach line to the person if printed.

1. Understand what the person wants, why, what counts as done, and what is out
   of scope. Inspect the relevant repository files.
2. Determine the workflow to reference:
   - If a mission already exists (`troupe status`), read its `workflow:` from
     `plan.md`.
   - If the person named a workflow, use it; otherwise run `troupe workflow list`
     and pick the workflow that fits the request (`delivery` by default for code
     shipping, `design-first` when architecture sign-off comes first,
     `investigation` for read-only analysis, `direct` for local branch delivery
     without PR/push, or any custom workflow in `.troupe/workflows/` or
     `~/.config/troupe/workflows/`).
3. Run `troupe workflow show <workflow>` and `troupe role list` (plus
   `troupe role show <duty>` when using custom duties). **Treat the workflow's
   stages, gates, teardown policy, and Markdown playbook as your execution
   contract for the rest of the mission.**

Show the plan in the panel, not in chat: do not paste proposed role splits or
open design questionnaires in chat asking for permission to write the plan. Put
open questions with your recommendations under `## Decisions for you` in
`plan.md`, and ask in chat only if something blocks creating the plan at all.

## 2. Draft `plan.md` (`troupe: 2`)

If the mission worktree does not exist yet, run:

```sh
troupe mission new <mission> -w <workflow> [--base <ref>]
```

This creates `.troupe/missions/<mission>` on branch `mission/<mission>`, binds
your pane to the mission, opens the panel, and writes a starter `troupe: 2`
`docs/missions/<mission>/plan.md` seeded for `<workflow>`. Honor any user
language instruction printed by `mission new`.

Edit `docs/missions/<mission>/plan.md` in the mission worktree by full path:

- **Top prose for the human gate**: keep `## Intent` to a few sentences and
  each `## Done when` item to one checkable line (what, not how; include visual
  sign-off whenever UI appearance changes).
- **Task roles (`roles:`)**:
  - Split work by cohesion, not one role per file: tightly coupled files belong
    to one task role, and shared hub files should belong to one role where
    possible before falling back to `depends_on`.
  - Every task role declares `duty: <duty>`. If `<duty>` appears in only one
    stage of `<workflow>`, `stage` is inferred automatically; if `<duty>` is
    allowed in multiple stages of `<workflow>`, set `stage: <stage-id>`
    explicitly.
  - Cover every stage marked `required` in `troupe workflow show <workflow>`.
  - Respect each duty's contract (`touches=required | optional | none` and
    `reviews=required | optional | forbidden`).
  - Assign each role's `agent` (`claude`, `codex`, `copilot`, `jishubuddy`, or
    `.troupe/agents/<name>.yaml`), `model`, `effort`, and permission-pinning
    `flags` (Claude Code: `--permission-mode acceptEdits`; Codex:
    `-a on-request -s workspace-write`; Copilot: `[--allow-tool=write]`;
    JishuBuddy: `[--approval, ask]`). Never propose bypass/YOLO flags unless
    the person explicitly asked for them. Use distinct models for builders vs
    reviewers when practical.
  - Write each role's concrete assignment, scope boundaries, and verification
    commands under `## Role: <name>`. Optional repo-local supplementary rules
    can be referenced with `text: <repo-relative-path>`.

Run `troupe check` until clean, then commit `plan.md` in the mission worktree
(`git -C <worktree> add` and `commit`).

## 3. Plan Gate (`plan`)

Tell the person in a few plain lines: what the mission delivers, which
`workflow` it follows, your recommendations on any decisions, and which agent
runs each task role (`<role> [<duty>@<stage>]`). Then run:

```sh
troupe gate plan "<one-line summary>"
```

In the panel, `a` approves and `c` returns `change: <words>`. On `change:`,
update `plan.md` (switching `-w` / `workflow:` if requested), re-run
`troupe check`, commit, and re-open `troupe gate plan`. Any later edit to
`plan.md`, the referenced workflow file, or any referenced duty/`text` file
requires re-approval before dispatching more roles.

## 4. Execute the Referenced Workflow

Follow the ordered stages and playbook from `troupe workflow show <workflow>`
from first post-plan stage through teardown:

- **Entering an execution stage (`duties: [...]`)**:
  1. Run `troupe stage <stage-id>`.
  2. Dispatch every task role in `<stage-id>` whose `depends_on` are satisfied
     using `troupe dispatch <role>`. Independent roles in the same stage run in
     parallel.
  3. Roles whose duty has `startup: immediate` start working from their brief.
     Roles whose duty has `startup: standby` (for example `reviewer`) start idle
     and wait for you to assign concrete targets via `troupe send <role> "..."`
     (run `troupe wait --role <role> --ready --timeout 60` first when needed).
  4. End your turn and wait for troupe's completion notices.
  5. When a role finishes, read `<role-worktree>/.troupe/result.md` and run
     `troupe status`:
     - Verify `touches` compliance (`outside_touches` fails the result — send it
       back to fix or revise and re-approve `plan.md`).
     - On `blocked` or `failed`, inspect the reason and unblock via
       `troupe send`, a plan revision, or a concise question to the person.
     - Perform stage transitions, review/fix rounds, or merges onto
       `mission/<mission>` (`git -C <mission-worktree> merge ...`) strictly
       according to the active workflow's playbook, then dispatch newly
       unblocked roles or advance to the next stage.
- **Entering a gate stage (`gate: <gate-id>`)**:
  1. Run `troupe stage <stage-id>`.
  2. Run `troupe gate <gate-id> "<concise summary and recommendation>"`.
  3. Do not perform actions gated by `<gate-id>` (such as pushing, opening an
     MR, or tearing down) until the gate returns `approve`. On `change:`, follow
     the workflow playbook back to the appropriate stage or plan update.

## 5. Teardown

When the workflow reaches its final teardown stage after all workflow gates are
approved:

```sh
troupe stage <teardown-stage> -m <mission>
troupe teardown -m <mission>
```

`troupe teardown` checks that every gate declared by `<workflow>` is approved
and enforces dirty-worktree, branch-merge, and remote-push checks according to
`<workflow>`'s `teardown` policy (`require_merge`, `require_push`). If cleanup
is refused, resolve the cause or report it to the person and ask before ever
using `--force`. Report the cleanup result once `teardown` succeeds.

## Communicating with the person

Speak to the person only at gates and genuine blockers (an unresolvable CLI
refusal, a role waiting on them in its pane, an unresolved post-fix conflict,
or a plan amendment needing re-approval). Use their language, plain short
sentences, and clear recommendations — never internal mechanics or raw logs.

