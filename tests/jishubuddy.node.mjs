import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/jishubuddy-rpc.mjs', import.meta.url))

const terminal = (t, options = [], initial, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'troupe-jishubuddy-'))
  const activity = join(dir, 'activity.json')
  const trace = join(dir, 'trace.jsonl')
  const command = join(dir, 'rpc')
  copyFileSync(fixture, command)
  chmodSync(command, 0o755)
  const child = spawn(process.execPath, [cli, 'jishubuddy', '--command', command, '--activity', activity,
    '--bridge-session', 'bridge-session', '--approval', 'ask', ...options, ...(initial === undefined ? [] : [initial])], {
    env: { ...process.env, ...env, TROUPE_TEST_TRACE: trace }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let error = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error += chunk })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output, error })))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
    rmSync(dir, { recursive: true, force: true })
  })
  const waitFor = (pattern, from = 0) => {
    if (pattern.test(output.slice(from))) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${pattern}: ${output}\n${error}`)) }, 10000)
      const cleanup = () => { clearTimeout(timer); child.stdout.off('data', check); child.off('close', exited) }
      const check = () => { if (pattern.test(output.slice(from))) { cleanup(); resolve() } }
      const exited = () => { cleanup(); reject(new Error(`Terminal exited before ${pattern}: ${output}\n${error}`)) }
      child.stdout.on('data', check)
      child.once('close', exited)
    })
  }
  const commands = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  return { child, closed, waitFor, activity: () => JSON.parse(readFileSync(activity, 'utf8')), commands, output: () => output,
    send: line => child.stdin.write(`${line}\n`) }
}

test('RPC terminal preserves one session, configures models and forwards explicit approval answers', { timeout: 20000 }, async t => {
  const w = terminal(t, ['--model', 'fixture/small', '--thinking-level', 'high'], 'first prompt')
  await w.waitFor(/Reply on one line/)
  assert.equal(w.activity().turn, 'waits')
  assert.equal(w.activity().session, 'bridge-session')
  assert.equal(w.commands().filter(command => command.type === 'extension_ui_response').length, 0)
  w.send('not an option')
  await w.waitFor(/Enter an option number/)
  assert.equal(w.activity().turn, 'waits')
  w.send('1')
  await w.waitFor(/jishubuddy> /)
  assert.equal(w.activity().turn, 'ready')
  assert.ok(w.output().includes('Completed first prompt\u2028without losing the frame.'))
  assert.ok(!w.output().includes('duplicate final text'))
  const first = w.commands()
  assert.deepEqual(first.find(command => command.type === 'set_model').provider, 'fixture')
  assert.deepEqual(first.find(command => command.type === 'set_model').modelId, 'small')
  assert.equal(first.find(command => command.type === 'set_thinking_level').level, 'high')
  assert.equal(first.find(command => command.type === 'extension_ui_response').value, 'Allow once')
  const offset = w.output().length
  w.send('second prompt')
  await w.waitFor(/Reply on one line/, offset)
  w.send('/cancel')
  await w.waitFor(/Operation denied/, offset)
  await w.waitFor(/jishubuddy> /, offset)
  assert.equal(w.commands().filter(command => command.type === 'prompt').length, 2)
  assert.equal(w.commands().filter(command => command.type === 'extension_ui_response').at(-1).cancelled, true)
  w.send('/exit')
  assert.equal((await w.closed).code, 0)
  const pid = w.commands().find(command => command.type === 'fixture-start').pid
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('agent_end is not idle: follow-up text cannot answer a retry and /abort restores readiness', { timeout: 20000 }, async t => {
  const w = terminal(t, [], 'hang')
  await w.waitFor(/JishuBuddy is working/)
  assert.equal(w.activity().turn, 'busy')
  w.send('must not become another prompt')
  await w.waitFor(/use \/abort or wait/)
  assert.equal(w.commands().filter(command => command.type === 'prompt').length, 1)
  w.send('/abort')
  await w.waitFor(/jishubuddy> /)
  assert.equal(w.activity().turn, 'ready')
  w.send('/exit')
  assert.equal((await w.closed).code, 0)
})

test('confirmation defaults to denial rather than silently approving an empty answer', { timeout: 20000 }, async t => {
  const w = terminal(t, [], 'confirm')
  await w.waitFor(/default: no/)
  w.send('')
  await w.waitFor(/Operation denied/)
  assert.equal(w.commands().find(command => command.type === 'extension_ui_response').confirmed, false)
  w.send('/exit')
  assert.equal((await w.closed).code, 0)
})

test('termination cancels an outstanding startup request and reaps its child promptly', { timeout: 10000 }, async t => {
  const w = terminal(t, [], undefined, { TROUPE_TEST_STALL_STARTUP: '1' })
  for (let attempt = 0; attempt < 200 && !w.commands().some(command => command.type === 'get_state'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(w.commands().some(command => command.type === 'get_state'))
  const pid = w.commands().find(command => command.type === 'fixture-start').pid
  w.child.kill('SIGTERM')
  let timer
  const result = await Promise.race([
    w.closed,
    new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 1500) }),
  ])
  clearTimeout(timer)
  if (result === undefined) {
    process.kill(pid, 'SIGTERM')
    await w.closed
  }
  assert.ok(result, 'termination waited for the 30-second RPC timeout instead of cancelling startup')
  assert.equal(result.code, 0, result.error)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('configuration and protocol failures exit visibly without reporting ready', { timeout: 20000 }, async t => {
  for (const [options, initial, message] of [
    [['--model', 'missing'], undefined, /unavailable or ambiguous/],
    [['--model', 'rejected'], undefined, /model unavailable/],
    [[], 'malformed', /JSON/],
    [[], 'exit-early', /exited/],
  ]) {
    const w = terminal(t, options, initial)
    const result = await w.closed
    assert.equal(result.code, 1, result.error)
    assert.match(result.error, message)
    assert.notEqual(w.activity().turn, 'ready')
  }
})
