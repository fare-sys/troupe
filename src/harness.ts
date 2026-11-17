import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACTIVITY_FILE, COPILOT_EVENTS } from './activity.ts'
import type { Agent } from './agents.ts'
import type { Runtime } from './command-context.ts'
import { shellOf } from './run.ts'

export type Launch = { argv: string[]; session: string; activity?: string }

/** Add lifecycle instrumentation without changing the person's shared CLI configuration. */
export const launchAgent = (r: Runtime, agent: Agent, argv: string[], worktree: string): Launch => {
  const session = randomUUID()
  if (agent.usage !== 'copilot' && agent.usage !== 'jishubuddy') return { argv, session }
  const activity = join(worktree, ACTIVITY_FILE)
  mkdirSync(join(worktree, '.troupe'), { recursive: true })
  if (agent.usage === 'jishubuddy') return {
    argv: [process.execPath, join(r.packageRoot, 'dist/cli.js'), 'jishubuddy', '--command', agent.command,
      '--activity', activity, '--bridge-session', session, ...argv.slice(1)],
    session, activity,
  }
  const plugin = join(worktree, '.troupe/copilot-plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(plugin, 'hooks'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'troupe-activity', version: '1.0.0', description: 'Report troupe session lifecycle events' })}\n`)
  const hooks = Object.fromEntries(COPILOT_EVENTS.map(event => [event, [{
    type: 'command',
    bash: shellOf([process.execPath, join(r.packageRoot, 'dist/cli.js'), 'copilot-activity', activity, event]),
  }]]))
  writeFileSync(join(plugin, 'hooks/hooks.json'), `${JSON.stringify({ version: 1, hooks })}\n`)

  return { argv: [argv[0] ?? agent.command, '--plugin-dir', plugin, '--session-id', session, ...argv.slice(1)], session, activity }
}
