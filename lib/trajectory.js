import { createHash } from 'node:crypto'
import { zeroTestSummary, testFailureSummary, diagnosticFailureSummary, errorOutputSummary } from './check-evidence.js'
import { isVerification } from './verification-command.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const shell = new Set(['pwsh', 'bash', 'shell'])
const inspect = new Set(['read', 'read_image', 'glob', 'grep', 'job_list', 'job_output'])
export function argumentsOf(event) {
  const value = event.data?.arguments
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? {} } catch { return {} }
}
export const textOf = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')

export function exitCodeOf(event) {
  if (Number.isFinite(event.data?.meta?.exitCode)) return event.data.meta.exitCode
  const text = textOf(event.data?.message ?? event.data)
  const code = /\[(?:exit code:|status:\s*[^\],]+,\s*exit code:)\s*(-?\d+)\]/i.exec(text)?.[1]
  return code === undefined ? null : Number(code)
}

export const resultOrigin = (name, isError = false) => !name ? 'unmatched-result' : isError ? 'tool-error'
  : shell.has(name) || ['job_output', 'checked_change', 'submit_work'].includes(name) ? 'execution' : 'source-text'

export function evidenceMarkers(text, { diagnostics = true, execution = true } = {}) {
  if (!execution) return []
  return [...new Set([
    /\bALL PASS\b/.test(text) && 'all-pass',
    zeroTestSummary(text) && 'zero-test-summary',
    testFailureSummary(text) && 'test-failure-summary',
    diagnostics && diagnosticFailureSummary(text) && 'diagnostic-failure-summary',
    /AssertionError/.test(text) && 'assertion-error',
    /SyntaxError|ParserError/.test(text) && 'syntax-error',
    /Cannot find module|MODULE_NOT_FOUND/.test(text) && 'missing-module',
    /parameter.*(?:not found|cannot be found)|A parameter cannot be found/i.test(text) && 'shell-parameter-error',
    /unknown job/i.test(text) && 'unknown-job',
    /old_string[^\n]*not found/i.test(text) && 'edit-match-error',
    errorOutputSummary(text) && 'error-output',
  ].filter(Boolean))]
}

function components(name, args, products) {
  const parts = new Set()
  const file = String(args.file_path ?? args.path ?? '').replaceAll('\\', '/')
  if (inspect.has(name)) parts.add('inspect')
  else if (['write', 'edit'].includes(name)) {
    parts.add(products.some(p => {
      const product = String(p).replaceAll('\\', '/')
      return file === product || file.endsWith('/' + product)
    }) ? 'implement' : 'auxiliary-file')
  } else if (name === 'checked_change') {
    for (const entry of args.files ?? []) for (const part of components('write', entry, products)) parts.add(part)
    if (args.checks?.length) for (const command of args.checks) for (const part of components('pwsh', { command }, products)) parts.add(part)
    if (args.finish) parts.add('delivery')
  } else if (name === 'submit_work') parts.add('delivery')
  else if (name === 'job_kill') parts.add('cleanup')
  else if (shell.has(name)) {
    const command = String(args.command ?? args.cmd ?? '')
    // These are deliberately conservative text heuristics, not a shell parser.
    if (isVerification(command)) parts.add('verify')
    if (/Remove-Item|\brm\b|\bdel\b/i.test(command)) parts.add('cleanup')
    if (/Get-Content|Get-ChildItem|\bcat\b|\bls\b|\bdir\b|\brg\b/.test(command)) parts.add('inspect')
    if (/Set-Content|Add-Content|Out-File|writeFile|appendFile|\bsed\b|\btee\b|(^|\s)>{1,2}(?!&)/i.test(command)) parts.add('possible-shell-write')
    if (!parts.size) parts.add('unknown-shell')
  } else parts.add('other')
  return [...parts].sort()
}

/** Request-level accounting, never a causal estimate of incremental tool cost.
 * Publish hashes/markers only: raw requests, credentials, source and stdout stay local.
 */
export function attributeTrajectory(events, { products = [], selfTest = '' } = {}) {
  const requests = [], open = []
  let current, knownTokens = 0, missingUsageCalls = 0, firstPublicPass = null
  const notePass = (call, output, isError, exitCode, eventIndex) => {
    // Native session results often retain stdout but omit exitCode; report that
    // as an observed PASS marker, not an independently certified zero exit.
    if (!firstPublicPass && selfTest && call.command?.includes(selfTest) && !isError && (exitCode === 0 || exitCode === null)
      && /(?:^|\n)ALL PASS(?:\s|$)/.test(output) && !testFailureSummary(output) && !diagnosticFailureSummary(output) && !errorOutputSummary(output)) {
      firstPublicPass = { request: current?.index ?? null, step: current?.step ?? null, eventIndex, knownTokens }
    }
  }
  for (const [eventIndex, event] of events.entries()) {
    const data = event?.data ?? {}
    if (event.type === 'assistant/message' && data.message?.source?.kind === 'model') {
      const usage = data.usage ?? data.message?.usage
      const valid = value => Number.isFinite(value) && value >= 0
      const rawTokens = valid(usage?.totalTokens) ? usage.totalTokens : valid(usage?.inputTokens) && valid(usage?.outputTokens)
        ? usage.inputTokens + (valid(usage.cacheReadTokens) ? usage.cacheReadTokens : 0) + usage.outputTokens : null
      if (rawTokens === null) missingUsageCalls++
      else knownTokens += rawTokens
      current = { index: requests.length + 1, turn: data.turn, step: data.step, rawTokens,
        inputTokens: valid(usage?.inputTokens) ? usage.inputTokens : null,
        cacheReadTokens: valid(usage?.cacheReadTokens) ? usage.cacheReadTokens : null,
        outputTokens: valid(usage?.outputTokens) ? usage.outputTokens : null,
        afterPublicPass: firstPublicPass !== null, calls: [], nativeOperations: [] }
      requests.push(current)
    } else if (event.type === 'tool/call' && current) {
      const args = argumentsOf(event), command = args.command ?? args.cmd ?? null
      const call = { name: data.name, components: components(data.name, args, products),
        commandSha256: typeof command === 'string' ? sha(command) : null,
        isError: null, exitCode: null, markers: [], outputSha256: null }
      current.calls.push(call)
      open.push({ call, request: current, id: data.callId, turn: data.turn, step: data.step, command })
    } else if (event.type === 'tool/result') {
      const message = data.message ?? {}, id = message.source?.callId ?? message.toolCallId
      const index = open.findIndex(c => c.id === id && c.turn === data.turn && c.step === data.step)
      if (index < 0) continue // Never credit a result from a different step or an unmatched call.
      const matched = open.splice(index, 1)[0], output = textOf(message)
      const origin = resultOrigin(matched.call.name, message.isError), execution = origin !== 'source-text'
      const exitCode = execution ? exitCodeOf(event) : null
      Object.assign(matched.call, { isError: message.isError === true, exitCode, markers: evidenceMarkers(output,
        { execution, diagnostics: shell.has(matched.call.name) || matched.call.name === 'job_output' }), origin, outputSha256: sha(output) })
      if (shell.has(matched.call.name)) notePass(matched, output, message.isError, exitCode, eventIndex)
    } else if (event.type === 'flow/operation' && current) {
      const output = String(data.output ?? '')
      current.nativeOperations.push({ name: data.name, components: components(data.name, { file_path: data.file, command: data.command }, products),
        isError: data.isError === true, exitCode: data.exitCode ?? null, markers: evidenceMarkers(output), outputSha256: sha(output) })
      if (shell.has(data.name)) notePass(data, output, data.isError, data.exitCode, eventIndex)
    }
  }
  const phases = {}
  for (const request of requests) {
    request.components = [...new Set(request.calls.flatMap(c => c.components))].sort()
    request.phase = request.components.length === 0 ? 'delivery' : request.components.length === 1 ? request.components[0] : 'mixed'
    request.observedToolErrors = request.calls.filter(c => c.isError).length
    const phase = phases[request.phase] ??= { requests: 0, knownTokens: 0, missingUsageCalls: 0 }
    phase.requests++
    if (request.rawTokens === null) phase.missingUsageCalls++
    else phase.knownTokens += request.rawTokens
  }
  const after = requests.filter(r => r.afterPublicPass)
  return { knownTokens, totalTokens: missingUsageCalls ? null : knownTokens, missingUsageCalls, modelCalls: requests.length,
    firstPublicPass, afterPublicPassKnownTokens: firstPublicPass ? after.reduce((s, r) => s + (r.rawTokens ?? 0), 0) : null,
    afterPublicPassRequests: firstPublicPass ? after.length : null,
    afterPublicPassProductWriteRequests: after.filter(r => r.components.includes('implement')).map(r => r.index),
    possibleShellWriteRequests: requests.filter(r => r.components.includes('possible-shell-write')).map(r => r.index),
    phases, requests }
}
