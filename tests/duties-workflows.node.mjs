import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AGENTS } from '../dist/agents.js'
import { execute } from '../dist/commands.js'
import { runtime } from '../dist/command-context.js'
import { builtinDuties, loadDuties, readDuty } from '../dist/duties.js'
import { append } from '../dist/log.js'
import { mission } from '../dist/missions.js'
import { readPlan } from '../dist/plan.js'
import { loadProfiles, readProfile } from '../dist/profiles.js'
import { briefOf } from '../dist/role-commands.js'
import { afterGateApproval, builtinWorkflows, effectiveStageId, loadWorkflows, readWorkflow, skippedGates, skippedStageIds } from '../dist/workflows.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const initGitRepo = t => {
  const root = mkdtempSync(join(tmpdir(), 'troupe-dw-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  write(join(root, 'README.md'), '# probe\n')
  git('add', '.')
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'initial')
  const home = join(root, '.test-home')
  mkdirSync(home, { recursive: true })

  return { root, home, git }
}

test('AC-6: orchestrator skill directory is workflow-agnostic and package assets sit at root', () => {
  const skillDir = join(ROOT, 'skills/troupe-mission')
  assert.deepEqual(readdirSync(skillDir), ['SKILL.md'])
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  assert.match(skill, /troupe workflow show/)
  assert.match(skill, /troupe role show/)
  assert.doesNotMatch(skill, /stages\.yaml/)
  assert.doesNotMatch(skill, /text:\s*workflow:/)

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const dir of ['dist', 'roles', 'workflows', 'templates', 'skills']) {
    assert.ok(pkg.files.includes(dir), `package.json files should include ${dir}`)
  }
})

test('AC-1: built-in duties and workflows resolve across built-in < user < repo layers with line diagnostics', t => {
  const duties = builtinDuties()
  assert.deepEqual(Object.keys(duties).sort(), ['architect', 'builder', 'researcher', 'reviewer', 'tester'])
  const workflows = builtinWorkflows()
  assert.deepEqual(Object.keys(workflows).sort(), ['delivery', 'design-first', 'direct', 'investigation'])

  const base = mkdtempSync(join(tmpdir(), 'troupe-layers-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'home')
  const repo = join(base, 'repo')

  // User layer overrides builder and adds security-auditor.
  write(
    join(home, '.config/troupe/roles/builder.md'),
    '---\nsummary: User builder override\ntouches: required\nstartup: immediate\nreviews: forbidden\n---\nUser builder body.\n',
  )
  write(
    join(home, '.config/troupe/roles/security-auditor.md'),
    '---\nname: security-auditor\nsummary: Audits auth and secrets\ntouches: none\nstartup: standby\nreviews: required\n---\nAudit everything.\n',
  )

  let loadedDuties = loadDuties(repo, home)
  assert.deepEqual(loadedDuties.problems, [])
  assert.equal(loadedDuties.duties.builder.source, 'user')
  assert.equal(loadedDuties.duties.builder.summary, 'User builder override')
  assert.equal(loadedDuties.duties['security-auditor'].source, 'user')

  // Repo layer overrides user builder and defines a custom workflow composing built-in + user duties.
  write(
    join(repo, '.troupe/roles/builder.md'),
    '---\nname: builder\nsummary: Repo builder override\ntouches: required\nstartup: immediate\nreviews: forbidden\n---\nRepo builder body.\n',
  )
  write(
    join(repo, '.troupe/workflows/hardened.md'),
    [
      '---',
      'name: hardened',
      'summary: Design, build, test, and security audit',
      'teardown:',
      '  require_merge: true',
      '  require_push: false',
      'stages:',
      '  - id: plan-ok',
      '    label: Plan OK?',
      '    gate: plan',
      '    next: "Start design for {mission}."',
      '  - id: design',
      '    label: Design',
      '    duties: [architect]',
      '    required: true',
      '  - id: build',
      '    label: Build',
      '    duties: [builder]',
      '    required: true',
      '  - id: audit',
      '    label: Security Audit',
      '    duties: [tester, security-auditor]',
      '  - id: signoff',
      '    label: Signoff?',
      '    gate: signoff-ok',
      '    next: "Finish {mission}."',
      '---',
      'Run design, then build, then audit.',
    ].join('\n'),
  )

  loadedDuties = loadDuties(repo, home)
  const loadedWorkflows = loadWorkflows(repo, home, undefined, loadedDuties.duties)
  assert.deepEqual(loadedDuties.problems, [])
  assert.deepEqual(loadedWorkflows.problems, [])
  assert.equal(loadedDuties.duties.builder.source, 'repo')
  assert.equal(loadedDuties.duties.builder.summary, 'Repo builder override')
  assert.equal(loadedWorkflows.workflows.hardened.source, 'repo')
  assert.deepEqual(loadedWorkflows.workflows.hardened.teardown, { requireMerge: true, requirePush: false })
  assert.equal(afterGateApproval(loadedWorkflows.workflows.hardened, 'signoff-ok', 'm9'), 'Finish m9.')

  // Schema error diagnostics carry line numbers and descriptive messages.
  assert.throws(() => readDuty('BadName', '---\nsummary: x\n---\nbody\n', { path: 'x', source: 'repo' }), /lower case/)
  assert.throws(() => readDuty('custom', 'no front matter', { path: 'x', source: 'repo' }), /line 1:.*front matter/)
  assert.throws(
    () => readDuty('custom', '---\nname: wrong\nsummary: x\n---\nbody\n', { path: 'x', source: 'repo' }),
    /line 2: name must match file name "custom"/,
  )
  assert.throws(
    () => readDuty('custom', '---\nsummary: x\ntouches: invalid\n---\nbody\n', { path: 'x', source: 'repo' }),
    /line 3: touches must be one of/,
  )
  assert.throws(
    () => readDuty('custom', '---\nsummary: x\n---\n   \n', { path: 'x', source: 'repo' }),
    /body must not be empty/,
  )
  assert.throws(
    () => readWorkflow(
      'broken',
      '---\nsummary: x\nstages:\n  - id: s1\n    label: S1\n    gate: g1\n    duties: [builder]\n---\nbody\n',
      { path: 'w', source: 'repo' },
    ),
    /a gate stage cannot also declare duties/,
  )
  assert.throws(
    () => readWorkflow(
      'broken',
      '---\nsummary: x\nstages:\n  - id: s1\n    label: S1\n    gate: plan\n---\nbody\n',
      { path: 'w', source: 'repo' },
    ),
    /at least one execution stage/,
  )

  write(
    join(repo, '.troupe/workflows/bad-ref.md'),
    '---\nsummary: Bad duty ref\nstages:\n  - id: p\n    label: P\n    gate: plan\n  - id: s1\n    label: S1\n    duties: [nonexistent-duty]\n---\nbody\n',
  )
  const withBadRef = loadWorkflows(repo, home, undefined, loadedDuties.duties)
  assert.ok(withBadRef.problems.some(p => p.includes('unknown duty "nonexistent-duty"')))
})

test('AC-2: CLI inspects workflows and duties, and mission new -w generates check-clean starter plans for every workflow', async t => {
  const { root, home } = initGitRepo(t)
  const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' } })

  const wfList = await execute('workflow', ['list', '--json'], r)
  assert.equal(wfList.code, 0)
  const wfJson = JSON.parse(wfList.out)
  assert.deepEqual(wfJson.workflows.map(w => w.name), ['delivery', 'design-first', 'direct', 'investigation'])

  const wfShow = await execute('workflow', ['show', 'design-first'], r)
  assert.equal(wfShow.code, 0)
  assert.match(wfShow.out, /Workflow: design-first \(built-in\)/)
  assert.match(wfShow.out, /design \(Design\) · duties: architect, researcher · required/)

  const roleList = await execute('role', ['list', '--json'], r)
  assert.equal(roleList.code, 0)
  const roleJson = JSON.parse(roleList.out)
  assert.deepEqual(roleJson.roles.map(d => d.name), ['architect', 'builder', 'researcher', 'reviewer', 'tester'])

  const roleShow = await execute('role', ['show', 'tester'], r)
  assert.equal(roleShow.code, 0)
  assert.match(roleShow.out, /Duty role: tester \(built-in\)/)
  assert.match(roleShow.out, /Constraints: touches=optional, startup=immediate, reviews=optional/)

  assert.equal((await execute('workflow', ['show', 'missing'], r)).code, 1)
  assert.equal((await execute('role', ['show', 'missing'], r)).code, 1)

  const badMission = await execute('mission', ['new', 'bad-wf', '-w', 'missing'], r)
  assert.equal(badMission.code, 1)
  assert.match(badMission.out, /unknown workflow "missing"/)

  // Every built-in workflow produces a starter plan that passes `troupe check` once `<model>` placeholders are filled.
  for (const wfName of ['delivery', 'design-first', 'investigation', 'direct']) {
    const mName = `m-${wfName}`
    const created = await execute('mission', ['new', mName, '-w', wfName], r)
    assert.equal(created.code, 0, created.out)
    const planPath = join(root, `.troupe/missions/${mName}/docs/missions/${mName}/plan.md`)
    const text = readFileSync(planPath, 'utf8').replaceAll('<model>', 'gpt-5.4')
    writeFileSync(planPath, text)
    const checked = await execute('check', [planPath], r)
    assert.equal(checked.code, 0, `${wfName} starter plan failed check: ${checked.out}`)
    const m = mission(r, mName)
    assert.equal(m.plan.workflow, wfName)
  }
})

test('AC-3: schema v2 static validation enforces duties, stage rules, touches/reviews contracts, and cross-stage ordering', () => {
  const duties = builtinDuties()
  const workflows = builtinWorkflows()

  const check = yamlBody => readPlan(
    `# Demo\n\n\`\`\`yaml\n${yamlBody}\n\`\`\`\n\n## Role: r1\n\nWork.\n\n## Role: r2\n\nMore work.\n`,
    AGENTS,
    { duties, workflows },
  )

  // Rejects troupe: 1 and legacy text: workflow:*
  assert.ok(check('troupe: 1\ngoal: g\nwhy: w\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]')
    .problems.some(p => p.includes('troupe: 1 is not a format this troupe reads (2)')))

  assert.ok(check('troupe: 2\ngoal: g\nwhy: w\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]\n    text: workflow:builder')
    .problems.some(p => p.includes('uses removed workflow: syntax; set duty: instead')))

  // Duty touches & reviews contracts
  assert.ok(check('troupe: 2\ngoal: g\nwhy: w\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: []')
    .problems.some(p => p.includes('duty "builder" requires nonempty touches')))

  assert.ok(check('troupe: 2\ngoal: g\nwhy: w\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]\n  r2:\n    duty: reviewer\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [docs/]\n    reviews: [r1]')
    .problems.some(p => p.includes('duty "reviewer" forbids touches')))

  assert.ok(check('troupe: 2\ngoal: g\nwhy: w\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]\n  r2:\n    duty: reviewer\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: []')
    .problems.some(p => p.includes('duty "reviewer" requires nonempty reviews')))

  // Missing required stage (`design` in `design-first`)
  assert.ok(check('troupe: 2\ngoal: g\nwhy: w\nworkflow: design-first\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]')
    .problems.some(p => p.includes('requires at least one role in stage "design"')))

  // Forward cross-stage depends_on (design role depending on build role) is rejected; backward (build depending on design) is valid.
  const forwardDep = check([
    'troupe: 2',
    'goal: g',
    'why: w',
    'workflow: design-first',
    'roles:',
    '  r1:',
    '    duty: architect',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [docs/]',
    '    depends_on: [r2]',
    '  r2:',
    '    duty: builder',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [src/]',
  ].join('\n'))
  assert.ok(forwardDep.problems.some(p => p.includes('cannot depend_on later-stage role "r2"')))

  const backwardDep = check([
    'troupe: 2',
    'goal: g',
    'why: w',
    'workflow: design-first',
    'roles:',
    '  r1:',
    '    duty: architect',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [docs/]',
    '  r2:',
    '    duty: builder',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [src/]',
    '    depends_on: [r1]',
  ].join('\n'))
  assert.deepEqual(backwardDep.problems, [])
  assert.equal(backwardDep.roles[0].stage, 'design')
  assert.equal(backwardDep.roles[1].stage, 'build')

  // Multi-stage duty ambiguity requires explicit `stage:`
  const multiStageWf = readWorkflow(
    'two-phase',
    '---\nsummary: Builder runs twice\nstages:\n  - id: plan-ok\n    label: Plan\n    gate: plan\n  - id: proto\n    label: Prototype\n    duties: [builder]\n    required: true\n  - id: harden\n    label: Harden\n    duties: [builder]\n---\nPlaybook.\n',
    { path: 'two-phase.md', source: 'repo' },
  )
  const ambiguous = readPlan(
    '# Demo\n\n```yaml\ntroupe: 2\ngoal: g\nwhy: w\nworkflow: two-phase\nroles:\n  r1:\n    duty: builder\n    agent: claude\n    flags: [--permission-mode, acceptEdits]\n    touches: [src/]\n```\n\n## Role: r1\n\nWork.\n',
    AGENTS,
    { duties, workflows: { 'two-phase': multiStageWf } },
  )
  assert.ok(ambiguous.problems.some(p => p.includes('appears in multiple stages of workflow "two-phase" (proto, harden); set stage: explicitly')))
})

test('AC-4 & AC-5: runtime stage/gate guards, duty briefs, and approval hash invalidation across design-first workflow', async t => {
  const { root, home } = initGitRepo(t)
  const planText = [
    '# Design-first probe',
    '',
    '## Done when',
    '',
    '- Spec and code ship cleanly.',
    '',
    '```yaml',
    'troupe: 2',
    'goal: Design then build',
    'why: Separation test',
    'workflow: design-first',
    'base: main',
    'roles:',
    '  arch:',
    '    duty: architect',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [docs/]',
    '  api:',
    '    duty: builder',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [src/]',
    '    depends_on: [arch]',
    '  rev:',
    '    duty: reviewer',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: []',
    '    reviews: [api]',
    '```',
    '',
    '## Role: arch',
    '',
    'Write architecture spec.',
    '',
    '## Role: api',
    '',
    'Implement API.',
    '',
    '## Role: rev',
    '',
    'Review API.',
    '',
  ].join('\n')
  write(join(root, 'docs/missions/df/plan.md'), planText)

  const panes = new Map()
  let seq = 0
  const run = (cmd, args, opts = {}) => {
    if (cmd === 'which') return { code: 0, out: `/usr/bin/${args[0]}\n`, err: '' }
    if (cmd === 'ps') return { code: 1, out: '', err: '' }
    if (cmd === 'tmux') {
      const sub = args[1] === '-L' ? args.slice(3) : args.slice(1)
      if (sub[0] === 'has-session') return { code: panes.size > 0 ? 0 : 1, out: '', err: '' }
      if (sub[0] === 'new-session' || sub[0] === 'new-window') {
        const id = `%${++seq}`
        panes.set(id, { id, owner: '', dead: false, screen: 'READY' })
        return { code: 0, out: `$1\t@1\t${id}\n`, err: '' }
      }
      if (sub[0] === 'set-option') {
        const p = panes.get(sub[sub.indexOf('-t') + 1])
        if (p && sub.at(-2) === '@troupe-owner') p.owner = sub.at(-1)
        return { code: 0, out: '', err: '' }
      }
      if (sub[0] === 'list-windows') return { code: 0, out: '@1\troles\n', err: '' }
      if (sub[0] === 'display') {
        const target = sub.includes('-t') ? sub[sub.indexOf('-t') + 1] : ''
        if (!target.startsWith('%')) return { code: 0, out: '/tmp/fake-tmux\n', err: '' }
        const p = panes.get(target)
        if (!p) return { code: 1, out: '', err: 'missing' }
        return { code: 0, out: `${p.id}\t0\t${p.owner}\n`, err: '' }
      }
      return { code: 0, out: '', err: '' }
    }
    try {
      const out = execFileSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] })
      return { code: 0, out, err: '' }
    } catch (err) {
      return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? err.message }
    }
  }
  const r = runtime({ cwd: root, home, env: { TROUPE_TMUX_SOCKET: 'dw-unit', LC_ALL: 'C', LANG: 'C' }, run, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })

  // 1. Cannot enter `design` before `plan` gate is approved.
  assert.match((await execute('stage', ['-m', 'df', 'design'], r)).out, /cannot enter stage design: gate plan is not approved yet/)

  // 2. Approve plan; `design` opens, while `build` is still blocked by `design-ok`!
  assert.equal((await execute('approve', ['-m', 'df'], r)).code, 0)
  assert.equal((await execute('stage', ['-m', 'df', 'design'], r)).code, 0)
  assert.match((await execute('stage', ['-m', 'df', 'build'], r)).out, /cannot enter stage build: gate design-ok is not approved yet/)

  // 3. Dispatching `api` (stage `build`) fails while mission is in `design`; dispatching `arch` succeeds!
  assert.match((await execute('dispatch', ['-m', 'df', 'api'], r)).out, /belongs to stage "build", while mission df is in stage "design"/)
  const dArch = await execute('dispatch', ['-m', 'df', 'arch'], r)
  assert.equal(dArch.code, 0, dArch.out)
  const archBrief = readFileSync(join(root, '.git/troupe/df/brief-arch.md'), 'utf8')
  assert.match(archBrief, /## Duty: architect/)
  assert.doesNotMatch(archBrief, /On initial startup before a branch is sent to you/)

  // Mark `arch` done and approve `design-ok`.
  write(join(root, '.troupe/worktrees/df/arch/.troupe/result.md'), '---\nstatus: done\nsummary: Spec ready\n---\nSpec details.\n')
  const mBeforeGate = mission(r, 'df')
  append(mBeforeGate.log, 'orch', { ev: 'gate-open', gate: 'design-ok', ask: 'Spec OK?' })
  append(mBeforeGate.log, 'panel', { ev: 'gate-answer', gate: 'design-ok', answer: 'approve' })

  // 4. Now `stage build` and `stage review` are permitted; standby reviewer gets standby brief.
  assert.equal((await execute('stage', ['-m', 'df', 'build'], r)).code, 0)
  const dApi = await execute('dispatch', ['-m', 'df', 'api'], r)
  assert.equal(dApi.code, 0, dApi.out)
  assert.equal((await execute('stage', ['-m', 'df', 'review'], r)).code, 0)
  assert.equal((await execute('dispatch', ['-m', 'df', 'rev'], r)).code, 0)
  const revBrief = readFileSync(join(root, '.git/troupe/df/brief-rev.md'), 'utf8')
  assert.match(revBrief, /## Duty: reviewer/)
  assert.match(revBrief, /On initial startup before a branch is sent to you/)

  // 5. Modifying the active workflow file invalidates the approved plan hash.
  const hashBefore = mission(r, 'df').hash
  write(
    join(root, '.troupe/workflows/design-first.md'),
    readFileSync(join(ROOT, 'workflows/design-first.md'), 'utf8') + '\nExtra playbook note.\n',
  )
  assert.notEqual(mission(r, 'df').hash, hashBefore)
})

test('mission workflow: a plan can reference its own workflow.md, validated, enforced, and hashed', async t => {
  const { root, home } = initGitRepo(t)
  const dir = join(root, 'docs/missions/custom')
  const planText = [
    '# Custom flow',
    '',
    '## Done when',
    '',
    '- It ships.',
    '',
    '```yaml',
    'troupe: 2',
    'goal: Probe a mission workflow',
    'why: Orchestrator-designed flow',
    'workflow: ./workflow.md',
    'base: main',
    'roles:',
    '  probe:',
    '    duty: researcher',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: []',
    '  api:',
    '    duty: builder',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [src/]',
    '    depends_on: [probe]',
    '```',
    '',
    '## Role: probe',
    '',
    'Map the code.',
    '',
    '## Role: api',
    '',
    'Implement it.',
    '',
  ].join('\n')
  const workflowText = duty => [
    '---',
    'summary: Research then build, landed locally',
    'stages:',
    '  - id: plan',
    '  - id: plan-ok',
    '    gate: plan',
    '  - id: research',
    `    duties: [${duty}]`,
    '    required: true',
    '  - id: build',
    '    duties: [builder]',
    '    required: true',
    '  - id: accept',
    '    gate: accept-ok',
    'teardown:',
    '  require_merge: false',
    '  require_push: false',
    '---',
    'Research, build, then ask for acceptance.',
    '',
  ].join('\n')
  write(join(dir, 'plan.md'), planText)
  const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
  const planPath = join(dir, 'plan.md')

  assert.match((await execute('check', [planPath], r)).out, /workflow \.\/workflow\.md: no valid workflow\.md next to plan\.md/)

  write(join(dir, 'workflow.md'), workflowText('wizard'))
  assert.match((await execute('check', [planPath], r)).out, /workflow\.md: workflow "\.\/workflow\.md" stage "research" references unknown duty "wizard"/)

  write(join(dir, 'workflow.md'), workflowText('researcher'))
  assert.match((await execute('check', [planPath], r)).out, /clean \(workflow \.\/workflow\.md; 2 roles: probe\[researcher@research\], api\[builder@build\]\)/)
  const loaded = mission(r, 'custom')
  assert.equal(loaded.workflow.source, 'mission')
  assert.deepEqual(loaded.workflow.teardown, { requireMerge: false, requirePush: false })

  write(join(dir, 'workflow.md'), workflowText('researcher').replace('landed locally', 'landed on a branch'))
  assert.notEqual(mission(r, 'custom').hash, loaded.hash)

  assert.equal((await execute('approve', ['-m', 'custom'], r)).code, 0)
  assert.equal((await execute('stage', ['-m', 'custom', 'research'], r)).code, 0)
})

test('skip_if_empty: an optional spec stage gates build only when the plan schedules spec roles', async t => {
  const wfText = ({ planGate = '', spec = '', specGate = '    skip_if_empty: spec\n', build = '' } = {}) =>
    [
      '---',
      'summary: probe',
      'stages:',
      '  - id: plan',
      '  - id: plan-ok',
      '    gate: plan',
      `${planGate}  - id: spec`,
      '    duties: [architect]',
      `${spec}  - id: spec-ok`,
      '    gate: spec-ok',
      `${specGate}  - id: build`,
      '    duties: [builder]',
      '    required: true',
      `${build}---`,
      'Body.',
      '',
    ].join('\n')

  // 1. Parsing: valid on a non-plan gate naming an earlier optional execution stage; refused otherwise.
  assert.equal(readWorkflow('probe', wfText()).stages.find(stage => stage.id === 'spec-ok').skipIfEmpty, 'spec')
  assert.throws(() => readWorkflow('probe', wfText({ planGate: '    skip_if_empty: spec\n' })), /only valid on a non-plan gate stage/)
  assert.throws(() => readWorkflow('probe', wfText({ specGate: '', build: '    skip_if_empty: spec\n' })), /only valid on a non-plan gate stage/)
  assert.throws(() => readWorkflow('probe', wfText({ specGate: '    skip_if_empty: build\n' })), /must name an earlier execution stage id \(got "build"\)/)
  assert.throws(() => readWorkflow('probe', wfText({ specGate: '    skip_if_empty: plan\n' })), /must name an earlier execution stage id \(got "plan"\)/)
  assert.throws(() => readWorkflow('probe', wfText({ spec: '    required: true\n' })), /cannot name required stage "spec"/)

  // 2. After plan approval the mission stands on build when spec is empty, on spec otherwise.
  const delivery = builtinWorkflows().delivery
  assert.deepEqual([...skippedStageIds(delivery.stages, ['build', 'review'])].sort(), ['spec', 'spec-ok'])
  assert.deepEqual([...skippedGates(delivery, [{ stage: 'build' }])], ['spec-ok'])
  assert.equal(effectiveStageId(delivery, { stage: '' }, true, skippedStageIds(delivery.stages, ['build'])), 'build')
  assert.equal(effectiveStageId(delivery, { stage: '' }, true, skippedStageIds(delivery.stages, ['spec', 'build'])), 'spec')

  // 3. Runtime: the same delivery workflow with and without a spec role.
  const { root, home } = initGitRepo(t)
  const planOf = withSpec => [
    '# Spec probe',
    '',
    '## Done when',
    '',
    '- It ships.',
    '',
    '```yaml',
    'troupe: 2',
    'goal: Probe the optional spec stage',
    'why: Gate skipping',
    'workflow: delivery',
    'base: main',
    'roles:',
    ...(withSpec ? ['  spec:', '    duty: architect', '    agent: claude', '    flags: [--permission-mode, acceptEdits]', '    touches: []'] : []),
    '  api:',
    '    duty: builder',
    '    agent: claude',
    '    flags: [--permission-mode, acceptEdits]',
    '    touches: [src/]',
    ...(withSpec ? ['    depends_on: [spec]'] : []),
    '```',
    '',
    ...(withSpec ? ['## Role: spec', '', 'Write the spec.', ''] : []),
    '## Role: api',
    '',
    'Implement it.',
    '',
  ].join('\n')
  write(join(root, 'docs/missions/with-spec/plan.md'), planOf(true))
  write(join(root, 'docs/missions/no-spec/plan.md'), planOf(false))
  const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })

  assert.equal((await execute('approve', ['-m', 'with-spec'], r)).code, 0)
  assert.match((await execute('stage', ['-m', 'with-spec', 'build'], r)).out, /cannot enter stage build: gate spec-ok is not approved yet/)
  assert.equal((await execute('stage', ['-m', 'with-spec', 'spec'], r)).code, 0)
  assert.equal((await execute('gate', ['-m', 'with-spec', 'spec-ok', 'Spec OK?', '--no-wait'], r)).code, 0)
  append(mission(r, 'with-spec').log, 'panel', { ev: 'gate-answer', gate: 'spec-ok', answer: 'approve' })
  assert.equal((await execute('stage', ['-m', 'with-spec', 'build'], r)).code, 0)

  assert.equal((await execute('approve', ['-m', 'no-spec'], r)).code, 0)
  assert.match((await execute('gate', ['-m', 'no-spec', 'spec-ok', '--no-wait'], r)).out, /gate spec-ok is skipped: the plan schedules no task role in stage spec/)
  assert.equal((await execute('stage', ['-m', 'no-spec', 'build'], r)).code, 0)

  assert.match((await execute('workflow', ['list'], r)).out, /delivery \(default\) \[built-in\] · plan -> \[plan\] -> spec\(architect,researcher\) -> \[spec-ok\?\] -> build/)
})

test('AC-5: teardown honors workflow require_merge and require_push policies on real git worktrees', async t => {
  // Case A: `investigation` (`require_merge: false`, `require_push: false`) tears down unmerged research branches without remote push.
  {
    const { root, home } = initGitRepo(t)
    const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
    assert.equal((await execute('mission', ['new', 'inv', '-w', 'investigation'], r)).code, 0)
    const worktree = join(root, '.troupe/missions/inv')
    const planPath = join(worktree, 'docs/missions/inv/plan.md')
    // Commit starter plan on mission/inv so mission worktree is clean.
    execFileSync('git', ['add', '.'], { cwd: worktree })
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'plan'], { cwd: worktree })

    // Create an unmerged role worktree `role/inv/explore` with an unmerged commit.
    const roleTree = join(root, '.troupe/worktrees/inv/explore')
    mkdirSync(dirname(roleTree), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'role/inv/explore', roleTree, 'mission/inv'], { cwd: root })
    write(join(roleTree, 'notes.txt'), 'unmerged finding\n')
    execFileSync('git', ['add', '.'], { cwd: roleTree })
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'finding'], { cwd: roleTree })

    assert.equal((await execute('approve', ['-m', 'inv'], r)).code, 0)
    // Blocked while `report-ok` gate is not approved.
    const blocked = await execute('teardown', ['-m', 'inv'], r)
    assert.equal(blocked.code, 1)
    assert.match(blocked.out, /gate report-ok: not approved yet/)

    const m = mission(r, 'inv')
    append(m.log, 'orch', { ev: 'gate-open', gate: 'report-ok', ask: 'Findings OK?' })
    append(m.log, 'panel', { ev: 'gate-answer', gate: 'report-ok', answer: 'approve' })

    // Succeeds without merging `role/inv/explore` and without pushing `mission/inv`!
    assert.ok(existsSync(planPath))
    const done = await execute('teardown', ['-m', 'inv'], r)
    assert.equal(done.code, 0, done.out)
    assert.ok(!existsSync(roleTree))
    assert.ok(!existsSync(worktree))
  }

  // Case B: `direct` (`require_merge: true`, `require_push: false`) requires merging role branches, but NOT pushing to a remote.
  {
    const { root, home } = initGitRepo(t)
    const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
    assert.equal((await execute('mission', ['new', 'dir', '-w', 'direct'], r)).code, 0)
    const worktree = join(root, '.troupe/missions/dir')
    execFileSync('git', ['add', '.'], { cwd: worktree })
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'plan'], { cwd: worktree })

    const roleTree = join(root, '.troupe/worktrees/dir/build')
    mkdirSync(dirname(roleTree), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'role/dir/build', roleTree, 'mission/dir'], { cwd: root })
    write(join(roleTree, 'src/feature.js'), 'export const ok = true\n')
    execFileSync('git', ['add', '.'], { cwd: roleTree })
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'feature'], { cwd: roleTree })

    assert.equal((await execute('approve', ['-m', 'dir'], r)).code, 0)
    const m = mission(r, 'dir')
    append(m.log, 'orch', { ev: 'gate-open', gate: 'accept-ok', ask: 'Accept?' })
    append(m.log, 'panel', { ev: 'gate-answer', gate: 'accept-ok', answer: 'approve' })

    // Refused before merging `role/dir/build` into `mission/dir`.
    const unmerged = await execute('teardown', ['-m', 'dir'], r)
    assert.equal(unmerged.code, 1)
    assert.match(unmerged.out, /role\/dir\/build: unmerged into mission\/dir/)

    // Merge into `mission/dir` (still NO git remote push!).
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'merge', '-q', 'role/dir/build'], { cwd: worktree })
    const clean = await execute('teardown', ['-m', 'dir'], r)
    assert.equal(clean.code, 0, clean.out)
    assert.ok(!existsSync(roleTree))
    assert.ok(!existsSync(worktree))
  }
})

test('hardening: linked mission worktrees inherit main .troupe definitions, symlinks stay contained, and unapproved policy/gate bypasses are refused', async t => {
  // 1. Pre-plan execution stages are rejected; omitted teardown defaults requirePush to true.
  assert.throws(
    () => readWorkflow(
      'bad-pre-plan',
      '---\nsummary: Execution before plan\nstages:\n  - id: pre\n    label: Pre\n    duties: [researcher]\n  - id: plan-ok\n    label: Plan\n    gate: plan\n  - id: build\n    label: Build\n    duties: [builder]\n---\nPlaybook.\n',
    ),
    /first gate must be `gate: plan`, with no execution stages before it/,
  )
  const defaultPolicyWf = readWorkflow(
    'safe-default',
    '---\nsummary: Safe default\nstages:\n  - id: plan-ok\n    label: Plan\n    gate: plan\n  - id: build\n    label: Build\n    duties: [builder]\n---\nPlaybook.\n',
  )
  assert.deepEqual(defaultPolicyWf.teardown, { requireMerge: true, requirePush: true })

  // 2. Repo-tier `.troupe/roles` and `.troupe/workflows` in main checkout work when cwd is `.troupe/missions/<m>`.
  const { root, home } = initGitRepo(t)
  write(
    join(root, '.troupe/roles/auditor.md'),
    '---\nsummary: Custom repo auditor\ntouches: none\nreviews: required\nstartup: immediate\n---\nAudit instructions.\n',
  )
  write(
    join(root, '.troupe/workflows/audit-flow.md'),
    [
      '---',
      'summary: Custom repo workflow',
      'stages:',
      '  - id: plan-ok',
      '    label: Plan',
      '    gate: plan',
      '  - id: build',
      '    label: Build',
      '    duties: [builder]',
      '    required: true',
      '  - id: audit',
      '    label: Audit',
      '    duties: [auditor]',
      '    required: true',
      '  - id: accept-ok',
      '    label: Accept',
      '    gate: accept-ok',
      'teardown:',
      '  require_merge: true',
      '  require_push: false',
      '---',
      'Custom workflow playbook.',
    ].join('\n'),
  )
  // Symlink escaping outside `root` is reported as a problem and not loaded.
  const outsideFile = join(home, 'outside-secret.md')
  write(outsideFile, '---\nsummary: Escaped\ntouches: optional\nreviews: forbidden\n---\nEscaped.\n')
  symlinkSync(outsideFile, join(root, '.troupe/roles/escaped.md'))
  const escapedCheck = loadDuties(root, home)
  assert.equal(escapedCheck.duties.escaped, undefined)
  assert.ok(escapedCheck.problems.some(p => p.includes('resolves outside')))
  rmSync(join(root, '.troupe/roles/escaped.md'))

  const rMain = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
  assert.equal((await execute('mission', ['new', 'custom', '-w', 'audit-flow'], rMain)).code, 0)
  const worktree = join(root, '.troupe/missions/custom')
  const planPath = join(worktree, 'docs/missions/custom/plan.md')
  write(planPath, readFileSync(planPath, 'utf8').replaceAll('<model>', 'gpt-5.4'))

  const rWorktree = runtime({ cwd: worktree, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
  assert.equal((await execute('check', [planPath], rWorktree)).code, 0)
  assert.match((await execute('workflow', ['show', 'audit-flow'], rWorktree)).out, /Custom workflow playbook\./)
  assert.match((await execute('role', ['show', 'auditor'], rWorktree)).out, /Audit instructions\./)

  // 3. Unapproved tampering of workflow teardown policy (`require_merge: false`) is refused by `teardown`.
  execFileSync('git', ['add', '.'], { cwd: worktree })
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'plan'], { cwd: worktree })
  assert.equal((await execute('approve', ['-m', 'custom'], rWorktree)).code, 0)
  const mCustom = mission(rWorktree, 'custom')
  append(mCustom.log, 'orch', { ev: 'gate-open', gate: 'accept-ok', ask: 'Accept?' })
  append(mCustom.log, 'panel', { ev: 'gate-answer', gate: 'accept-ok', answer: 'approve' })
  // Mutate repo workflow after approval to relax `require_merge: false` without re-running `troupe approve`.
  write(
    join(root, '.troupe/workflows/audit-flow.md'),
    readFileSync(join(root, '.troupe/workflows/audit-flow.md'), 'utf8').replace('require_merge: true', 'require_merge: false'),
  )
  const tamperedTeardown = await execute('teardown', ['-m', 'custom'], rWorktree)
  assert.equal(tamperedTeardown.code, 1)
  assert.match(tamperedTeardown.out, /plan or workflow changed since approval/)

  // 4. Switching workflow after entering `build` cannot dispatch `build` when intermediate gate (`design-ok`) is unapproved.
  write(
    join(root, 'docs/missions/sw/plan.md'),
    [
      '# Switch probe',
      '',
      '```yaml',
      'troupe: 2',
      'goal: Switch guard',
      'why: Gate check in dispatch',
      'workflow: direct',
      'base: main',
      'roles:',
      '  arch:',
      '    duty: builder',
      '    agent: claude',
      '    flags: [--permission-mode, acceptEdits]',
      '    touches: [docs/]',
      '  api:',
      '    duty: builder',
      '    agent: claude',
      '    flags: [--permission-mode, acceptEdits]',
      '    touches: [src/]',
      '```',
      '',
      '## Role: arch',
      '',
      'Docs.',
      '',
      '## Role: api',
      '',
      'Code.',
      '',
    ].join('\n'),
  )
  assert.equal((await execute('approve', ['-m', 'sw'], rMain)).code, 0)
  assert.equal((await execute('stage', ['-m', 'sw', 'build'], rMain)).code, 0)
  // Switch plan to `design-first` (`arch` as `architect` in `design`, `api` as `builder` in `build`) and re-approve `plan` ONLY.
  write(
    join(root, 'docs/missions/sw/plan.md'),
    readFileSync(join(root, 'docs/missions/sw/plan.md'), 'utf8')
      .replace('workflow: direct', 'workflow: design-first')
      .replace('duty: builder', 'duty: architect'),
  )
  assert.equal((await execute('approve', ['-m', 'sw'], rMain)).code, 0)
  const blockedDispatch = await execute('dispatch', ['-m', 'sw', 'api'], rMain)
  assert.equal(blockedDispatch.code, 1)
  assert.match(blockedDispatch.out, /cannot dispatch role api in stage build: gate design-ok is not approved yet/)
})


test('profiles: shared library presets, stage/profile/role skill union, brief persona, approval hash, and CLI', async t => {
  // 1. A shared profile presets only reusable fields; mission-specific fields and nesting are refused.
  assert.throws(() => readProfile('p', '---\nsummary: x\ntouches: [src/]\n---\n'), /line 3: touches is mission-specific/)
  assert.throws(() => readProfile('p', '---\nsummary: x\nuse: other\n---\n'), /a profile cannot use another/)
  assert.throws(() => readProfile('p', '---\nsummary: x\ncolor: red\n---\n'), /color is not a profile field/)
  assert.throws(() => readProfile('p', '---\nsummary: x\nskills: [has space]\n---\n'), /invalid skill name/)

  // 2. Stage skills are only valid on execution stages.
  const stageYaml = extra => `---\nsummary: s\nstages:\n  - id: plan-ok\n    gate: plan\n${extra}  - id: build\n    duties: [builder]\n    skills: [stage-skill]\n---\nPlaybook.\n`
  assert.throws(() => readWorkflow('w', stageYaml('    skills: [x]\n')), /"skills" requires nonempty "duties"/)
  const workflow = readWorkflow('skilled', stageYaml(''))
  assert.deepEqual(workflow.stages[1].skills, ['stage-skill'])

  // 3. readPlan merges stage < profile < role skills; plan-local profiles shadow the library.
  const designer = readProfile(
    'frontend-designer',
    '---\nsummary: UI designer\nduty: builder\nagent: claude\nflags: [--permission-mode, acceptEdits]\nskills: [design-skill, shared-skill]\n---\nThink in screens and states.\n',
  )
  const planOf = (profilesBlock, roleSkills) => [
    '# Probe', '', '```yaml', 'troupe: 2', 'goal: g', 'workflow: skilled', 'base: main',
    ...profilesBlock,
    'roles:', '  ui:', '    use: frontend-designer', '    touches: [web/]', ...roleSkills, '```', '',
    '## Role: ui', '', 'Build the screens.', '',
  ].join('\n')
  const catalog = { workflows: { skilled: workflow }, profiles: { 'frontend-designer': designer } }
  const shared = readPlan(planOf([], ['    skills: [shared-skill, role-skill]']), AGENTS, catalog)
  assert.deepEqual(shared.problems, [])
  assert.equal(shared.roles[0].duty, 'builder')
  assert.equal(shared.roles[0].profile, 'frontend-designer')
  assert.deepEqual(shared.roles[0].skills, ['stage-skill', 'design-skill', 'shared-skill', 'role-skill'])
  const local = readPlan(
    planOf(['profiles:', '  frontend-designer:', '    duty: builder', '    agent: claude', '    flags: [--permission-mode, acceptEdits]'], []),
    AGENTS,
    catalog,
  )
  assert.deepEqual(local.problems, [])
  assert.equal(local.roles[0].profile, '')
  assert.deepEqual(local.roles[0].skills, ['stage-skill'])

  // 4. A user-tier profile resolves through check, the CLI, the brief, and the approval hash.
  const { root, home } = initGitRepo(t)
  const profilePath = join(home, '.config/troupe/profiles/frontend-designer.md')
  write(profilePath, designer.raw)
  write(join(home, '.config/troupe/profiles/broken.md'), '---\nsummary: Broken\nduty: ghost\n---\n')
  write(
    join(root, 'docs/missions/ui/plan.md'),
    ['# UI', '', '```yaml', 'troupe: 2', 'goal: Build UI', 'base: main', 'roles:',
      '  ui:', '    use: frontend-designer', '    touches: [web/]', '```', '', '## Role: ui', '', 'Build the screens.', ''].join('\n'),
  )
  const r = runtime({ cwd: root, home, env: { LC_ALL: 'C', LANG: 'C' }, inputTTY: true, outputTTY: true, write: () => {}, ask: async () => 'y' })
  const listed = JSON.parse((await execute('profile', ['list', '--json'], r)).out)
  assert.deepEqual(listed.profiles.map(one => [one.name, one.source]), [['broken', 'user'], ['frontend-designer', 'user']])
  assert.ok(listed.problems.some(p => p.includes('profile "broken" references unknown duty "ghost"')))
  rmSync(join(home, '.config/troupe/profiles/broken.md'))
  const shown = await execute('profile', ['show', 'frontend-designer'], r)
  assert.equal(shown.code, 0)
  assert.match(shown.out, /Presets: duty=builder · agent=claude · flags=--permission-mode, acceptEdits · skills=design-skill, shared-skill/)
  assert.match(shown.out, /Think in screens and states\./)
  assert.equal((await execute('profile', ['show', 'missing'], r)).code, 1)

  const checked = await execute('check', ['ui'], r)
  assert.equal(checked.code, 0, checked.out)
  const m = mission(r, 'ui')
  const brief = briefOf(m, m.plan.roles[0], '/wt', 'role/ui/ui')
  assert.match(brief, /Skills to load: design-skill, shared-skill\./)
  assert.match(brief, /If a listed skill is not installed for you, continue without it/)
  assert.match(brief, /## Profile: frontend-designer\n\nThink in screens and states\./)
  write(profilePath, designer.raw.replace('Think in screens', 'Think in flows'))
  assert.notEqual(mission(r, 'ui').hash, m.hash)
})
