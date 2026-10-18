/**
 * Telemetry extraction: turn a child Session's event stream into the four
 * dimensions the bench reports — completion time, efficiency, token usage and
 * completion status.
 *
 * Record shapes were verified against `session.v4.jsonl.zstd` on disk:
 *   turn/start    { turn }
 *   turn/end      { turn, reason: { kind } }
 *   step/start    { turn, step }
 *   step/end      { turn, step }
 *   tool/call     { turn, step, callId, name, arguments }
 *   tool/result   { turn, step, message: { source: { callId }, isError } }
 *   assistant/message { turn, step, message: { source: { provider, model } }, usage: { … } }
 *
 * `usage` is a sibling of `message` under `data`, not a member of the message.
 *
 * Every field is read defensively: a shape drift must degrade a metric, never
 * abort a run or silently report a zero that reads as a good result.
 * @module @sonwe1e/dsh-flow-next/telemetry
 */

/** Terminal kinds the loop reports for a finished turn. */
const TERMINAL_KINDS = new Set(['completed', 'max-tokens', 'aborted', 'blocked'])

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Short stable digest of a tool call's arguments, for loop detection.
 * Not cryptographic: it only needs to separate "same call again" from "new call".
 */
function digest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/**
 * Fold one run's events into metrics.
 *
 * @param {readonly object[]} events - Events from the child's own session, in sequence order.
 * @param {object} [options]
 * @param {number} [options.startedAt] - Harness wall-clock start, used when the log lacks a turn/start.
 * @param {number} [options.endedAt] - Harness wall-clock end.
 * @param {boolean} [options.timedOut] - The harness aborted this run on its own deadline.
 * @returns {object} Raw metrics. `status` is the completion verdict; the rest are measurements.
 */
export function extract(events, options = {}) {
  const list = Array.isArray(events) ? events : []

  const turnStarts = []
  const stepStarts = []
  const toolSequence = []
  const nativeDispatches = []
  const models = new Set()
  const toolBreakdown = new Map()

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let totalTokens = 0
  let usageSeen = false
  let missingUsageCalls = 0
  let tokenBreakdownReported = true
  let modelCalls = 0
  let firstPromptTokens = null
  let thinkingChars = 0
  let assistantTextChars = 0
  let firstAssistantAt = 0
  let lastEventAt = 0
  let terminalKind = ''
  let turns = 0

  const stepWall = new Map()

  for (const event of list) {
    if (!event || typeof event !== 'object') continue
    const time = num(event.time)
    if (time > 0) lastEventAt = time
    const data = event.data ?? {}

    switch (event.type) {
      case 'turn/start': {
        turns++
        turnStarts.push(time)
        break
      }
      case 'turn/end': {
        const kind = data.reason?.kind
        if (typeof kind === 'string') terminalKind = kind
        break
      }
      case 'step/start': {
        stepStarts.push(time)
        stepWall.set(`${data.turn}:${data.step}`, { start: time, end: 0 })
        break
      }
      case 'step/end': {
        const slot = stepWall.get(`${data.turn}:${data.step}`)
        if (slot) slot.end = time
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        const slot = toolBreakdown.get(name) ?? { calls: 0, errors: 0, ms: 0 }
        slot.calls++
        toolBreakdown.set(name, slot)
        // Lean per-call trace: the process score reads tool discipline (repeat
        // loops, whether the task's own test command was ever run) from it.
        let args = data.arguments ?? {}
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = { raw: args } }
        }
        const text = args.command ?? args.cmd ?? args.code ?? args.file_path ?? args.path ?? ''
        toolSequence.push({ name, digest: digest(args), text: String(text).slice(0, 4000) })
        break
      }
      case 'tool/result':
        // Error attribution needs the call order, so it is counted in one pass below.
        break
      case 'flow/operation':
        nativeDispatches.push({name:data.name,callId:data.callId,parentCallId:data.parentCallId,
          file:data.file??null,command:data.command??null,isError:data.isError===true,
          exitCode:data.exitCode??null,timedOut:data.timedOut===true,aborted:data.aborted===true})
        break
      case 'assistant/message': {
        modelCalls++
        if (firstAssistantAt === 0) firstAssistantAt = time
        const message = data.message ?? {}
        const source = message.source ?? {}
        if (typeof source.provider === 'string' && typeof source.model === 'string') {
          models.add(`${source.provider}/${source.model}`)
        }
        const usage = data.usage ?? message.usage
        const nonNegative = (value) => Number.isFinite(value) && value >= 0
        const validUsage = usage && typeof usage === 'object' && (nonNegative(usage.totalTokens) || (nonNegative(usage.inputTokens) && nonNegative(usage.outputTokens)))
        if (validUsage) {
          if (modelCalls === 1 && Number.isFinite(usage.inputTokens)) firstPromptTokens = usage.inputTokens + num(usage.cacheReadTokens)
          usageSeen = true
          tokenBreakdownReported &&= nonNegative(usage.inputTokens) && nonNegative(usage.outputTokens)
          inputTokens += num(usage.inputTokens)
          outputTokens += num(usage.outputTokens)
          cacheReadTokens += num(usage.cacheReadTokens)
          totalTokens += nonNegative(usage.totalTokens) ? usage.totalTokens : num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.outputTokens)
        } else missingUsageCalls++
        for (const block of message.content ?? []) {
          if (block?.type === 'reasoning') thinkingChars += textOf([block]).length
          else if (block?.type === 'text') assistantTextChars += textOf([block]).length
        }
        break
      }
      case 'request/header': {
        const config = data.header?.config
        if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
          models.add(`${config.provider}/${config.model}`)
        }
        break
      }
      default:
        break
    }
  }

  // Attribute every tool error to its own tool name in one ordered pass.
  applyToolErrors(list, toolBreakdown)

  const harnessStart = num(options.startedAt)
  const harnessEnd = num(options.endedAt)
  const logStart = turnStarts.length > 0 ? turnStarts[0] : firstAssistantAt
  const logEnd = lastEventAt
  const start = logStart > 0 ? logStart : harnessStart
  const end = logEnd > start ? logEnd : harnessEnd
  const wallMs = end > start ? end - start : Math.max(0, harnessEnd - harnessStart)
  const firstResponseMs = firstAssistantAt > 0 && start > 0 ? Math.max(0, firstAssistantAt - start) : null

  const toolErrors = [...toolBreakdown.values()].reduce((sum, slot) => sum + slot.errors, 0)

  // The provider reports `inputTokens` for the prompt material it did NOT serve
  // from cache; `cacheReadTokens` is counted separately. So the billed-at-full-
  // rate prompt is `inputTokens`, the whole prompt is the sum of the two, and
  // `totalTokens` is that plus the completion.
  const freshInputTokens = inputTokens
  const promptTokens = inputTokens + cacheReadTokens
  const uncachedInputTokens = freshInputTokens
  const steps = stepStarts.length
  const usageReported = usageSeen && missingUsageCalls === 0
  const breakdownReported = usageReported && tokenBreakdownReported

  // No terminal record at all means the run never reported an outcome; that is
  // `unknown`, not `error` — the distinction matters when a harness crash cuts
  // the stream short.
  let status = terminalKind || 'unknown'
  if (options.timedOut) status = 'timeout'
  else if (status === 'blocked') status = 'refusal'
  else if (terminalKind && !TERMINAL_KINDS.has(terminalKind)) status = 'error'

  return {
    status,
    terminalKind: terminalKind || null,
    turns,
    steps,
    modelCalls,
    // Failed/cancelled streams may never produce an assistant/message with
    // provider usage. Do not present measured messages as a complete bill.
    incompleteAttempts: list.filter(event => event.type === 'assistant/attempt').length,
    auxiliaryTitleRequests: list.filter(event => event.type === 'session/title-llm-request').length,
    firstPromptTokens,
    models: [...models],
    toolCalls: toolSequence.length,
    toolSequence,
    nativeDispatches,
    toolErrors,
    toolFailureRate: toolSequence.length > 0 ? toolErrors / toolSequence.length : 0,
    toolBreakdown: Object.fromEntries([...toolBreakdown].map(([name, slot]) => [name, { ...slot }])),
    inputTokens: breakdownReported ? inputTokens : null,
    freshInputTokens: breakdownReported ? freshInputTokens : null,
    outputTokens: breakdownReported ? outputTokens : null,
    cacheReadTokens: breakdownReported ? cacheReadTokens : null,
    promptTokens: breakdownReported ? promptTokens : null,
    uncachedInputTokens: breakdownReported ? uncachedInputTokens : null,
    totalTokens: usageReported ? totalTokens : null,
    knownTotalTokens: usageSeen ? totalTokens : null,
    usageReported,
    tokenBreakdownReported: breakdownReported,
    missingUsageCalls,
    cacheHitRatio: breakdownReported ? (promptTokens > 0 ? Math.min(1, cacheReadTokens / promptTokens) : 0) : null,
    thinkingChars,
    assistantTextChars,
    wallMs,
    // assistant/message is a completed message, not a streaming first token.
    ttftMs: null,
    firstResponseMs,
    stepDurations: [...stepWall.values()]
      .filter((slot) => slot.end > slot.start)
      .map((slot) => slot.end - slot.start),
  }
}

/**
 * Walk calls and results in sequence order and add each failure to the tool it
 * belongs to. Call ids repeat across steps, so a FIFO of open calls is used and
 * the oldest matching id wins.
 */
function applyToolErrors(list, breakdown) {
  const open = []
  for (const event of list) {
    if (event?.type === 'tool/call') {
      open.push({ id: event.data?.callId, turn: event.data?.turn, step: event.data?.step, time: event.time, name: typeof event.data?.name === 'string' ? event.data.name : 'unknown' })
      continue
    }
    if (event?.type !== 'tool/result') continue
    const message = event?.data?.message ?? {}
    const id = message.source?.callId ?? message.toolCallId
    let index = -1
    if (id !== undefined) index = open.findIndex((slot) => slot.id === id && slot.turn === event.data?.turn && slot.step === event.data?.step)
    if (index < 0 && id !== undefined) index = open.findIndex((slot) => slot.id === id)
    if (index < 0) index = open.findIndex((slot) => slot.id === undefined)
    const call = index >= 0 ? open.splice(index, 1)[0] : null
    const name = call?.name ?? 'unknown'
    const slot = breakdown.get(name) ?? { calls: 0, errors: 0, ms: 0 }
    if (message.isError) slot.errors++
    if (call && event.time > call.time) slot.ms += event.time - call.time
    breakdown.set(name, slot)
  }
}

/**
 * Efficiency ratios. All are "lower is better" except cacheHitRatio, and all
 * are null-safe: an undefined input produces null rather than a flattering 0.
 * @param {object} metrics - Output of {@link extract}.
 * @returns {object} Derived efficiency figures.
 */
export function efficiency(metrics) {
  const steps = Math.max(1, metrics.steps)
  const seconds = metrics.wallMs / 1000
  const measured = metrics.tokenBreakdownReported !== false && metrics.usageReported
  return {
    freshInputPerStep: measured ? metrics.freshInputTokens / steps : null,
    promptPerStep: measured ? metrics.promptTokens / steps : null,
    outputPerStep: measured ? metrics.outputTokens / steps : null,
    toolCallsPerStep: metrics.toolCalls / steps,
    toolFailureRate: metrics.toolFailureRate,
    outputTokensPerSecond: measured && seconds > 0 ? metrics.outputTokens / seconds : null,
    thinkingShare: measured && metrics.outputTokens > 0 ? metrics.thinkingChars / Math.max(1, metrics.thinkingChars + metrics.assistantTextChars) : null,
    cacheHitRatio: metrics.cacheHitRatio,
  }
}
