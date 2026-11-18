---
summary: "Fast local workflow: plan -> build -> optional verify -> local branch integration without PR/push"
stages:
  - id: plan
    label: Plan
  - id: plan-ok
    label: "Plan OK?"
    gate: plan
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

1. **`plan` -> `plan-ok` (`gate: plan`)**: Draft `plan.md` with `workflow: direct`, defining `build`-stage `builder` role(s) and optional `verify`-stage `tester` or `reviewer` role(s). Run `troupe check`, commit `plan.md`, and run `troupe gate plan "<one-line summary>"`.
2. **`build` (`duties: [builder]`)**: Run `troupe stage build` and dispatch ready `builder` roles inside their isolated worktrees.
3. **`verify` (`duties: [tester, reviewer]`, optional)**: Run `troupe stage verify`. If `tester` or `reviewer` roles are present in `plan.md`, run them against the completed builder branches and iterate fixes (one fix round) until checks pass.
4. **`integrate` -> `accept-ok` (`gate: accept-ok`)**: Run `troupe stage integrate`, merge all role branches onto `mission/<mission>`, run the repository's check suite on `mission/<mission>`, then run `troupe stage accept-ok` and `troupe gate accept-ok "<integrated summary and verification results>"`.
5. **`teardown`**: Once `accept-ok` is approved, run `troupe stage teardown -m <mission>` and `troupe teardown -m <mission>` (all role branches with commits must be merged onto `mission/<mission>`; remote push is not required).
