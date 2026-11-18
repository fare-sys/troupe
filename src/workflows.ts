import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { builtinDuties, ENTITY_NAME } from './duties.ts'
import type { DefinitionSource, DutyRole } from './duties.ts'
import { PLAN_GATE } from './log.ts'
import type { Folded } from './log.ts'
import { parseFrontMatter, parseYaml, yamlLineOf } from './yaml.ts'
import type { Yaml } from './yaml.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const DEFAULT_WORKFLOW = 'delivery'

export type WorkflowStage = {
  id: string
  label: string
  gate?: string
  /** Guidance sent to the orchestrator when this gate is approved. */
  next?: string
  /** Duty role names allowed to execute during this stage. */
  duties: string[]
  /** Whether a plan using this workflow must schedule at least one task role in this stage. */
  required: boolean
}

export type WorkflowTeardown = {
  requireMerge: boolean
  requirePush: boolean
}

/**
 * A standalone workflow definition (`workflows/<name>.md`), specifying stage progression,
 * human gates, allowed duty roles per stage, teardown rules, and orchestrator playbook.
 */
export type Workflow = {
  name: string
  summary: string
  stages: WorkflowStage[]
  teardown: WorkflowTeardown
  body: string
  raw: string
  path: string
  source: DefinitionSource
}

type YamlMap = { [key: string]: Yaml }
const isMap = (value: Yaml | undefined): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const WORKFLOW_KEYS = ['name', 'summary', 'stages', 'teardown'] as const
const STAGE_KEYS = ['id', 'label', 'gate', 'next', 'duties', 'required'] as const
const TEARDOWN_KEYS = ['require_merge', 'require_push'] as const

const readBool = (value: Yaml | undefined, fallback: boolean, fail: (why: string) => never): boolean => {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false

  return fail('must be true or false')
}

const readDutyList = (value: Yaml | undefined, fail: (why: string) => never): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    return fail('must be a list of duty names')
  }
  for (const name of value) {
    if (!ENTITY_NAME.test(name)) fail(`invalid duty name "${name}"`)
  }

  return [...new Set(value)]
}

/** Parses and validates a single workflow Markdown file with YAML front matter. */
export const readWorkflow = (
  name: string,
  raw: string,
  meta: { path: string; source: DefinitionSource } = { path: `${name}.md`, source: 'repo' },
): Workflow => {
  if (!ENTITY_NAME.test(name)) {
    throw new Error('line 1: workflow name must be lower case letters, digits and -, starting with a letter')
  }
  const split = parseFrontMatter(raw)
  if (split === undefined) {
    throw new Error('line 1: workflow file must start with YAML front matter (`---`)')
  }
  const fail = (field: string, why: string): never => {
    throw new Error(`line ${yamlLineOf(split.yaml, field, 2)}: ${field || 'workflow'} ${why}`)
  }

  const data = parseYaml(split.yaml, 2)
  if (!isMap(data)) return fail('', 'front matter must be a mapping')
  for (const key of Object.keys(data)) {
    if (!(WORKFLOW_KEYS as readonly string[]).includes(key)) fail(key, 'is not a workflow field')
  }
  if (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim() !== name)) {
    return fail('name', `must match file name "${name}"`)
  }
  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    return fail('summary', 'must be a nonempty string')
  }
  if (!Array.isArray(data.stages) || data.stages.length === 0) {
    return fail('stages', 'must be a nonempty list of stages')
  }

  const seenIds = new Set<string>()
  const seenGates = new Set<string>()
  const stages: WorkflowStage[] = data.stages.map((entry, index): WorkflowStage => {
    if (!isMap(entry)) return fail('stages', `stage ${index + 1} must be a mapping`)
    for (const key of Object.keys(entry)) {
      if (!(STAGE_KEYS as readonly string[]).includes(key)) fail('stages', `stage ${index + 1}: unknown field "${key}"`)
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || !ENTITY_NAME.test(id)) {
      return fail('stages', `stage ${index + 1}: id must be lower case letters, digits and -, starting with a letter`)
    }
    if (seenIds.has(id)) return fail('stages', `duplicate stage id: ${id}`)
    seenIds.add(id)

    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : id
    const gate = entry.gate === undefined ? undefined : typeof entry.gate === 'string' ? entry.gate.trim() : ''
    if (gate !== undefined) {
      if (gate === '' || !ENTITY_NAME.test(gate)) {
        return fail('stages', `stage ${id}: gate must be lower case letters, digits and -, starting with a letter`)
      }
      if (seenGates.has(gate)) return fail('stages', `duplicate gate id: ${gate}`)
      seenGates.add(gate)
    }

    const next = entry.next === undefined ? undefined : typeof entry.next === 'string' ? entry.next.trim() : ''
    if (next !== undefined) {
      if (gate === undefined) return fail('stages', `stage ${id}: "next" is only valid on a gate stage`)
      if (next === '') return fail('stages', `stage ${id}: "next" must be a nonempty string`)
    }

    const duties = readDutyList(entry.duties, why => fail('stages', `stage ${id}: duties ${why}`))
    if (gate !== undefined && duties.length > 0) {
      return fail('stages', `stage ${id}: a gate stage cannot also declare duties`)
    }
    const required = readBool(entry.required, false, why => fail('stages', `stage ${id}: required ${why}`))
    if (required && duties.length === 0) {
      return fail('stages', `stage ${id}: "required: true" requires nonempty "duties"`)
    }

    return {
      id,
      label,
      duties,
      required,
      ...(gate !== undefined ? { gate } : {}),
      ...(next !== undefined ? { next } : {}),
    }
  })

  const planGateIndex = stages.findIndex(stage => stage.gate === PLAN_GATE)
  if (
    planGateIndex < 0 ||
    stages.slice(0, planGateIndex).some(stage => stage.gate !== undefined || stage.duties.length > 0)
  ) {
    return fail('stages', 'the first gate must be `gate: plan`, with no execution stages before it: dispatch waits for it')
  }
  if (!stages.some(stage => stage.duties.length > 0)) {
    return fail('stages', 'must include at least one execution stage with `duties`')
  }

  let teardown: WorkflowTeardown = { requireMerge: true, requirePush: true }
  if (data.teardown !== undefined) {
    if (!isMap(data.teardown)) return fail('teardown', 'must be a mapping')
    for (const key of Object.keys(data.teardown)) {
      if (!(TEARDOWN_KEYS as readonly string[]).includes(key)) fail(`teardown.${key}`, 'is not a teardown field')
    }
    teardown = {
      requireMerge: readBool(data.teardown.require_merge, true, why => fail('teardown.require_merge', why)),
      requirePush: readBool(data.teardown.require_push, true, why => fail('teardown.require_push', why)),
    }
  }

  if (split.body === '') {
    throw new Error('line 1: workflow orchestration body must not be empty')
  }

  return {
    name,
    summary: data.summary.trim(),
    stages,
    teardown,
    body: split.body,
    raw,
    path: meta.path,
    source: meta.source,
  }
}

const isContainedPath = (dirReal: string, filePath: string): boolean => {
  const rel = relative(dirReal, realpathSync(filePath))

  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

const scanWorkflowsDir = (
  dir: string,
  source: DefinitionSource,
  into: Record<string, Workflow>,
  problems: string[],
): void => {
  let files: string[]
  try {
    files = readdirSync(dir).filter(file => file.endsWith('.md')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`${dir}: line 1: ${(error as Error).message}`)
    }
    return
  }
  const bound = realpathSync(dir)
  for (const file of files) {
    const path = join(dir, file)
    try {
      if (!isContainedPath(bound, path)) {
        problems.push(`${path}: line 1: path resolves outside ${dir}`)
        continue
      }
      const name = file.slice(0, -3)
      into[name] = readWorkflow(name, readFileSync(path, 'utf8'), { path, source })
    } catch (error) {
      const message = (error as Error).message
      problems.push(`${path}: ${/^line \d+:/.test(message) ? message : `line 1: ${message}`}`)
    }
  }
}

let cachedBuiltins: { workflows: Record<string, Workflow>; problems: string[] } | undefined

/** Built-in workflows shipped in the package's `workflows/` directory. */
export const builtinWorkflows = (): Record<string, Workflow> => {
  if (cachedBuiltins === undefined) {
    const workflows = Object.create(null) as Record<string, Workflow>
    const problems: string[] = []
    scanWorkflowsDir(join(PACKAGE_ROOT, 'workflows'), 'built-in', workflows, problems)
    cachedBuiltins = { workflows, problems }
  }

  return Object.assign(Object.create(null) as Record<string, Workflow>, cachedBuiltins.workflows)
}

/**
 * Loads workflows across three layers in override order:
 * built-in (`<packageRoot>/workflows`) < user (`~/.config/troupe/workflows`) < repo (`<root>/.troupe/workflows`).
 * Accepts either one repository root or `[mainRoot, worktreeRoot]` so untracked `.troupe/workflows` in the main checkout remain visible from linked worktrees.
 * Also verifies every stage's declared `duties` against `duties` when supplied.
 */
export const loadWorkflows = (
  root: string | readonly string[],
  home: string,
  packageRoot = PACKAGE_ROOT,
  duties: Record<string, DutyRole> = builtinDuties(),
): { workflows: Record<string, Workflow>; problems: string[] } => {
  const workflows = Object.create(null) as Record<string, Workflow>
  const problems: string[] = []
  const builtinBase = existsSync(join(packageRoot, 'workflows')) ? packageRoot : PACKAGE_ROOT
  scanWorkflowsDir(join(builtinBase, 'workflows'), 'built-in', workflows, problems)
  if (home !== '') scanWorkflowsDir(join(home, '.config/troupe/workflows'), 'user', workflows, problems)
  const roots = typeof root === 'string' ? (root === '' ? [] : [root]) : [...new Set(root.filter(Boolean))]
  for (const repoRoot of roots) {
    scanWorkflowsDir(join(repoRoot, '.troupe/workflows'), 'repo', workflows, problems)
  }

  for (const workflow of Object.values(workflows)) {
    for (const stage of workflow.stages) {
      for (const duty of stage.duties) {
        if (duties[duty] === undefined) {
          problems.push(`${workflow.path}: workflow "${workflow.name}" stage "${stage.id}" references unknown duty "${duty}"`)
        }
      }
    }
  }

  return { workflows, problems }
}

/** Resolves the plan template path across repo `.troupe/templates`, user `~/.config/troupe/templates`, and package `templates`. */
export const planTemplatePath = (
  root: string | readonly string[],
  home: string,
  packageRoot = PACKAGE_ROOT,
): string | undefined => {
  const roots = typeof root === 'string' ? (root === '' ? [] : [root]) : [...new Set(root.filter(Boolean))].reverse()
  const candidates = [
    ...roots.map(repoRoot => join(repoRoot, '.troupe/templates/plan.md')),
    ...(home !== '' ? [join(home, '.config/troupe/templates/plan.md')] : []),
    join(packageRoot, 'templates/plan.md'),
    join(PACKAGE_ROOT, 'templates/plan.md'),
  ]

  return candidates.find(candidate => existsSync(candidate))
}

/** Post-approval guidance for a gate from the active workflow's stage metadata, without hardcoded gate IDs. */
export const afterGateApproval = (workflow: Workflow | undefined, gate: string, mission: string): string => {
  const active = workflow ?? builtinWorkflows().delivery
  const next = active?.stages.find(stage => stage.gate === gate)?.next

  return next === undefined ? 'Continue the mission.' : next.replaceAll('{mission}', () => mission)
}

/** Gate IDs strictly preceding `stageId` in `workflow` that have not been approved yet. */
export const unapprovedGatesBefore = (
  workflow: Workflow,
  stageId: string,
  gates: ReadonlyMap<string, { answer?: string }>,
  planApproved: boolean,
): string[] => {
  const index = workflow.stages.findIndex(stage => stage.id === stageId)
  if (index <= 0) return []

  return workflow.stages
    .slice(0, index)
    .flatMap(stage => {
      if (stage.gate === undefined) return []
      const ok = stage.gate === PLAN_GATE ? planApproved : gates.get(stage.gate)?.answer === 'approve'

      return ok ? [] : [stage.gate]
    })
}

/**
 * Resolves the mission's effective active stage in `workflow`, matching `modelOf`:
 * once the plan gate is approved and before an explicit post-plan `troupe stage <id>`,
 * the mission stands on the stage immediately following the plan gate.
 */
export const effectiveStageId = (workflow: Workflow, folded: Pick<Folded, 'stage'>, planApproved: boolean): string => {
  const planIndex = workflow.stages.findIndex(stage => stage.gate === PLAN_GATE)
  const namedIndex = workflow.stages.findIndex(stage => stage.id === folded.stage)
  if (!planApproved) {
    const index = Math.max(0, Math.min(planIndex < 0 ? 0 : planIndex, namedIndex < 0 ? 0 : namedIndex))

    return workflow.stages[index]?.id ?? ''
  }
  const index = namedIndex < 0 ? planIndex + 1 : Math.max(namedIndex, planIndex + 1)

  return workflow.stages[index]?.id ?? folded.stage
}
