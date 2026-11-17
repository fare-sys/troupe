import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, emitKeypressEvents } from 'node:readline'
import type { Interface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { parseArgs } from 'node:util'

import { recordTurn } from './activity.ts'
import type { ClaudeTurn } from './activity.ts'

type Json = Record<string, unknown>
const object = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const visible = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const REQUEST_TIMEOUT = 30_000
const MAX_FRAME = 16 * 1024 * 1024
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** One persistent JSONL connection; only the terminal owns its requests and child process. */
class RpcConnection {
  readonly child: ChildProcessWithoutNullStreams
  readonly closed: Promise<number>
  private readonly pending = new Map<string, Pending>()
  private nextId = 0
  private stopping: Promise<void> | undefined

  constructor(command: string, yolo: boolean, env: NodeJS.ProcessEnv, onEvent: (event: Json) => void, onError: (error: Error) => void) {
    this.child = spawn(command, ['rpc', ...(yolo ? ['--yolo'] : [])], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    this.closed = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.rejectPending(new Error(`JishuBuddy RPC exited (${signal ?? code ?? 'unknown'})`))
        resolve(code ?? 1)
      })
    })
    this.child.once('error', onError)
    this.child.stdin.on('error', onError)
    this.child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffer += decoder.write(chunk)
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          if (newline > MAX_FRAME) throw new Error('JishuBuddy RPC frame exceeds 16 MiB')
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line === '') continue
          const event: unknown = JSON.parse(line)
          if (!object(event) || typeof event.type !== 'string') throw new Error('Invalid JishuBuddy RPC event')
          const request = typeof event.id === 'string' && event.type === 'response' ? this.pending.get(event.id) : undefined
          if (request !== undefined) {
            this.pending.delete(String(event.id))
            clearTimeout(request.timer)
            if (event.success === true) request.resolve(event.data)
            else request.reject(new Error(text(event.error) || `JishuBuddy rejected ${text(event.command)}`))
          } else onEvent(event)
        }
        if (buffer.length > MAX_FRAME) throw new Error('JishuBuddy RPC frame exceeds 16 MiB')
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(message: Json): void {
    if (this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error('JishuBuddy RPC is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(type: string, fields: Json = {}): Promise<unknown> {
    const id = `troupe-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JishuBuddy RPC timed out: ${type}`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ ...fields, type, id })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.rejectPending(new Error('JishuBuddy terminal is closing'))
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve()
    this.child.kill('SIGTERM')
    const force = setTimeout(() => this.child.kill('SIGKILL'), 3000)
    this.stopping = this.closed.then(() => { clearTimeout(force) })

    return this.stopping
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

type Dialog = { request: Json; timer?: NodeJS.Timeout }

/** Run a human-controlled terminal over JishuBuddy's persistent RPC interface. */
export const runJishuBuddy = async (args: string[]): Promise<number> => {
  let rpc: RpcConnection | undefined
  let reader: Interface | undefined
  let dialog: Dialog | undefined
  let busy = true
  let revision = 0
  let streamed = false
  let finished = false
  let pasting = false
  let pasted: string[] = []
  let exitCode = 0
  let finish: () => void = () => {}
  const lifetime = new Promise<void>(resolve => { finish = resolve })
  const write = (value: string): void => { process.stdout.write(visible(value)) }
  const fail = (error: unknown): void => {
    if (finished) return
    exitCode = 1
    finished = true
    process.stderr.write(`troupe JishuBuddy: ${error instanceof Error ? error.message : String(error)}\n`)
    if (rpc !== undefined) guard(rpc.stop())
    finish()
  }
  const guard = (promise: Promise<unknown>): void => { void promise.catch(fail) }
  const close = (): void => {
    if (finished) return
    finished = true
    if (rpc !== undefined) guard(rpc.stop())
    finish()
  }
  const stop = (): void => close()
  const interrupt = (): void => {
    try {
      pasting = false
      pasted = []
      if (dialog !== undefined) { answer('/cancel'); return }
      if (busy && rpc !== undefined) guard(rpc.request('abort'))
      else close()
    } catch (error) { fail(error) }
  }
  const keypress = (_value: string, key: { name?: string }): void => {
    if (key.name === 'paste-start') pasting = true
    if (key.name === 'paste-end') pasting = false
  }
  let activity = ''
  let session = ''
  const report = (turn: ClaudeTurn, event: string): void => {
    revision += 1
    busy = turn !== 'ready'
    recordTurn(activity, turn, session, event)
  }
  const prompt = (): void => {
    if (!finished && !busy && dialog === undefined) {
      if (reader?.terminal) reader.prompt()
      else write('jishubuddy> \n')
    }
  }
  const cancelDialog = (): void => {
    if (dialog?.timer !== undefined) clearTimeout(dialog.timer)
    dialog = undefined
  }
  const answer = (line: string): void => {
    if (rpc === undefined || dialog === undefined) return
    const request = dialog.request
    const response: Json = { type: 'extension_ui_response', id: request.id }
    if (line === '/cancel') response.cancelled = true
    else if (request.method === 'select') {
      const options = request.options
      const index = Number(line)
      if (!Array.isArray(options) || !Number.isInteger(index) || index < 1 || index > options.length) {
        write('Enter an option number, or /cancel.\n')
        return
      }
      response.value = options[index - 1]
    } else if (request.method === 'confirm') {
      if (!/^(y|yes|n|no)?$/i.test(line)) { write('Enter yes or no, or /cancel.\n'); return }
      response.confirmed = /^y(?:es)?$/i.test(line)
    } else response.value = line
    cancelDialog()
    report('busy', 'extension_ui_response')
    rpc.send(response)
  }
  const ui = (event: Json): void => {
    const method = text(event.method)
    if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'setWorkingMessage'].includes(method)) {
      if (method === 'notify') write(`\n${text(event.message)}\n`)
      return
    }
    if (typeof event.id !== 'string') throw new Error('JishuBuddy dialog has no request id')
    if (!['select', 'confirm', 'input', 'editor'].includes(method)) {
      write(`\nUnsupported JishuBuddy dialog '${method}'; cancelled.\n`)
      rpc?.send({ type: 'extension_ui_response', id: event.id, cancelled: true })
      return
    }
    if (dialog !== undefined) throw new Error('JishuBuddy opened overlapping dialogs; no answer was submitted')
    if (method === 'select' && (!Array.isArray(event.options) || event.options.length === 0 || !event.options.every(one => typeof one === 'string'))) {
      throw new Error('JishuBuddy selection has no valid options')
    }
    dialog = { request: event }
    report('waits', 'extension_ui_request')
    write(`\nJishuBuddy needs your answer: ${text(event.title)}\n`)
    if (typeof event.message === 'string') write(`${event.message}\n`)
    if (Array.isArray(event.options)) event.options.forEach((option, index) => write(`${index + 1}. ${String(option)}\n`))
    if (method === 'confirm') write('yes / no (default: no)\n')
    if (method === 'editor' && typeof event.prefill === 'string') write(`${event.prefill}\n`)
    write('Reply on one line, or /cancel.\n')
    if (typeof event.timeout === 'number' && event.timeout > 0) {
      dialog.timer = setTimeout(() => {
        try {
          write('JishuBuddy dialog timed out; cancelled.\n')
          answer('/cancel')
        } catch (error) { fail(error) }
      }, event.timeout)
    }
  }
  const settled = async (): Promise<void> => {
    const observed = revision
    const state = await rpc?.request('get_state')
    if (finished || observed !== revision || dialog !== undefined) return
    if (!object(state) || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) return
    report('ready', 'agent_settled')
    write('\n')
    prompt()
  }
  const onEvent = (event: Json): void => {
    if (finished) return
    if (event.type === 'extension_ui_request') { ui(event); return }
    if (event.type === 'agent_start' || event.type === 'auto_retry_start' || event.type === 'auto_compaction_start') {
      if (event.type === 'agent_start') streamed = false
      report('busy', text(event.type))
      write(`\nJishuBuddy is working${event.type === 'auto_retry_start' ? ` (retry ${String(event.attempt)})` : ''}.\n`)
    } else if (event.type === 'agent_settled') guard(settled())
    else if (event.type === 'message_start') streamed = false
    else if (event.type === 'message_update' && object(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta' && typeof update.delta === 'string') { write(update.delta); streamed = true }
      if (update.type === 'error') write(`\nJishuBuddy model error: ${text(update.error) || text(update.reason)}\n`)
    } else if (event.type === 'message_end' && object(event.message)) {
      if (!streamed && Array.isArray(event.message.content)) {
        for (const block of event.message.content) if (object(block) && block.type === 'text') write(text(block.text))
      }
      if (event.message.stopReason === 'error') write(`\nJishuBuddy model error: ${text(event.message.errorMessage)}\n`)
      write('\n')
    } else if (event.type === 'tool_execution_start') write(`\n[tool: ${text(event.toolName)}]\n`)
    else if (event.type === 'tool_execution_end' && event.isError === true) write(`\n[tool failed: ${text(event.toolName)}]\n`)
    else if (event.type === 'extension_error') write(`\nJishuBuddy extension error: ${text(event.error)}\n`)
    else if (event.type === 'auto_retry_end' && event.success === false) write(`\nJishuBuddy retries failed: ${text(event.finalError)}\n`)
  }

  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      command: { type: 'string' }, activity: { type: 'string' }, 'bridge-session': { type: 'string' },
      model: { type: 'string' }, 'thinking-level': { type: 'string' }, approval: { type: 'string' }, yolo: { type: 'boolean' },
    } })
    if (!values.command || !values.activity || !values['bridge-session']) throw new Error('JishuBuddy bridge requires command, activity and bridge-session')
    if (positionals.length > 1) throw new Error('JishuBuddy bridge accepts at most one initial prompt')
    if ((values.approval !== 'ask' && !values.yolo) || (values.approval !== undefined && values.approval !== 'ask') || (values.yolo && values.approval !== undefined)) {
      throw new Error('Choose --approval ask or explicitly request --yolo, not both')
    }
    if (values['thinking-level'] !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(values['thinking-level'])) {
      throw new Error('JishuBuddy thinking level must be off, minimal, low, medium, high, xhigh or max')
    }
    activity = values.activity
    session = values['bridge-session']
    report('busy', 'starting')
    rpc = new RpcConnection(values.command, !!values.yolo, {
      ...process.env, TROUPE_AGENT_HARNESS: 'jishubuddy', TROUPE_AGENT_SESSION: session,
      TROUPE_AGENT_PID: String(process.pid), TROUPE_ACTIVITY_FILE: activity,
    }, onEvent, fail)
    guard(rpc.closed.then(code => { if (!finished) { exitCode = code || 1; fail(new Error(`JishuBuddy RPC exited unexpectedly (${code})`)) } }))
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
    process.on('SIGINT', interrupt)
    if (values.model) {
      const available = await rpc.request('get_available_models')
      if (!object(available) || !Array.isArray(available.models)) throw new Error('JishuBuddy returned no model catalog')
      const models = available.models.filter((model): model is Json => object(model) && typeof model.provider === 'string' && typeof model.id === 'string')
      const qualified = models.find(model => `${String(model.provider)}/${String(model.id)}` === values.model)
      const matches = qualified === undefined ? models.filter(model => model.id === values.model) : [qualified]
      if (matches.length !== 1) throw new Error(`JishuBuddy model '${values.model}' is unavailable or ambiguous; use provider/model-id from its model catalog`)
      await rpc.request('set_model', { provider: matches[0]?.provider, modelId: matches[0]?.id })
    }
    if (values['thinking-level']) await rpc.request('set_thinking_level', { level: values['thinking-level'] })
    const state = await rpc.request('get_state')
    if (!object(state) || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) throw new Error('JishuBuddy did not start in an idle state')
    if (finished) return exitCode
    const connection = rpc
    const submit = async (message: string): Promise<void> => {
      report('busy', 'prompt')
      await rpc?.request('prompt', { message })
    }
    const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY
    if (terminal) {
      emitKeypressEvents(process.stdin)
      process.stdin.on('keypress', keypress)
      process.stdout.write('\x1b[?2004h')
    }
    reader = createInterface({ input: process.stdin, output: process.stdout, terminal, prompt: 'jishubuddy> ' })
    reader.on('line', input => {
      try {
        if (finished) return
        if (pasting) { pasted.push(input); return }
        const line = pasted.length === 0 ? input : [...pasted, input].join('\n')
        pasted = []
        if (line === '/exit') { close(); return }
        if (dialog !== undefined) { answer(line); return }
        if (line === '/abort') { guard(connection.request('abort')); return }
        if (line === '/help') { write('/abort interrupts the current turn; /cancel cancels a dialog; /exit closes this session.\n'); prompt(); return }
        if (line.trim() === '') { prompt(); return }
        if (busy) { write('JishuBuddy is working; use /abort or wait for its prompt.\n'); return }
        guard(submit(line))
      } catch (error) { fail(error) }
    })
    reader.on('SIGINT', interrupt)
    reader.on('close', close)
    write('JishuBuddy RPC terminal. /help for commands. Approval prompts remain interactive.\n')
    if (positionals[0]) await submit(positionals[0])
    else { report('ready', 'session_start'); prompt() }
    await lifetime
  } catch (error) {
    fail(error)
  } finally {
    if (dialog?.timer !== undefined) clearTimeout(dialog.timer)
    reader?.close()
    process.off('SIGTERM', stop)
    process.off('SIGHUP', stop)
    process.off('SIGINT', interrupt)
    process.stdin.off('keypress', keypress)
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write('\x1b[?2004l')
    await rpc?.stop()
  }

  return exitCode
}
