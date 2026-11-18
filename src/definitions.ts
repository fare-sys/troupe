import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import type { Yaml } from './yaml.ts'

// Shared plumbing for the layered Markdown definitions troupe reads: duty
// roles (`roles/`), workflows (`workflows/`) and task-role profiles
// (`profiles/`). Each is one `<name>.md` file with YAML front matter.

export const ENTITY_NAME = /^[a-z][a-z0-9-]*$/
const SKILL_NAME = /^\S+$/

export type DefinitionSource = 'built-in' | 'user' | 'repo'
export type DefinitionMeta = { path: string; source: DefinitionSource }

/** Normalizes one repository root or `[mainRoot, worktreeRoot]` into a deduplicated list, dropping empties. */
export const repoRootList = (root: string | readonly string[]): string[] =>
  typeof root === 'string' ? (root === '' ? [] : [root]) : [...new Set(root.filter(Boolean))]

const isContainedPath = (dirReal: string, filePath: string): boolean => {
  const rel = relative(dirReal, realpathSync(filePath))

  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

/**
 * Reads every `<name>.md` in `dir` through `read` into `into`, later layers overriding earlier ones.
 * A missing directory is silently skipped; unreadable files, invalid definitions, and symlinks that
 * resolve outside `dir` are reported in `problems` as `<path>: line N: <why>` and skipped.
 */
export const scanDefinitionsDir = <T>(
  dir: string,
  source: DefinitionSource,
  read: (name: string, raw: string, meta: DefinitionMeta) => T,
  into: Record<string, T>,
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
      into[name] = read(name, readFileSync(path, 'utf8'), { path, source })
    } catch (error) {
      const message = (error as Error).message
      problems.push(`${path}: ${/^line \d+:/.test(message) ? message : `line 1: ${message}`}`)
    }
  }
}

/** Reads an optional front-matter list of skill names (no whitespace), deduplicated in order. */
export const readSkillList = (value: Yaml | undefined, fail: (why: string) => never): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    return fail('must be a list of skill names')
  }
  const names = value.map(item => item.trim())
  const bad = names.find(item => !SKILL_NAME.test(item))
  if (bad !== undefined) fail(`invalid skill name "${bad}"`)

  return [...new Set(names)]
}
