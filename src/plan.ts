import { AGENTS, unsetPermission } from './agents.ts'
import type { Agent } from './agents.ts'
import { builtinDuties } from './duties.ts'
import type { DutyRole } from './duties.ts'
import type { Profile } from './profiles.ts'
import { overlaps } from './touches.ts'
import { builtinWorkflows, DEFAULT_WORKFLOW } from './workflows.ts'
import type { Workflow } from './workflows.ts'
import { parseYaml } from './yaml.ts'
import type { Yaml } from './yaml.ts'

export { overlaps } from './touches.ts'
export { DEFAULT_WORKFLOW } from './workflows.ts'

// plan.md, read and checked: Markdown around one ```yaml block that holds the
// mission's facts, its referenced `workflow`, and its task `roles`; each task
// role binds a reusable `duty` (`roles/<duty>.md`) to a mission-specific
// `## Role: <name>` section, worktree, branch, and workflow `stage`.

export type Role = {
  name: string
  /** Reusable duty role name (`roles/<duty>.md`), e.g. `builder` or `reviewer`. */
  duty: string
  /** Resolved stage ID in the mission's workflow where this task role runs. */
  stage: string
  agent: string
  model: string
  effort: string
  /** The agent's own flags, as written; they must pin its permission. */
  flags: string[]
  touches: string[]
  dependsOn: string[]
  goal: string
  /** Optional repo-relative supplemental instruction file, '' for none. */
  text: string
  /** The `## Role: <name>` section's body, '' for none. */
  section: string
  /** Shared library profile (`profiles/<name>.md`) the role uses, '' for none or a plan-local profile. */
  profile: string
  /** Stage defaults, then the profile's, then the role's own skills, deduplicated in that order. */
  skills: string[]
  reviews: string[]
  /** Stage group identifier used by the panel sidebar and STAGES counters. */
  group: string
}
export type Plan = {
  title: string
  goal: string
  why: string
  workflow: string
  base: string
  /** The `## Done when` section's bullets. */
  doneWhen: string[]
  roles: Role[]
  problems: string[]
}

export type PlanCatalog = {
  duties?: Record<string, DutyRole>
  workflows?: Record<string, Workflow>
  /** Shared profile library; a plan's own `profiles:` entry of the same name takes precedence. */
  profiles?: Record<string, Profile>
}

const NAME = /^[a-z][a-z0-9-]*$/
const ROLE_KEYS = ['use', 'duty', 'stage', 'agent', 'model', 'effort', 'flags', 'touches', 'depends_on', 'goal', 'text', 'skills', 'reviews']
const PLAN_KEYS = ['troupe', 'goal', 'why', 'workflow', 'base', 'profiles', 'roles']

type Map = { [key: string]: Yaml }
const isMap = (value: Yaml | undefined): value is Map => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: Yaml | undefined): string => (typeof value === 'string' ? value : '')
const texts = (value: Yaml | undefined): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : typeof value === 'string' ? [value] : []

/** The Markdown's `## ` sections by heading, skipping fenced code; the body runs to the next `#`/`##` heading. */
export const sectionsOf = (source: string): { heading: string; body: string }[] => {
  const out: { heading: string; body: string[] }[] = []
  let fence = ''
  for (const line of source.split('\n')) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1]
    if (mark !== undefined) fence = fence === '' ? mark : fence === mark ? '' : fence
    const heading = fence === '' && mark === undefined ? /^(#{1,2}) +(.+?)\s*$/.exec(line) : null
    if (heading !== null) {
      if (heading[1] === '##') out.push({ heading: heading[2] ?? '', body: [] })
      else out.push({ heading: '', body: [] })
    } else out.at(-1)?.body.push(line)
  }

  return out.filter(section => section.heading !== '').map(section => ({ heading: section.heading, body: section.body.join('\n').trim() }))
}

/** Top-level `-` / `*` items, each with its continuation lines joined. */
const bullets = (body: string): string[] =>
  body
    .split(/\n(?=\s*[-*] )/)
    .map(item => /^\s*[-*] +([\s\S]*)$/.exec(item)?.[1]?.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim())
    .filter((one): one is string => one !== undefined && one !== '')

const resolveRoleStage = (
  roleName: string,
  dutyName: string,
  explicitStage: string,
  duty: DutyRole | undefined,
  workflow: Workflow | undefined,
  problems: string[],
): string => {
  if (workflow === undefined || duty === undefined) return explicitStage
  if (explicitStage !== '') {
    const target = workflow.stages.find(stage => stage.id === explicitStage)
    if (target === undefined) {
      const choices = workflow.stages.filter(stage => stage.duties.length > 0).map(stage => stage.id).join(', ')
      problems.push(`role ${roleName}: unknown stage "${explicitStage}" in workflow "${workflow.name}" (${choices})`)

      return ''
    }
    if (!target.duties.includes(dutyName)) {
      problems.push(
        `role ${roleName}: duty "${dutyName}" is not allowed in stage "${explicitStage}" of workflow "${workflow.name}" (allowed: ${target.duties.join(', ') || 'none'})`,
      )

      return ''
    }

    return explicitStage
  }

  const matching = workflow.stages.filter(stage => stage.duties.includes(dutyName))
  if (matching.length === 1) return matching[0]!.id
  if (matching.length === 0) {
    problems.push(`role ${roleName}: duty "${dutyName}" is not allowed in any stage of workflow "${workflow.name}"`)

    return ''
  }
  problems.push(
    `role ${roleName}: duty "${dutyName}" appears in multiple stages of workflow "${workflow.name}" (${matching.map(stage => stage.id).join(', ')}); set stage: explicitly`,
  )

  return ''
}

export const readPlan = (
  source: string,
  agents: Record<string, Agent> = AGENTS,
  catalog: PlanCatalog = {},
): Plan => {
  const duties = catalog.duties ?? builtinDuties()
  const workflows = catalog.workflows ?? builtinWorkflows()
  const library = catalog.profiles ?? {}
  const title = /^# +(.+)$/m.exec(source)?.[1]?.trim() ?? ''
  const sections = sectionsOf(source)
  const doneWhen = bullets(sections.find(section => /^done when$/i.test(section.heading))?.body ?? '')
  const empty: Plan = { title, goal: '', why: '', workflow: DEFAULT_WORKFLOW, base: '', doneWhen, roles: [], problems: [] }

  const fence = /```ya?ml\n([\s\S]*?)```/g
  let found: RegExpExecArray | null = null
  let isOld = false
  for (let one = fence.exec(source); one !== null; one = fence.exec(source)) {
    if (/^orders:/m.test(one[1] ?? '')) isOld = true
    else if (/^roles:/m.test(one[1] ?? '')) {
      found = one
      break
    }
  }
  if (found === null) {
    const why = isOld
      ? 'an orders block: a plan of the troupe mod (before troupe 2); start a new plan from the template'
      : 'no ```yaml block with a `roles:` key'

    return { ...empty, problems: [why] }
  }
  let data: Yaml
  try {
    data = parseYaml(found[1] ?? '', source.slice(0, found.index).split('\n').length + 1)
  } catch (error) {
    return { ...empty, problems: [`the yaml block cannot be read: ${(error as Error).message}`] }
  }
  if (!isMap(data) || !isMap(data.roles)) return { ...empty, problems: ['`roles` is not a mapping of name to role'] }

  const problems: string[] = []
  for (const key of Object.keys(data)) if (!PLAN_KEYS.includes(key)) problems.push(`unknown key "${key}" (${PLAN_KEYS.join(', ')})`)
  if (data.troupe !== undefined && text(data.troupe) !== '2') {
    problems.push(`troupe: ${text(data.troupe) || '?'} is not a format this troupe reads (2)`)
  }
  if (data.workflow !== undefined && typeof data.workflow !== 'string') {
    problems.push('`workflow` must be a workflow name')
  }
  const workflowName = text(data.workflow) || DEFAULT_WORKFLOW
  const workflow = workflows[workflowName]
  if (workflow === undefined) {
    problems.push(`unknown workflow "${workflowName}" (${Object.keys(workflows).sort().join(', ') || 'none'})`)
  }

  const profiles = isMap(data.profiles) ? data.profiles : {}
  if (data.profiles !== undefined && !isMap(data.profiles)) problems.push('`profiles` is not a mapping of name to settings')
  for (const [name, value] of Object.entries(profiles)) {
    if (!isMap(value)) problems.push(`profile ${name} is not a mapping`)
    else {
      if ('use' in value) problems.push(`profile ${name}: a profile cannot use another`)
      for (const key of Object.keys(value)) if (!ROLE_KEYS.includes(key)) problems.push(`profile ${name}: unknown key "${key}"`)
    }
  }

  const roleSections = new Map(
    sections.flatMap(section => {
      const name = /^Role: *(.+)$/.exec(section.heading)?.[1]?.trim()

      return name === undefined ? [] : [[name, section.body] as const]
    }),
  )
  const dutyNames = Object.keys(duties).sort()
  const roles = Object.entries(data.roles).map(([name, raw]): Role => {
    const own = isMap(raw) ? raw : {}
    if (!isMap(raw)) problems.push(`role ${name} is not a mapping`)
    for (const key of Object.keys(own)) if (!ROLE_KEYS.includes(key)) problems.push(`role ${name}: unknown key "${key}"`)
    const use = text(own.use)
    const local = use !== '' && Object.hasOwn(profiles, use) ? profiles[use] : undefined
    const shared = use !== '' && local === undefined && Object.hasOwn(library, use) ? library[use] : undefined
    if (use !== '' && local === undefined && shared === undefined) problems.push(`role ${name}: use names no profile "${use}"`)
    const base: Map = isMap(local) ? local : shared?.settings ?? {}
    const one: Map = { ...base, ...own }
    const hasTouches = 'touches' in one
    if (!hasTouches) problems.push(`role ${name}: no touches (write touches: [] for a role that changes no files)`)

    const dutyName = text(one.duty)
    const duty = dutyName === '' ? undefined : duties[dutyName]
    if (dutyName === '') problems.push(`role ${name}: no duty (${dutyNames.join(', ')})`)
    else if (duty === undefined) problems.push(`role ${name}: unknown duty "${dutyName}" (${dutyNames.join(', ')})`)

    const touches = texts(one.touches)
    const reviews = texts(one.reviews)
    if (duty !== undefined && hasTouches) {
      if (duty.touches === 'required' && touches.length === 0) {
        problems.push(`role ${name}: duty "${dutyName}" requires nonempty touches`)
      } else if (duty.touches === 'none' && touches.length > 0) {
        problems.push(`role ${name}: duty "${dutyName}" forbids touches (write touches: [])`)
      }
    }
    if (duty !== undefined) {
      if (duty.reviews === 'required' && reviews.length === 0) {
        problems.push(`role ${name}: duty "${dutyName}" requires nonempty reviews`)
      } else if (duty.reviews === 'forbidden' && reviews.length > 0) {
        problems.push(`role ${name}: duty "${dutyName}" forbids reviews`)
      }
    }

    const explicitStage = text(one.stage)
    const resolvedStage = resolveRoleStage(name, dutyName, explicitStage, duty, workflow, problems)
    const roleTextRef = text(one.text)
    if (roleTextRef.startsWith('workflow:')) {
      problems.push(`role ${name}: text "${roleTextRef}" uses removed workflow: syntax; set duty: instead`)
    }

    return {
      name,
      duty: dutyName,
      stage: resolvedStage,
      agent: text(one.agent),
      model: text(one.model),
      effort: text(one.effort),
      flags: texts(one.flags),
      touches,
      dependsOn: texts(one.depends_on),
      goal: text(one.goal),
      text: roleTextRef,
      section: roleSections.get(name) ?? '',
      profile: shared?.name ?? '',
      skills: [
        ...new Set([
          ...(workflow?.stages.find(stage => stage.id === resolvedStage)?.skills ?? []),
          ...texts(base.skills),
          ...texts(own.skills),
        ]),
      ],
      reviews,
      group: resolvedStage || (touches.length === 0 && reviews.length > 0 ? 'review' : 'build'),
    }
  })
  const seen = new Set(roles.map(role => role.name))
  for (const name of roleSections.keys()) if (!seen.has(name)) problems.push(`## Role: ${name} names no role in the yaml block`)

  const roleProblems = checkRoles(roles, agents, Object.keys(data.roles), workflow)

  return {
    ...empty,
    goal: text(data.goal),
    why: text(data.why),
    workflow: workflowName,
    base: text(data.base),
    roles,
    problems: [...problems, ...roleProblems],
  }
}

/** The rules that keep work correct: names, agents and their pinned permission, role text, workflow stage coverage, dependencies, no overlap without an order. */
export const checkRoles = (
  roles: Role[],
  agents: Record<string, Agent>,
  keys = roles.map(role => role.name),
  workflow?: Workflow,
): string[] => {
  const problems: string[] = []
  if (roles.length === 0) problems.push('no roles')
  const byName = new Map(roles.map(role => [role.name, role]))
  const stageIndex = workflow === undefined ? undefined : new Map(workflow.stages.map((stage, index) => [stage.id, index]))

  for (const name of keys) if (!NAME.test(name)) problems.push(`role ${name}: a name is lower case letters, digits and -, starting with a letter`)
  for (const role of roles) {
    const { name } = role
    const agent = agents[role.agent]
    if (role.agent === '') problems.push(`role ${name}: no agent`)
    else if (agent === undefined) problems.push(`role ${name}: unknown agent "${role.agent}" (${Object.keys(agents).join(', ')})`)
    else {
      const unset = unsetPermission(agent, role.flags)
      if (unset.length > 0) problems.push(`role ${name}: flags must pin ${role.agent}'s permission (${unset.join('; ')})`)
    }
    if (role.text === '' && role.section === '') problems.push(`role ${name}: no text (a ## Role: ${name} section, or text:)`)
    for (const dep of role.dependsOn) {
      const target = byName.get(dep)
      if (target === undefined) problems.push(`role ${name}: depends_on unknown role "${dep}"`)
      else if (stageIndex !== undefined && role.stage !== '' && target.stage !== '') {
        const ownIdx = stageIndex.get(role.stage) ?? -1
        const depIdx = stageIndex.get(target.stage) ?? -1
        if (ownIdx >= 0 && depIdx > ownIdx) {
          problems.push(`role ${name} (stage "${role.stage}") cannot depend_on later-stage role "${dep}" (stage "${target.stage}")`)
        }
      }
    }
    for (const one of role.reviews) if (!byName.has(one)) problems.push(`role ${name}: reviews unknown role "${one}"`)
  }

  if (workflow !== undefined && roles.length > 0) {
    for (const stage of workflow.stages) {
      if (stage.required && !roles.some(role => role.stage === stage.id)) {
        problems.push(`workflow "${workflow.name}" requires at least one role in stage "${stage.id}" (${stage.duties.join(', ')})`)
      }
    }
  }

  const deps = depsOf(roles)
  for (const name of byName.keys()) if (deps(name).has(name)) problems.push(`role ${name}: dependency cycle`)
  for (const { a, b, shared } of clashesOf(roles)) problems.push(`${a} and ${b} overlap (${shared.join('; ')}) but neither depends on the other`)

  return problems
}

type Node = Pick<Role, 'name' | 'touches' | 'dependsOn'>

/** Every role a role waits on, directly or through others. */
const depsOf = (roles: Node[]) => {
  const byName = new Map(roles.map(role => [role.name, role]))

  return (name: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [...(byName.get(name)?.dependsOn ?? [])]
    for (let dep = stack.pop(); dep !== undefined; dep = stack.pop()) {
      if (seen.has(dep) || !byName.has(dep)) continue
      seen.add(dep)
      stack.push(...(byName.get(dep)?.dependsOn ?? []))
    }

    return seen
  }
}

/** Pairs of roles whose touches can name the same file while neither depends on the other; `shared` holds each `x ~ y`. */
export const clashesOf = (roles: Node[]): { a: string; b: string; shared: string[] }[] => {
  const deps = depsOf(roles)

  return roles.flatMap((a, index) => roles.slice(index + 1).flatMap(b => {
    const shared = a.touches.flatMap(x => b.touches.filter(y => overlaps(x, y)).map(y => `${x} ~ ${y}`))

    return shared.length > 0 && !deps(a.name).has(b.name) && !deps(b.name).has(a.name) ? [{ a: a.name, b: b.name, shared }] : []
  }))
}

/**
 * Roles depth-first, as the FLOW and the ROLES list draw them: each root in plan order, then the roles
 * that wait on it, each right after the last of its prerequisites to be placed (its `parent`, where its
 * edge comes from) and one level deeper. Roles in a cycle come last, at the top level, with no parent.
 */
export const treeOf = <R extends { name: string; dependsOn: string[] }>(roles: R[]): { role: R; depth: number; parent?: R }[] => {
  const known = new Set(roles.map(role => role.name))
  const deps = (role: R) => role.dependsOn.filter(dep => known.has(dep))
  const placed = new Set<string>()
  const out: { role: R; depth: number; parent?: R }[] = []
  const visit = (role: R, depth: number, parent?: R) => {
    placed.add(role.name)
    out.push({ role, depth, ...(parent && { parent }) })
    for (const next of roles) if (!placed.has(next.name) && deps(next).includes(role.name) && deps(next).every(dep => placed.has(dep))) visit(next, depth + 1, role)
  }
  for (const role of roles) if (!placed.has(role.name) && deps(role).length === 0) visit(role, 0)
  for (const role of roles) if (!placed.has(role.name)) visit(role, 0)

  return out
}
