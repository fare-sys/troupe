#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)
if (process.env.TROUPE_TEST_TRACE) appendFileSync(process.env.TROUPE_TEST_TRACE, `${JSON.stringify({ type: 'fixture-start', pid: process.pid })}\n`)
let streaming = false
let prompt = ''
const response = (command, data) => emit({ type: 'response', id: command.id, command: command.type, success: true, data })
const settled = () => {
  streaming = false
  emit({ type: 'agent_settled' })
}
const finish = () => {
  emit({ type: 'agent_end', willRetry: true, messages: [] })
  emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2 })
  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `Completed ${prompt}\u2028without losing the frame.` } })
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'duplicate final text' }], stopReason: 'stop' } })
  emit({ type: 'agent_end', willRetry: false, messages: [] })
  settled()
}
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const command = JSON.parse(line)
  if (process.env.TROUPE_TEST_TRACE) appendFileSync(process.env.TROUPE_TEST_TRACE, `${JSON.stringify(command)}\n`)
  if (command.type === 'get_state' && process.env.TROUPE_TEST_STALL_STARTUP === '1') return
  if (command.type === 'get_state') response(command, { sessionId: 'native-session', isStreaming: streaming, isCompacting: false, pendingMessageCount: 0 })
  else if (command.type === 'get_available_models') response(command, { models: [{ provider: 'fixture', id: 'small' }, { provider: 'fixture', id: 'rejected' }] })
  else if (command.type === 'set_model' && command.modelId === 'rejected') emit({ type: 'response', id: command.id, command: command.type, success: false, error: 'model unavailable' })
  else if (command.type === 'set_model' || command.type === 'set_thinking_level') response(command, {})
  else if (command.type === 'prompt') {
    response(command, {})
    prompt = command.message
    streaming = true
    emit({ type: 'agent_start' })
    if (prompt === 'malformed') { process.stdout.write('not-json\n'); return }
    if (prompt === 'exit-early') { process.exitCode = 7; reader.close(); process.stdin.destroy(); return }
    if (prompt === 'hang') { emit({ type: 'agent_end', willRetry: true, messages: [] }); return }
    if (prompt === 'confirm') emit({ type: 'extension_ui_request', id: 'confirmation', method: 'confirm', title: 'Confirm test operation?' })
    else emit({ type: 'extension_ui_request', id: 'permission', method: 'select', title: 'Run the test tool?', options: ['Allow once', 'Deny'] })
  } else if (command.type === 'extension_ui_response') {
    if (command.cancelled || command.value === 'Deny' || command.confirmed === false) {
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Operation denied.' }], stopReason: 'stop' } })
      settled()
    } else finish()
  } else if (command.type === 'abort') {
    settled()
    response(command, {})
  } else emit({ type: 'response', id: command.id, command: command.type, success: false, error: 'unsupported fixture command' })
})
