# troupe — roadmap

troupe calls up an agent troupe with one command. The orchestrator writes a
plan with the person; once they approve it, every role opens in a real tmux
window of its own, in its own git worktree, where the person can watch it and
talk to it directly. A panel beside the orchestrator stays open and shows the
work as it moves. The orchestrator and the roles run Claude Code or Codex, or
any terminal agent with an adapter.

## Direction

**What the product is.** Plan first, then roles: the orchestrator and the
person agree on `plan.md`, the person approves it in the panel, and only
then do role windows open. The persistent, interactive panel is part of the
product. What troupe is not: a port of one person's workflow. One
workflow-agnostic orchestrator skill executes whichever workflow a mission
references (`workflows/<name>.md` or `.troupe/workflows/<name>.md`), scheduling
reusable duty roles (`roles/<duty>.md` or `.troupe/roles/<duty>.md`) across its
stages without changing the orchestrator or CLI code.

**The rule that draws the line.** Code enforces only what keeps the work
correct; workflows and duty roles live in standalone Markdown definitions and
are selected by reference.

Enforced in code:
- No role window before the plan, hashed as it is now with the workflow, duty
  definitions, and extra role texts it references, is approved; approval lives
  in the run log.
- Stage gates and dispatch boundaries: `stage` cannot skip past an unapproved
  gate, and `dispatch` opens only task roles assigned to the active workflow
  stage.
- One role, one git worktree, one branch, one pane; overlapping `touches`
  need `depends_on`.
- Each role's `flags` pin its agent's permission; it is never inherited.
- Never type into a window that is not ready; touch only the panes troupe
  opened.
- The persistent panel.

**State is read, not guessed.** Everything troupe acts on comes from a
signal the source system reports: the run log, git, tmux, the result file,
and each agent's own hooks, status line payload and transcript. A role's
state, its context window and its turn ending are facts those systems
publish; troupe does not infer them from how a screen renders or from a
model name. Where no such signal exists yet, the fallback is labelled as one,
is never the only path for a decision that types, merges or deletes, and
gets an issue to replace it. A bug fixed by adding a pattern, a model list
or a timing guess is a symptom: find the signal that would have made it
impossible, and fix that. The same holds for waiting: troupe pushes an event
to whoever waits on it; nobody polls on a timer.

Built-in workflows (`delivery` by default, plus `design-first`,
`investigation`, and `direct`) live in `workflows/*.md`, while reusable duty
roles (`builder`, `reviewer`, `architect`, `researcher`, `tester`) live in
`roles/*.md`; either can be overridden or extended under
`~/.config/troupe/` or `<repo>/.troupe/`.

**Architecture.**

```
troupe            CLI: setup / up / workflow / role / panel / check / approve /
                  gate / stage / dispatch / status / send / wait / close; a
                  refusal exits 1 with the reason, which any harness's model reads
troupe panel      the persistent TUI in window 0 beside the orchestrator
skills/           the single workflow-agnostic orchestrator skill (SKILL.md)
workflows/        referenced workflows: stages, gates, allowed duties, playbook
roles/            reusable duty roles: touches/reviews/startup rules + instructions
templates/        starter plan.md template
agents            one adapter per harness: start command with a first prompt,
                  model and effort flags, permission flags, screen patterns
```

State: `plan.md` (tracked, hashed); `<git-common-dir>/troupe/<m>/log.jsonl`
(written only by the CLI and the panel); live reads from tmux, git and each
role's `.troupe/result.md`.

**Systems.** tmux on macOS, Linux and WSL2; macOS and Linux run in CI. Native
Windows is not planned.

## Where it stands

Real missions run end to end with a Claude Code or a Codex orchestrator, from
`troupe up` to the MR gate, with Claude Code and Codex roles side by side.

## Next

- **Install in one line**: `troupe-cli` on npm; a single-file binary later for
  machines without Node.
- **More agents**: built-in adapters for other terminal agents (Gemini CLI,
  OpenCode and others), each tested against its real screens.
- **Codex lifecycle hooks**: report a Codex role's turns through its own hooks,
  as Claude Code roles already do, instead of reading its session log.
- **A stricter workflow**: an optional `troupe-mission-strict` skill.

## Stays out

Terminal backends other than tmux (herdr is supported as the place the
orchestrator runs, with the roles still in tmux); native Windows.
