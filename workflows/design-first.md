---
summary: "Architecture-gated workflow: plan -> design review gate -> build -> review -> MR"
stages:
  - id: plan
    label: Plan
  - id: plan-ok
    label: "Plan OK?"
    gate: plan
  - id: design
    label: Design
    duties: [architect, researcher]
    required: true
  - id: design-ok
    label: "Design OK?"
    gate: design-ok
    next: "Design approved. Update plan.md only if boundaries changed; otherwise run troupe stage build -m {mission} and dispatch ready build roles."
  - id: build
    label: Build
    duties: [builder, tester]
    required: true
  - id: review
    label: Review
    duties: [reviewer]
  - id: mr-ok
    label: "MR OK?"
    gate: mr-ok
    next: "Open the PR, then run troupe stage merged -m {mission} and troupe gate merged -m {mission} \"<the PR link>\". Keep the role windows: the person may ask for changes before merging."
  - id: mr
    label: Open MR
  - id: merged
    label: "Merged?"
    gate: merged
    next: "Run troupe stage teardown -m {mission} and troupe teardown -m {mission}, then report the cleanup."
  - id: teardown
    label: Teardown
teardown:
  require_merge: true
  require_push: true
---
# Design-First Workflow

Use `design-first` when architectural boundaries, API/data contracts, or technical trade-offs must be designed and approved by the person before implementation roles start editing production code.

## Stage Playbook

1. **`plan` -> `plan-ok` (`gate: plan`)**: Draft `plan.md` with `workflow: design-first`, defining one or more `design`-stage roles (`duty: architect` or `duty: researcher`), downstream `build`-stage roles (`duty: builder` / `tester`, typically `depends_on` the architect role), and `review`-stage roles (`duty: reviewer`). Run `troupe check`, commit `plan.md`, and run `troupe gate plan "<one-line summary>"`.
2. **`design` (`duties: [architect, researcher]`) -> `design-ok` (`gate: design-ok`)**: Run `troupe stage design` and dispatch the design/research roles. Review their outputs (`.troupe/result.md` or committed design docs inside `touches`). If committed docs were produced, merge the design branch onto `mission/<mission>`. Run `troupe stage design-ok` and `troupe gate design-ok "<architecture summary and recommended trade-offs>"`. If the design requires changing task boundaries in `plan.md`, update `plan.md`, run `troupe check`, commit, and re-run `troupe gate plan` first.
3. **`build` (`duties: [builder, tester]`)**: Once `design-ok` is approved, run `troupe stage build` and dispatch ready builders/testers.
4. **`review` (`duties: [reviewer]`)**: Stream completed branches through `reviewer` roles against `plan.md`, the approved design contracts, and `Done when` criteria. Merge `PASS` branches onto `mission/<mission>`; iterate one fix round on `FAIL`.
5. **`mr-ok` -> `mr` -> `merged` -> `teardown`**: Open gate `mr-ok` before pushing; on approval, push `mission/<mission>` and open the PR/MR under `troupe stage mr`, open gate `merged` with the PR/MR link, and run `troupe stage teardown -m <mission>` and `troupe teardown -m <mission>` once merged.
