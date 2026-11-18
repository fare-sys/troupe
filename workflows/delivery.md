---
summary: "Standard plan -> parallel build -> streaming review -> merge -> PR/MR delivery"
stages:
  - id: plan
    label: Plan
  - id: plan-ok
    label: "Plan OK?"
    gate: plan
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
# Delivery Workflow

Use `delivery` for standard feature, bugfix, and refactor missions that ship reviewed code via a Pull Request / Merge Request.

## Stage Playbook

1. **`plan` -> `plan-ok` (`gate: plan`)**: Understand the request and affected code, draft `docs/missions/<mission>/plan.md` with disjoint `builder` (and optional `tester`) task roles plus a `reviewer` task role covering every build role, run `troupe check` until clean, commit the plan on `mission/<mission>`, and run `troupe gate plan "<one-line summary>"`.
2. **`build` (`duties: [builder, tester]`)**: Run `troupe stage build`, then `troupe dispatch <role>` for every ready `build`-stage role whose `depends_on` are done; independent roles run in parallel. End your turn and wait for role completion notices.
3. **`review` (`duties: [reviewer]`)**: Once the first branch finishes, run `troupe stage review`, dispatch the reviewer (`troupe dispatch <reviewer>`), and send each finished branch as it lands (`troupe send <reviewer> "Review role/<mission>/<role>: ..."`).
   - On `PASS`: merge the role branch onto `mission/<mission>` (`git -C <worktree> merge ...`, one commit per role `<role>: <summary>`). If dependent `build`-stage roles just became ready, run `troupe stage build`, dispatch them, and return to `review` as branches finish.
   - On `FAIL` (act-on findings): send findings back to the same builder window (`troupe send <builder> "<findings>"`), then re-review. After one fix round, rule on any remaining finding (merge or hold and explain to the person).
4. **`mr-ok` (`gate: mr-ok`)**: When every role branch is merged and verified on `mission/<mission>`, run `troupe stage mr-ok` and `troupe gate mr-ok "<what the MR delivers; open findings with your recommendation>"`. Do not push before `approve`.
5. **`mr` -> `merged` (`gate: merged`)**: Run `troupe stage mr`, push `mission/<mission>` (`git -C <worktree> push`), and open one PR/MR against the base branch. Then run `troupe stage merged` and `troupe gate merged "<the PR/MR link>"`, keeping role windows open in case the person asks for changes before merging.
6. **`teardown`**: Once `merged` is approved, run `troupe stage teardown -m <mission>` and `troupe teardown -m <mission>`, then report the cleanup result.
