import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontMatter, parseYaml, yamlLineOf } from './yaml.ts'
import type { Yaml } from './yaml.ts'

export const ENTITY_NAME = /^[a-z][a-z0-9-]*$/
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

export type DutyTouchesRule = 'required' | 'none' | 'optional'
export type DutyStartupMode = 'immediate' | 'standby'
export type DutyReviewsRule = 'required' | 'forbidden' | 'optional'
export type DefinitionSource = 'built-in' | 'user' | 'repo'

/**
 * A reusable duty role definition (`roles/<name>.md`), decoupled from any specific
 * workflow or mission task role. Defines behavioral constraints and base instructions.
 */
export type DutyRole = {
  name: string
  summary: string
  touches: DutyTouchesRule
  startup: DutyStartupMode
  reviews: DutyReviewsRule
  body: string
  raw: string
  path: string
  source: DefinitionSource
}

type YamlMap = { [key: string]: Yaml }
const isMap = (value: Yaml | undefined): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const DUTY_KEYS = ['name', 'summary', 'touches', 'startup', 'reviews'] as const
const TOUCHES_RULES: readonly DutyTouchesRule[] = ['required', 'none', 'optional']
const STARTUP_MODES: readonly DutyStartupMode[] = ['immediate', 'standby']
const REVIEWS_RULES: readonly DutyReviewsRule[] = ['required', 'forbidden', 'optional']

/** Parses and validates a single duty role Markdown file with YAML front matter. */
export const readDuty = (
  name: string,
  raw: string,
  meta: { path: string; source: DefinitionSource } = { path: `${name}.md`, source: 'repo' },
): DutyRole => {
  if (!ENTITY_NAME.test(name)) {
    throw new Error('line 1: duty name must be lower case letters, digits and -, starting with a letter')
  }
  const split = parseFrontMatter(raw)
  if (split === undefined) {
    throw new Error('line 1: duty file must start with YAML front matter (`---`)')
  }
  const fail = (field: string, why: string): never => {
    throw new Error(`line ${yamlLineOf(split.yaml, field, 2)}: ${field || 'duty'} ${why}`)
  }

  const data = parseYaml(split.yaml, 2)
  if (!isMap(data)) return fail('', 'front matter must be a mapping')
  for (const key of Object.keys(data)) {
    if (!(DUTY_KEYS as readonly string[]).includes(key)) fail(key, 'is not a duty field')
  }
  if (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim() !== name)) {
    return fail('name', `must match file name "${name}"`)
  }
  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    return fail('summary', 'must be a nonempty string')
  }
  const touches = (data.touches ?? 'optional') as string
  if (!(TOUCHES_RULES as readonly string[]).includes(touches)) {
    return fail('touches', `must be one of ${TOUCHES_RULES.join(', ')}`)
  }
  const startup = (data.startup ?? 'immediate') as string
  if (!(STARTUP_MODES as readonly string[]).includes(startup)) {
    return fail('startup', `must be one of ${STARTUP_MODES.join(', ')}`)
  }
  const reviews = (data.reviews ?? 'optional') as string
  if (!(REVIEWS_RULES as readonly string[]).includes(reviews)) {
    return fail('reviews', `must be one of ${REVIEWS_RULES.join(', ')}`)
  }
  if (split.body === '') {
    throw new Error('line 1: duty instructions body must not be empty')
  }

  return {
    name,
    summary: data.summary.trim(),
    touches: touches as DutyTouchesRule,
    startup: startup as DutyStartupMode,
    reviews: reviews as DutyReviewsRule,
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

const scanDutiesDir = (
  dir: string,
  source: DefinitionSource,
  into: Record<string, DutyRole>,
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
      into[name] = readDuty(name, readFileSync(path, 'utf8'), { path, source })
    } catch (error) {
      const message = (error as Error).message
      problems.push(`${path}: ${/^line \d+:/.test(message) ? message : `line 1: ${message}`}`)
    }
  }
}

let cachedBuiltins: { duties: Record<string, DutyRole>; problems: string[] } | undefined

/** Built-in duty roles shipped in the package's `roles/` directory. */
export const builtinDuties = (): Record<string, DutyRole> => {
  if (cachedBuiltins === undefined) {
    const duties = Object.create(null) as Record<string, DutyRole>
    const problems: string[] = []
    scanDutiesDir(join(PACKAGE_ROOT, 'roles'), 'built-in', duties, problems)
    cachedBuiltins = { duties, problems }
  }

  return Object.assign(Object.create(null) as Record<string, DutyRole>, cachedBuiltins.duties)
}

/**
 * Loads duty roles across three layers in override order:
 * built-in (`<packageRoot>/roles`) < user (`~/.config/troupe/roles`) < repo (`<root>/.troupe/roles`).
 * Accepts either one repository root or `[mainRoot, worktreeRoot]` so untracked `.troupe/roles` in the main checkout remain visible from linked worktrees.
 */
export const loadDuties = (
  root: string | readonly string[],
  home: string,
  packageRoot = PACKAGE_ROOT,
): { duties: Record<string, DutyRole>; problems: string[] } => {
  const duties = Object.create(null) as Record<string, DutyRole>
  const problems: string[] = []
  const builtinBase = existsSync(join(packageRoot, 'roles')) ? packageRoot : PACKAGE_ROOT
  scanDutiesDir(join(builtinBase, 'roles'), 'built-in', duties, problems)
  if (home !== '') scanDutiesDir(join(home, '.config/troupe/roles'), 'user', duties, problems)
  const roots = typeof root === 'string' ? (root === '' ? [] : [root]) : [...new Set(root.filter(Boolean))]
  for (const repoRoot of roots) {
    scanDutiesDir(join(repoRoot, '.troupe/roles'), 'repo', duties, problems)
  }

  return { duties, problems }
}
