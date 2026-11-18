import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAgents } from './agents.ts'
import { loadDuties } from './duties.ts'
import { readPlan } from './plan.ts'
import type { Plan } from './plan.ts'
import { run } from './run.ts'
import type { Run } from './run.ts'
import { loadWorkflows } from './workflows.ts'

// `troupe check [plan]`: finds the plan and prints its problems, or that it
// is clean. Exit 0 clean, 1 with problems, 2 when there is no plan.

export const MISSIONS = 'docs/missions'
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** The repository's top folder, else `cwd` itself. */
export const rootOf = (cwd: string, runner: Run = run): string => {
  const found = runner('git', ['rev-parse', '--show-toplevel'], { cwd })

  return found.code === 0 ? found.out.trim() : cwd
}

/** Canonical main checkout root plus the active worktree root when `cwd` sits inside a linked git worktree. */
export const repoRootsOf = (cwd: string, runner: Run = run): string[] => {
  const top = rootOf(cwd, runner)
  const common = runner('git', ['rev-parse', '--git-common-dir'], { cwd: top })
  if (common.code !== 0) return [top]
  const resolved = resolve(top, common.out.trim())
  const main = basename(resolved) === '.git' ? dirname(resolved) : top

  return main === top ? [top] : [main, top]
}

const isInsideRoot = (root: string, ref: string): boolean => {
  const path = resolve(root, ref)
  const inside = (base: string, dest: string) => {
    const rel = relative(base, dest)

    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  }
  let parent = path
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent)

  return inside(root, path) && inside(realpathSync(root), realpathSync(parent))
}

export const textProblems = (root: string, plan: Plan): string[] => plan.roles
  .flatMap(role => {
    if (role.text === '' || role.text.startsWith('workflow:')) return []
    if (!isInsideRoot(root, role.text)) return [`role ${role.name}: path is outside ${root}: ${role.text}`]
    if (!existsSync(join(root, role.text))) return [`role ${role.name}: text ${role.text} is not in the repository`]

    return []
  })

/** The plan `want` names: a plan file, a folder holding plan.md, or a mission under docs/missions/. */
export const findPlan = (root: string, cwd: string, want: string): { path: string } | { missing: string } => {
  const given = resolve(cwd, want)
  const candidates = want === '' ? [] : [given, join(given, 'plan.md'), join(root, MISSIONS, want, 'plan.md')]
  const path = candidates.find(one => existsSync(one) && statSync(one).isFile())

  return path === undefined ? { missing: `no plan at ${want} (a plan file, a folder holding plan.md, or a mission under ${MISSIONS}/)` } : { path }
}

/** Checks the plan `want` names; its agents, duties, workflows, and role texts are read from the worktree holding it. */
export const check = (
  cwd: string,
  want: string,
  home = homedir(),
  runner: Run = run,
  packageRoot = PACKAGE_ROOT,
): { out: string; code: number } => {
  const found = findPlan(rootOf(cwd, runner), cwd, want)
  if ('missing' in found) return { out: `troupe check: ${found.missing}\n`, code: 2 }
  const root = rootOf(dirname(found.path), runner)
  const roots = repoRootsOf(dirname(found.path), runner)
  const loadedAgents = loadAgents(root, home)
  const loadedDuties = loadDuties(roots, home, packageRoot)
  const loadedWorkflows = loadWorkflows(roots, home, packageRoot, loadedDuties.duties)
  const plan = readPlan(readFileSync(found.path, 'utf8'), loadedAgents.agents, {
    duties: loadedDuties.duties,
    workflows: loadedWorkflows.workflows,
  })
  const problems = [
    ...loadedAgents.problems,
    ...loadedDuties.problems,
    ...loadedWorkflows.problems,
    ...plan.problems,
    ...textProblems(root, plan),
  ]
  const name = relative(cwd, found.path) || found.path
  if (problems.length === 0) {
    const count = plan.roles.length

    return {
      out: `${name}: clean (workflow ${plan.workflow}; ${count} role${count === 1 ? '' : 's'}: ${plan.roles.map(role => `${role.name}[${role.duty}@${role.stage}]`).join(', ')})\n`,
      code: 0,
    }
  }

  return { out: `${name}: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map(one => `  - ${one}\n`).join('')}`, code: 1 }
}
