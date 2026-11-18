---
summary: "Fast local workflow: plan -> optional spec -> build -> optional verify -> local branch integration without PR/push"
stages:
  - id: plan
    label: Plan
  - id: plan-ok
    label: "Plan OK?"
    gate: plan
  - id: spec
    label: Spec
    duties: [architect, researcher]
  - id: spec-ok
    label: "Spec OK?"
    gate: spec-ok
    skip_if_empty: spec
    next: "Spec approved. If it changes task boundaries, update plan.md, run troupe check, commit, and re-run troupe gate plan first; otherwise run troupe stage build -m {mission} and dispatch ready build roles."
  - id: build
    label: Build
    duties: [builder]
    required: true
  - id: verify
    label: Verify
    duties: [tester, reviewer]
  - id: integrate
    label: Integrate
  - id: accept-ok
    label: "Accept?"
    gate: accept-ok
    next: "Run troupe stage teardown -m {mission} and troupe teardown -m {mission}, then report the cleanup."
  - id: teardown
    label: Teardown
teardown:
  require_merge: true
  require_push: false
---
# Direct Workflow

Use `direct` for fast local iterations, prototypes, or single-developer repositories where integrated work stays on the local `mission/<mission>` branch without requiring a remote push or PR/MR.

## Stage Playbook

1. **`plan` -> `plan-ok` (`gate: plan`)**: Draft `plan.md` with `workflow: direct`, defining `build`-stage `builder` role(s) and optional `verify`-stage `tester` or `reviewer` role(s). When requirements, an implementation plan, or the architecture must be settled before building, add optional `spec`-stage roles (`duty: architect` or `duty: researcher`) and make the build roles that need their output `depends_on` them. Run `troupe check`, commit `plan.md`, and run `troupe gate plan "<one-line summary>"`.
2. **`spec` (`duties: [architect, researcher]`, optional) -> `spec-ok` (`gate: spec-ok`, skipped when `spec` has no roles)**: If `plan.md` schedules `spec`-stage roles, run `troupe stage spec` and dispatch them. Merge any branch with committed docs onto `mission/<mission>`, then run `troupe stage spec-ok` and `troupe gate spec-ok "<spec summary; decisions and open items that need the person>"`. If the spec changes task boundaries, update `plan.md`, run `troupe check`, commit, and re-run `troupe gate plan` first. If `plan.md` has no `spec` roles, the gate is skipped: go straight to `troupe stage build`.
3. **`build` (`duties: [builder]`)**: Run `troupe stage build` and dispatch ready `builder` roles inside their isolated worktrees.
4. **`verify` (`duties: [tester, reviewer]`, optional)**: Run `troupe stage verify`. If `tester` or `reviewer` roles are present in `plan.md`, run them against the completed builder branches and iterate fixes (one fix round) until checks pass.
5. **`integrate` -> `accept-ok` (`gate: accept-ok`)**: Run `troupe stage integrate`, merge all role branches onto `mission/<mission>`, run the repository's check suite on `mission/<mission>`, then run `troupe stage accept-ok` and `troupe gate accept-ok "<integrated summary and verification results>"`.
6. **`teardown`**: Once `accept-ok` is approved, run `troupe stage teardown -m <mission>` and `troupe teardown -m <mission>` (all role branches with commits must be merged onto `mission/<mission>`; remote push is not required).
