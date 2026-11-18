<p align="center">
  <img src="assets/readme-banner.svg" width="960" alt="troupe — One command. Your agents, in order.">
</p>

<p align="center">
  Put Claude Code and Codex on the same team.<br>
  See every agent. Step in anytime.
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-F4EEE0?style=for-the-badge" alt="English — current language"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/简体中文-263C55?style=for-the-badge" alt="阅读简体中文版"></a>
</p>

<p align="center">
  <a href="#demo"><img src="https://img.shields.io/badge/Watch_the_demo-F29B7A?style=for-the-badge" alt="Watch the demo"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_start-263C55?style=for-the-badge" alt="Quick start"></a>
  <a href="docs/guide.md"><img src="https://img.shields.io/badge/User_guide-263C55?style=for-the-badge" alt="User guide"></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2F5079"></a>
  <a href="docs/guide.md#agents"><img alt="Claude Code and Codex" src="https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-2F5079"></a>
  <img alt="Runs in tmux" src="https://img.shields.io/badge/runs%20in-tmux-2F5079">
</p>

## Demo

A task from plan to review and cleanup, in 68 seconds.

<p align="center">
  <a href="https://media.tianqiz.me/troupe/film-en.mp4">
    <img src="docs/media/demo-en.jpg" width="860" alt="Open the English demo: the troupe panel shows the team and highlights an agent waiting for you">
  </a>
  <br>
  <a href="https://media.tianqiz.me/troupe/film-en.mp4"><b>▶ English demo · 1:08</b></a>
  · <a href="https://media.tianqiz.me/troupe/film-zh.mp4">中文版</a>
  · <a href="https://github.com/hitianqi/troupe/releases/tag/troupe-video-v2">1080p downloads</a>
</p>

## Why troupe

- **See the team, and step in.** Every agent is a real Claude Code or Codex session. One panel shows who is working and who needs you. Jump into any agent's terminal to read along or answer it.
- **Agree on the work before it starts.** Review the plan, change the split, and approve it. Each role gets its own git worktree and branch; planned file overlaps need an explicit order.
- **Build and review with different agents.** Mix Claude Code and Codex, models and effort per role. The default workflow reviews each branch, asks before opening the pull request, and waits for your merge confirmation before cleanup.

<p align="center">
  <img src="docs/media/panel-live.gif" width="860" alt="The live troupe panel: agent roles, work stages, activity and a flow of the team">
</p>

## Quick start

You need **macOS, Linux or WSL2**, **tmux**, **Node.js 20+**, **git**, and at least one supported agent installed and signed in: **Claude Code, Codex, GitHub Copilot CLI or JishuBuddy**. JishuBuddy itself requires Node.js 22+.

Install:

```sh
npm install -g troupe-cli
troupe setup
```

To run your own build instead, see [Contributing](CONTRIBUTING.md).

`troupe setup` installs the workflow skill for the agents it finds.

Then open Claude Code or Codex **inside tmux, in the repository you want to change**, and ask:

```text
Run a troupe mission: add a search box that filters the list as you type,
and a dark theme that follows the system setting.
```

The agent writes the plan and opens the panel beside it. Read the plan, press **`a`** to approve or **`c`** to request changes, and the team starts after approval.

You can also run `troupe up -m <mission>` in your target repository to start the orchestrator and panel together.

For Copilot or JishuBuddy, use the instrumented launcher so completion notices
are delivered only after a real turn ends:

```sh
troupe up -m my-change --orch copilot
# Or, for a different mission:
troupe up -m another-change --orch jishubuddy
```

Both can also be execution or review roles. Copilot keeps its native terminal
interface; JishuBuddy runs in a troupe-owned interactive terminal over its
persistent RPC interface, with streaming output and human approval dialogs.
See [agent configuration](docs/guide.md#copilot-and-jishubuddy).

## From one task to a finished change

1. **Plan together.** The orchestrator reads your code and proposes the work, roles and completion criteria. You can ask for changes before approving.
2. **Watch the team work.** Independent roles run in parallel; dependent roles wait their turn. Each has a terminal and worktree of its own. The panel shows when someone needs you.
3. **Review each branch.** A reviewer checks the work as it lands. Findings go back to the same agent for a fix round before the orchestrator merges into the mission branch.
4. **Approve the handoff.** You approve opening the pull request, merge it yourself, and confirm. The workflow then closes its terminals and removes its temporary worktrees.

<details>
<summary><b>See it run, step by step</b></summary>
<br>

<table>
<tr>
<td width="50%" valign="top"><img src="docs/media/step-1-plan.gif" alt="The orchestrator drafts the plan, you approve it, and the roles are dispatched"><br><b>1. Approve the plan.</b> The orchestrator drafts it; once you approve, each role is dispatched.</td>
<td width="50%" valign="top"><img src="docs/media/step-2-flow.gif" alt="The FLOW: roles working, a branch landing and lighting the way to review"><br><b>2. Watch the work flow.</b> Each role works in its own window; a finished branch lights the way to review.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/media/step-3-waits.gif" alt="A role stops at a trust prompt and the panel shows it waits on you"><br><b>3. Step in when asked.</b> When an agent waits on you, the panel says so and shows its window.</td>
<td width="50%" valign="top"><img src="docs/media/step-4-pages.gif" alt="The panel's five pages, one after another"><br><b>4. Look closer.</b> Five pages: the team, each role, the plan, the log and the changes.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/media/step-5-mr.gif" alt="Review passes every branch and the pull request waits for your approval"><br><b>5. Approve the pull request.</b> Review passes every branch; the pull request opens only when you say so.</td>
<td></td>
</tr>
</table>

</details>

## Make it yours

Orchestration, duty roles, task roles, and workflows are cleanly separated:

- **One orchestrator** ([`skills/troupe-mission/SKILL.md`](skills/troupe-mission/SKILL.md)) stays workflow-agnostic and follows whichever workflow a mission references (`troupe up -m <mission> -w <workflow>` or `workflow: <name>` in `plan.md`).
- **Workflows** ([`workflows/`](workflows/)) arrange stages, allowed duty roles, human gates, and teardown policies (`delivery`, `design-first`, `investigation`, `direct`). Inspect them with `troupe workflow list` / `troupe workflow show <name>`, or add your own under `.troupe/workflows/<name>.md` or `~/.config/troupe/workflows/<name>.md`.
- **Duty roles** ([`roles/`](roles/)) define reusable contracts (`builder`, `reviewer`, `architect`, `researcher`, `tester`), while **task roles** in `plan.md` bind each concrete window/worktree to a `duty` and workflow `stage`. Inspect duties with `troupe role list` / `troupe role show <duty>`, or customize them under `.troupe/roles/<duty>.md` or `~/.config/troupe/roles/<duty>.md`.

The CLI checks plan approval (hashed across `plan.md`, workflow, and duty definitions), stage gates, active stage dispatch boundaries, role dependencies, declared file overlaps, and agent permissions.

Multiple missions can run in the same repository or across repositories. Each gets its own mission branch and worktree; your original checkout stays on its branch.

- [User guide](docs/guide.md) — plan format, commands, panel controls, adapters and known limits.
- [Roadmap](ROADMAP.md) — product direction and what's next.
- [Contributing](CONTRIBUTING.md) — development setup, checks and adding an agent.
- [Issues](https://github.com/hitianqi/troupe/issues) — bugs, questions and feature requests.

## Acknowledgements

<a href="https://github.com/Prover-Technology"><img src="https://github.com/Prover-Technology.png" width="48" height="48" alt="Prover" align="left"></a>

troupe started as an internal tool at [Prover](https://github.com/Prover-Technology) and is open-sourced with their support. See [NOTICE](NOTICE).

<br clear="left">

MIT licensed. Built with TypeScript, tmux and git, with no runtime npm dependencies.
