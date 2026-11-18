import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AGENTS, loadAgents } from './agents.ts'
import type { Agent } from './agents.ts'
import { MISSIONS, rootOf, textProblems } from './check.ts'
import { excludeTroupe, git, mux, NAME, Refusal, repository, roleText, Usage, within } from './command-context.ts'
import type { Mission, Repository, Runtime } from './command-context.ts'
import { loadDuties } from './duties.ts'
import type { DutyRole } from './duties.ts'
import { fold, logPath, readLog } from './log.ts'
import { callerPane } from './panes.ts'
import { DEFAULT_WORKFLOW, readPlan } from './plan.ts'
import { tmux } from './run.ts'
import { loadProfiles } from './profiles.ts'
import { planHash } from './state.ts'
import { loadWorkflows, MISSION_WORKFLOW, planTemplatePath, withMissionWorkflow } from './workflows.ts'
import type { Workflow } from './workflows.ts'

// Several missions can be open at once. Each has its own worktree on branch
// `mission/<m>` and is bound to its orchestrator's pane (`@troupe-mission`,
// with the repository's common git dir in `@troupe-mission-repo`, so a pane
// in another repository never matches). A panel pane names its orchestrator
// in `@troupe-panel-orchestrator` and follows that pane's binding; one named
// by a herdr pane, which tmux does not list, follows its own mark.

/** No mission could be resolved for the caller; the message lists the open ones. */
export class Unresolved extends Refusal {
  readonly open: { name: string; worktree: string }[]
  constructor(message: string, open: { name: string; worktree: string }[]) {
    super(message)
    this.open = open
  }
}

export const missionTree = (repo: Repository, name: string): string => join(repo.root, '.troupe/missions', name)

/** Each worktree on a `mission/<m>` branch, by mission name. */
export const missionTrees = (r: Runtime, repo: Repository): Map<string, string> => {
  const trees = new Map<string, string>()
  for (const entry of git(r, repo.root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = entry.split('\0')
    const path = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
    const name = fields.find(field => field.startsWith('branch refs/heads/mission/'))?.slice('branch refs/heads/mission/'.length)
    if (path && name && NAME.test(name)) trees.set(name, path)
  }

  return trees
}

export const finished = (repo: Repository, name: string): boolean => {
  const log = logPath(repo.common, name)

  return existsSync(log) && fold(readLog(log).events).finished
}

/** Missions with a worktree on their branch or a log, and no teardown yet. */
export const openMissions = (r: Runtime, repo: Repository): { name: string; worktree: string }[] => {
  const trees = missionTrees(r, repo)
  const dir = join(repo.common, 'troupe')
  const logged = existsSync(dir) ? readdirSync(dir).filter(name => NAME.test(name) && existsSync(logPath(repo.common, name))) : []

  return [...new Set([...trees.keys(), ...logged])].filter(name => !finished(repo, name)).sort()
    .map(name => ({ name, worktree: trees.get(name) ?? '' }))
}

export type Marked = { pane: string; mission: string; repo: string; panel: string; orchestrator: string; token: string }
const MARKS = ['#{pane_id}', '#{pane_dead}', '#{@troupe-mission}', '#{@troupe-mission-repo}', '#{@troupe-panel}', '#{@troupe-panel-orchestrator}', '#{@troupe-orchestrator-token}'].join('\t')

/** Every live pane (and dead ones too when asked) with its troupe marks. */
export const markedPanes = (r: Runtime, dead = false): Marked[] => {
  const found = tmux(['list-panes', '-a', '-F', MARKS], r.run, r.env)
  if (found.code !== 0) return []

  return found.out.split('\n').flatMap(line => {
    const [pane = '', gone, mission = '', repo = '', panel = '', orchestrator = '', token = ''] = line.split('\t')

    return /^%\d+$/.test(pane) && (dead || gone === '0') ? [{ pane, mission, repo, panel, orchestrator, token }] : []
  })
}

/** The mission `pane` is bound to in this repository: a panel's through its orchestrator first, else its own mark. */
export const boundTo = (panes: Marked[], repo: Repository, pane: string): string => {
  const own = panes.find(one => one.pane === pane)
  if (own === undefined) return ''
  const orchestrator = own.panel !== '' && own.orchestrator !== '' ? panes.find(one => one.pane === own.orchestrator) : undefined
  const via = orchestrator?.repo === repo.common ? orchestrator.mission : ''

  return via || (own.repo === repo.common ? own.mission : '')
}

/**
 * The open mission `pane`'s own marks name, in whichever repository they
 * name, with that repository's main checkout; empty when none.
 */
export const heldBy = (r: Runtime, panes: Marked[], pane: string): { name: string; root: string } => {
  const own = panes.find(one => one.pane === pane)
  if (own === undefined || own.panel !== '' || own.mission === '' || own.repo === '') return { name: '', root: '' }
  const repo = { root: basename(own.repo) === '.git' ? dirname(own.repo) : own.repo, common: own.repo }
  let open = false
  try { open = openMissions(r, repo).some(one => one.name === own.mission) } catch { /* A repository that is gone holds no open mission. */ }

  return open ? { name: own.mission, root: repo.root } : { name: '', root: '' }
}

/** The orchestrator panes bound to `name` (panels carry the mission too, but are not orchestrators). */
export const orchestratorsOf = (panes: Marked[], repo: Repository, name: string): Marked[] =>
  panes.filter(one => one.panel === '' && one.repo === repo.common && one.mission === name)

export const markMission = (r: Runtime, repo: Repository, pane: string, name: string): void => {
  mux(r, ['set-option', '-p', '-t', pane, '@troupe-mission', name])
  mux(r, ['set-option', '-p', '-t', pane, '@troupe-mission-repo', repo.common])
}

export const unbind = (r: Runtime, pane: string): void => {
  for (const option of ['@troupe-mission', '@troupe-mission-repo', '@troupe-orchestrator-token']) mux(r, ['set-option', '-p', '-u', '-t', pane, option])
}

/** The caller's pane, also when it runs outside tmux's variables; found at the current worktree's top. */
export const callerOf = (r: Runtime): string | undefined => callerPane(r, rootOf(r.cwd, r.run))

/**
 * The mission a command acts on, in order: `-m`; the caller pane's binding;
 * a panel's orchestrator's binding; the current worktree's `mission/<m>`
 * branch. `-m` naming another mission than the caller's binding refuses.
 */
export const resolveMission = (r: Runtime, repo: Repository, want: string): string => {
  const caller = callerOf(r)
  const bound = caller === undefined ? '' : boundTo(markedPanes(r), repo, caller)
  if (want !== '') {
    if (bound !== '' && bound !== want) throw new Refusal(`this pane runs mission ${bound}; -m ${want} names another`)
    return want
  }
  if (bound !== '') return bound
  const head = r.run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: r.cwd })
  const branch = head.code === 0 ? head.out.trim() : ''
  const name = branch.startsWith('mission/') ? branch.slice('mission/'.length) : ''
  if (NAME.test(name) && !finished(repo, name)) return name
  const open = openMissions(r, repo)

  throw new Unresolved(`no mission for this pane; pass -m <mission>${open.length === 0 ? ' (no open mission)'
    : `. Open missions:\n${open.map(one => `  ${one.name}  ${one.worktree || '(no worktree)'}`).join('\n')}`}`, open)
}

/** The mission's plan: in its worktree, else in the current worktree, else in the main checkout. */
export const planOf = (r: Runtime, repo: Repository, name: string): string | undefined =>
  [missionTrees(r, repo).get(name), rootOf(r.cwd, r.run), repo.root]
    .flatMap(dir => dir === undefined ? [] : [join(dir, MISSIONS, name, 'plan.md')])
    .find(path => existsSync(path) && statSync(path).isFile())

export const mission = (r: Runtime, want = ''): Mission => {
  if (want !== '' && !NAME.test(want)) throw new Usage('mission must be a folder name under docs/missions')
  const repo = repository(r)
  const name = resolveMission(r, repo, want)
  const path = planOf(r, repo, name)
  if (path === undefined) throw new Refusal(`no plan for mission ${name} (${MISSIONS}/${name}/plan.md in its worktree)`)
  const worktree = dirname(dirname(dirname(dirname(path))))
  const roots = repo.root === worktree ? [worktree] : [repo.root, worktree]
  const loadedAgents = loadAgents(worktree, r.home)
  const loadedDuties = loadDuties(roots, r.home, r.packageRoot)
  const loadedWorkflows = loadWorkflows(roots, r.home, r.packageRoot, loadedDuties.duties)
  const loadedProfiles = loadProfiles(roots, r.home, loadedDuties.duties)
  const source = readFileSync(path)
  const catalog = withMissionWorkflow(path, loadedWorkflows.workflows, loadedDuties.duties)
  const plan = readPlan(source.toString('utf8'), loadedAgents.agents, {
    duties: loadedDuties.duties,
    workflows: catalog.workflows,
    profiles: loadedProfiles.profiles,
  })
  const workflow = catalog.workflows[plan.workflow]
  const problems = [
    ...loadedAgents.problems,
    ...loadedDuties.problems,
    ...loadedWorkflows.problems,
    ...(plan.workflow === MISSION_WORKFLOW ? catalog.problems : []),
    ...loadedProfiles.problems,
    ...plan.problems,
    ...textProblems(worktree, plan),
  ]
  const texts = new Map<string, string>()
  const hashRefs: { ref: string; bytes: string | undefined }[] = [
    { ref: `workflow:${plan.workflow}`, bytes: workflow?.raw },
  ]
  for (const role of plan.roles) {
    hashRefs.push({ ref: `duty:${role.name}:${role.duty}`, bytes: loadedDuties.duties[role.duty]?.raw })
    if (role.profile !== '') {
      hashRefs.push({ ref: `profile:${role.name}:${role.profile}`, bytes: loadedProfiles.profiles[role.profile]?.raw })
    }
    if (role.text !== '') {
      try {
        const text = roleText(worktree, role.text)
        if (text.bytes === undefined) problems.push(`role ${role.name}: missing text ${role.text}`)
        else texts.set(role.name, text.bytes)
        hashRefs.push(text)
      } catch (error) {
        problems.push(`role ${role.name}: ${(error as Error).message}`)
        hashRefs.push({ ref: role.text, bytes: undefined })
      }
    }
  }
  const log = logPath(repo.common, name)
  const read = readLog(log)
  if (read.unread > 0) problems.push(`${log}: ${read.unread} unread log line(s)`)

  return {
    ...repo,
    name,
    worktree,
    path,
    source: source.toString('utf8'),
    plan,
    agents: loadedAgents.agents,
    duties: loadedDuties.duties,
    profiles: loadedProfiles.profiles,
    workflow,
    problems,
    hash: planHash(source, hashRefs),
    log,
    events: read.events,
    folded: fold(read.events),
    texts,
  }
}

/** Synthesizes workflow-valid starter roles when a non-default workflow's stages differ from `delivery`. */
const renderStarterPlan = (
  templateText: string,
  missionName: string,
  branch: string,
  workflow: Workflow,
  duties: Record<string, DutyRole>,
  agents: Record<string, Agent> = AGENTS,
): string => {
  const stamped = templateText
    .replaceAll('<mission>', () => missionName)
    .replace(/^base: *\S*/m, `base: ${branch}`)
    .replace(/^workflow: *\S*/m, `workflow: ${workflow.name}`)
  const probe = readPlan(stamped, agents, { duties, workflows: { [workflow.name]: workflow } })
  if (probe.problems.length === 0) return stamped

  const executionStages = workflow.stages.filter(stage => stage.duties.length > 0)
  const roleEntries: { name: string; stageId: string; dutyName: string; duty: DutyRole; upstream: string[] }[] = []
  const upstreamNames: string[] = []
  const usedNames = new Set<string>()
  const hasRequiredStage = executionStages.some(stage => stage.required)
  for (const stage of executionStages) {
    // Seed optional stages (such as a skippable spec stage) only when nothing else would be seeded.
    if (!stage.required && (roleEntries.length > 0 || hasRequiredStage) && stage.duties[0] !== 'reviewer') continue
    const dutyName = stage.duties[0]!
    const duty = duties[dutyName]
    if (duty === undefined) continue
    const candidate = usedNames.has(stage.id) ? `${stage.id}-${dutyName}` : stage.id
    usedNames.add(candidate)
    roleEntries.push({ name: candidate, stageId: stage.id, dutyName, duty, upstream: [...upstreamNames] })
    if (duty.reviews !== 'required') upstreamNames.push(candidate)
  }
  if (roleEntries.length === 0) return stamped

  const yamlLines = [
    '```yaml',
    'troupe: 2',
    'goal: "<the mission in one sentence: what it delivers>"',
    'why: "<one line: why now>"',
    `workflow: ${workflow.name}`,
    `base: ${branch}`,
    'roles:',
    ...roleEntries.flatMap(({ name, stageId, dutyName, duty, upstream }) => {
      const touches = duty.touches === 'required' ? `[src/${name}/]` : '[]'
      const targets = upstream.length > 0 ? upstream : [roleEntries[0]!.name]

      return [
        `  ${name}:`,
        `    duty: ${dutyName}`,
        `    stage: ${stageId}`,
        '    agent: claude',
        '    model: sonnet',
        '    effort: high',
        '    flags: [--permission-mode, acceptEdits]',
        `    goal: "<one line: what ${name} delivers>"`,
        `    touches: ${touches}`,
        ...(duty.reviews === 'required' ? [`    reviews: [${targets.join(', ')}]`] : []),
      ]
    }),
    '```',
  ].join('\n')

  const roleSections = roleEntries
    .map(({ name }) => `## Role: ${name}\n\n- **Deliver**: <what ${name} produces or verifies>`)
    .join('\n\n')

  return [
    `# ${missionName}: <title>`,
    '',
    '## Intent',
    '',
    '<Two or three sentences: what the person wants and why.>',
    '',
    '## Done when',
    '',
    '- <one line the person can check: what, not how>',
    '- <one line the person can check>',
    '',
    '## Out of scope',
    '',
    '<What this mission deliberately does not do.>',
    '',
    yamlLines,
    '',
    roleSections,
    '',
  ].join('\n')
}

/**
 * Creates the mission's worktree on a new `mission/<m>` branch, cut from the
 * main checkout's HEAD (or `base`), initialized with the chosen workflow's
 * plan template. git refuses a branch or worktree that already exists.
 */
export const newMission = (
  r: Runtime,
  repo: Repository,
  name: string,
  base: string,
  workflowName = DEFAULT_WORKFLOW,
): string => {
  if (!NAME.test(name)) throw new Refusal(`invalid mission name: ${name}`)
  const branch = `mission/${name}`
  const worktree = within(repo.root, `.troupe/missions/${name}`)
  if (existsSync(logPath(repo.common, name))) throw new Refusal(`mission ${name} already has a log: ${logPath(repo.common, name)}`)
  const loadedAgents = loadAgents(repo.root, r.home)
  const loadedDuties = loadDuties(repo.root, r.home, r.packageRoot)
  const loadedWorkflows = loadWorkflows(repo.root, r.home, r.packageRoot, loadedDuties.duties)
  const workflow = loadedWorkflows.workflows[workflowName]
  if (workflow === undefined) {
    const choices = Object.keys(loadedWorkflows.workflows).sort().join(', ') || 'none'
    throw new Refusal(`unknown workflow "${workflowName}" (choose ${choices})`)
  }
  const workflowProblem = loadedWorkflows.problems.find(problem => problem.startsWith(`${workflow.path}:`))
  if (workflowProblem !== undefined) throw new Refusal(workflowProblem)
  const template = planTemplatePath(repo.root, r.home, r.packageRoot)
  if (template === undefined) throw new Refusal('the plan template is missing')
  excludeTroupe(repo.common)
  mkdirSync(dirname(worktree), { recursive: true })
  git(r, repo.root, ['worktree', 'add', '-b', branch, worktree, ...(base ? [base] : [])])
  const plan = join(worktree, MISSIONS, name, 'plan.md')
  mkdirSync(dirname(plan), { recursive: true })
  writeFileSync(
    plan,
    renderStarterPlan(readFileSync(template, 'utf8'), name, branch, workflow, loadedDuties.duties, loadedAgents.agents),
  )

  return worktree
}

/** Removes a mission worktree that was just created, with its branch, after a failed start. */
export const dropMission = (r: Runtime, repo: Repository, name: string, worktree: string): void => {
  r.run('git', ['worktree', 'remove', '--force', worktree], { cwd: repo.root })
  r.run('git', ['branch', '-D', `mission/${name}`], { cwd: repo.root })
}

/** Open missions with their worktree, orchestrator pane and panel pane. */
export const missionList = (r: Runtime, repo: Repository) => {
  const panes = markedPanes(r)

  return openMissions(r, repo).map(one => ({
    ...one,
    orchestrator: orchestratorsOf(panes, repo, one.name)[0]?.pane ?? '',
    panel: panes.find(pane => pane.panel === repo.root && boundTo(panes, repo, pane.pane) === one.name)?.pane ?? '',
  }))
}
