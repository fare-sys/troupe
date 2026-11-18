import { join } from 'node:path'

import { ENTITY_NAME, readSkillList, repoRootList, scanDefinitionsDir } from './definitions.ts'
import type { DefinitionMeta, DefinitionSource } from './definitions.ts'
import type { DutyRole } from './duties.ts'
import { parseFrontMatter, parseYaml, yamlLineOf } from './yaml.ts'
import type { Yaml } from './yaml.ts'

// Shared task-role profiles (`profiles/<name>.md`): a reusable persona that
// presets a task role's duty, agent, model, effort, flags and skills, plus an
// optional persona body injected into the role's brief. Plans reference one
// with `use: <name>`; mission-specific fields stay on the task role.

/** Task-role fields a shared profile may preset. */
export const PROFILE_SETTING_KEYS = ['duty', 'agent', 'model', 'effort', 'flags', 'skills'] as const
export type ProfileSettingKey = (typeof PROFILE_SETTING_KEYS)[number]

const PROFILE_KEYS: readonly string[] = ['name', 'summary', ...PROFILE_SETTING_KEYS]
/** Task-role fields that describe one mission's assignment, so only plan.md may set them. */
const MISSION_ONLY_KEYS: readonly string[] = ['touches', 'goal', 'reviews', 'depends_on', 'stage', 'text']
const SCALAR_KEYS: readonly ProfileSettingKey[] = ['duty', 'agent', 'model', 'effort']

export type Profile = {
  name: string
  summary: string
  /** The preset task-role fields, keyed as in plan.md, merged under the task role's own fields. */
  settings: Partial<Record<ProfileSettingKey, Yaml>>
  skills: string[]
  /** Persona instructions for the brief, '' for none. */
  body: string
  raw: string
  path: string
  source: DefinitionSource
}

type YamlMap = { [key: string]: Yaml }
const isMap = (value: Yaml | undefined): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parses and validates a single shared profile Markdown file with YAML front matter. */
export const readProfile = (
  name: string,
  raw: string,
  meta: DefinitionMeta = { path: `${name}.md`, source: 'repo' },
): Profile => {
  if (!ENTITY_NAME.test(name)) {
    throw new Error('line 1: profile name must be lower case letters, digits and -, starting with a letter')
  }
  const split = parseFrontMatter(raw)
  if (split === undefined) {
    throw new Error('line 1: profile file must start with YAML front matter (`---`)')
  }
  const fail = (field: string, why: string): never => {
    throw new Error(`line ${yamlLineOf(split.yaml, field, 2)}: ${field || 'profile'} ${why}`)
  }

  const data = parseYaml(split.yaml, 2)
  if (!isMap(data)) return fail('', 'front matter must be a mapping')
  for (const key of Object.keys(data)) {
    if (key === 'use') fail(key, 'is not allowed: a profile cannot use another')
    if (MISSION_ONLY_KEYS.includes(key)) fail(key, 'is mission-specific: set it on the task role in plan.md')
    if (!PROFILE_KEYS.includes(key)) fail(key, 'is not a profile field')
  }
  if (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim() !== name)) {
    return fail('name', `must match file name "${name}"`)
  }
  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    return fail('summary', 'must be a nonempty string')
  }

  const settings: Partial<Record<ProfileSettingKey, Yaml>> = {}
  for (const key of SCALAR_KEYS) {
    const value = data[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') fail(key, 'must be a nonempty string')
    settings[key] = (value as string).trim()
  }
  if (settings.duty !== undefined && !ENTITY_NAME.test(settings.duty as string)) {
    fail('duty', 'must be lower case letters, digits and -, starting with a letter')
  }
  if (data.flags !== undefined) {
    if (!Array.isArray(data.flags) || !data.flags.every(flag => typeof flag === 'string')) {
      fail('flags', 'must be a list of strings')
    }
    settings.flags = data.flags
  }
  const skills = readSkillList(data.skills, why => fail('skills', why))
  if (skills.length > 0) settings.skills = skills

  return {
    name,
    summary: data.summary.trim(),
    settings,
    skills,
    body: split.body,
    raw,
    path: meta.path,
    source: meta.source,
  }
}

/**
 * Loads shared profiles in override order: user (`~/.config/troupe/profiles`) < repo (`<root>/.troupe/profiles`).
 * Accepts either one repository root or `[mainRoot, worktreeRoot]`. Verifies each preset `duty` against `duties` when supplied.
 */
export const loadProfiles = (
  root: string | readonly string[],
  home: string,
  duties?: Record<string, DutyRole>,
): { profiles: Record<string, Profile>; problems: string[] } => {
  const profiles = Object.create(null) as Record<string, Profile>
  const problems: string[] = []
  if (home !== '') scanDefinitionsDir(join(home, '.config/troupe/profiles'), 'user', readProfile, profiles, problems)
  for (const repoRoot of repoRootList(root)) {
    scanDefinitionsDir(join(repoRoot, '.troupe/profiles'), 'repo', readProfile, profiles, problems)
  }
  if (duties !== undefined) {
    for (const profile of Object.values(profiles)) {
      const duty = profile.settings.duty
      if (typeof duty === 'string' && duties[duty] === undefined) {
        problems.push(`${profile.path}: profile "${profile.name}" references unknown duty "${duty}"`)
      }
    }
  }

  return { profiles, problems }
}
