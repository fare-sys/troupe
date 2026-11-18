# <mission>: <title>

## Intent

<Two or three sentences: what the person wants and why; link the issue.>

## Done when

- <one line the person can check: what, not how>
- <one line the person can check>

## Out of scope

<What this mission deliberately does not do.>

## Decisions for you

1. <A question the code cannot answer, with the options.> **Recommended:
   <option>**, because <reason>. Approving takes the recommendations; a
   different answer is a change.

<Leave the section out when there is none.>

## How the work is split

<Why the roles are cut where they are. Files that change together sit in one
role. A hub file (shared helpers, types, config) is touched by exactly one
role. Two roles whose `touches` overlap are ordered by `depends_on`;
everything else runs at once.>

```yaml
troupe: 1
goal: "<the mission in one sentence: what it delivers>"
why: "<one line: why now>"
workflow: troupe-mission
base: mission/<mission>         # roles are cut from it at dispatch; you merge onto it
profiles:                       # settings several roles share; a role's own fields win
  claude-build:
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
    text: workflow:builder      # the workflow's builder rules, then the role's section
  codex-build:
    agent: codex
    model: <model>
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    text: workflow:builder
roles:                          # one role = one window, one worktree, one branch
  api:
    use: codex-build
    goal: "<one line: what this role delivers>"
    touches: [src/api/]         # a trailing slash means the whole directory
  web:
    use: claude-build
    model: sonnet
    goal: "<one line>"
    touches: [web/src/]
    depends_on: [api]           # opens once api's result says done
  review:
    agent: claude
    model: sonnet
    effort: high
    flags: [--permission-mode, acceptEdits]
    goal: "Review each branch as it lands"
    touches: []                 # changes no files
    reviews: [api, web]
    text: workflow:reviewer
```

Each role resolves its `agent` (`claude`, `codex`, `copilot`, `jishubuddy`, or
an adapter in `.troupe/agents/`) and `flags` (directly or via `use:` from
`profiles`). `flags` must explicitly pin the agent's permission rather than
relying on CLI defaults (Claude Code: `--permission-mode`; Codex: `-a` and
`-s`; Copilot: `--allow-tool`; JishuBuddy: `--approval`). Keep each value on
one line. If a role needs a file outside its `touches`, update and re-approve
this plan before the next dispatch.

## Role: api

- **Deliver**: <what this role builds or changes>
- **Do not change**: <adjacent modules, contracts, or behavior to leave untouched>
- **Verify**: <exact check commands or runtime path to exercise>

## Role: web

- **Deliver**: <what this role builds or changes>
- **Do not change**: <adjacent modules, contracts, or behavior to leave untouched>
- **Verify**: <exact check commands or runtime path to exercise>

## Role: review

- **Focus**: <mission-specific invariants, integration boundaries, or risks to verify beyond standard reviewer rules>
