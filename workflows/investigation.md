---
summary: "Read-only research and synthesis workflow without code merge or remote push requirements"
stages:
  - id: plan
    label: Plan
  - id: plan-ok
    label: "Plan OK?"
    gate: plan
  - id: explore
    label: Explore
    duties: [researcher, architect]
    required: true
  - id: synthesize
    label: Synthesize
    duties: [reviewer]
  - id: report-ok
    label: "Report OK?"
    gate: report-ok
    next: "Run troupe stage teardown -m {mission} and troupe teardown -m {mission}, then report the cleanup."
  - id: teardown
    label: Teardown
teardown:
  require_merge: false
  require_push: false
---
# Investigation Workflow

Use `investigation` for root-cause debugging, security/performance audits, architecture spikes, or multi-angle codebase exploration where the deliverable is a verified report rather than merged production code.

## Stage Playbook

1. **`plan` -> `plan-ok` (`gate: plan`)**: Draft `plan.md` with `workflow: investigation`, splitting independent investigation angles across `explore`-stage roles (`duty: researcher` or read-only `duty: architect` with `touches: []`), and optionally adding a `synthesize`-stage `reviewer` role to cross-check claims. Run `troupe check`, commit `plan.md`, and run `troupe gate plan "<one-line summary>"`.
2. **`explore` (`duties: [researcher, architect]`)**: Run `troupe stage explore` and dispatch all independent investigation roles in parallel. Collect each role's `.troupe/result.md` findings as completion notices arrive.
3. **`synthesize` (`duties: [reviewer]`, optional)**: Run `troupe stage synthesize`. If `reviewer` task roles are defined in `plan.md`, dispatch them and send the upstream `.troupe/result.md` paths to verify citations and challenge unsupported claims; otherwise cross-verify and synthesize the findings directly.
4. **`report-ok` (`gate: report-ok`)**: Present the consolidated evidence-backed report (root causes, `file:line` citations, options, and recommended next actions) to the person, then run `troupe stage report-ok` and `troupe gate report-ok "<one-line conclusion>"`.
5. **`teardown`**: Once `report-ok` is approved, run `troupe stage teardown -m <mission>` and `troupe teardown -m <mission>` to clean up role windows and worktrees (no branch merge or remote push is required).
