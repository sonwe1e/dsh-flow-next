// Host-independent policy and replay. Tool execution stays in the DSH runtime.
export const ADAPTIVE_VERSION = 1
export const ADAPTIVE_SOURCE = 'flow-adaptive-state'
export const LOCAL_CAPABILITIES = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'bash', 'pwsh', 'job_list', 'job_output', 'job_kill', 'flow_select'])
export const DEFAULT_POLICY = Object.freeze({ strategy: 'adaptive', maxSwitches: 4, cooldownSteps: 2 })
export const ADAPTIVE_GUIDANCE = `Use the current tools to complete the user's task and verify the requested behavior. Correctness takes priority when cost and speed conflict. The flow_select tool can change the interface and tool range for the next request in this same session. Native tools suit direct operations. PTC can combine already determined operations and curate large results with a short program; it adds programming overhead. The local range contains file, search, shell, and job tools. Full restores the preset's other tools subject to existing permissions. Keep the current configuration unless a concrete next operation benefits from changing it. You can request a selection together with useful work; all tools in that batch use the current configuration. Selection limits and cooldowns apply. A failing test calls for debugging the implementation; it is not by itself a reason to switch interfaces. Check the actual available schemas or SDK. After the requested behavior is verified, deliver the result.`
const clone = value => structuredClone(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export function policyConfig(config = {}) {
  const policy = { ...DEFAULT_POLICY, ...config }
  if (!['fixed', 'once', 'adaptive'].includes(policy.strategy) || !Number.isSafeInteger(policy.maxSwitches) ||
    policy.maxSwitches < 0 || policy.maxSwitches > 8 || !Number.isSafeInteger(policy.cooldownSteps) ||
    policy.cooldownSteps < 0 || policy.cooldownSteps > 20 || Object.keys(policy).length !== 3) throw new Error('Invalid Flow adaptive policy')
  return policy
}
function validTarget(target) {
  return target && ['native', 'ptc'].includes(target.presentation) && ['full', 'local'].includes(target.capabilities)
}
export function replayAdaptive(events, policy = DEFAULT_POLICY) {
  let state
  for (const event of events) {
    if (event.type !== 'developer/message' || event.data?.message?.source?.kind !== ADAPTIVE_SOURCE) continue
    const blocks = event.data.message.content
    if (blocks?.length !== 1 || blocks[0].type !== 'text') throw new Error('Invalid Flow state message')
    const record = JSON.parse(blocks[0].text)
    const candidate = record.state
    if (record.flowAdaptive !== ADAPTIVE_VERSION || candidate?.version !== ADAPTIVE_VERSION || !validTarget(candidate.current) ||
      (candidate.pending !== null && (!validTarget(candidate.pending?.target) || typeof candidate.pending?.reason !== 'string')) ||
      !Number.isSafeInteger(candidate.switches) || candidate.switches < 0 || candidate.switches > policy.maxSwitches ||
      !(candidate.lastSwitchAt === null || (Number.isSafeInteger(candidate.lastSwitchAt) && candidate.lastSwitchAt >= 0)) ||
      !equal(candidate.policy, policy)) throw new Error('Incompatible or invalid Flow adaptive checkpoint; no request dispatched')
    state = clone(candidate)
  }
  return state ?? { version: ADAPTIVE_VERSION, policy: clone(policy), current: { presentation: 'native', capabilities: 'full' },
    pending: null, switches: 0, lastSwitchAt: null }
}
export function auditAdaptiveRequests(events, { source = ADAPTIVE_SOURCE } = {}) {
  let presentation = 'native', capabilities = 'full'
  const reasons = []
  for (const event of events) {
    if (event.type === 'developer/message' && event.data?.message?.source?.kind === source) {
      try {
        const record = JSON.parse(event.data.message.content[0].text)
        if (record.flowAdaptive !== ADAPTIVE_VERSION || !validTarget(record.state?.current)) throw new Error('Invalid checkpoint')
        ;({ presentation, capabilities } = record.state.current)
      } catch { reasons.push('invalid adaptive checkpoint') }
    }
    if (event.type !== 'request/header') continue
    const names = (event.data?.header?.tools ?? []).map(t => t.name)
    if (presentation === 'ptc' && (names.length !== 1 || names[0] !== 'run_code')) reasons.push('adaptive PTC checkpoint disagrees with request tools')
    if (presentation === 'native' && names.includes('run_code')) reasons.push('adaptive native checkpoint disagrees with request tools')
    if (presentation === 'native' && capabilities === 'local' && names.some(name => !LOCAL_CAPABILITIES.has(name))) reasons.push('adaptive local checkpoint exposes tools outside local range')
  }
  return { valid: !reasons.length, reasons: [...new Set(reasons)] }
}
export class AdaptiveFlow {
  constructor({ events, progress, install, record, available, config }) {
    this.events = events; this.install = install; this.record = record; this.available = available
    this.progress = progress
    this.policy = policyConfig(config)
    this.selectionLimit = this.policy.strategy === 'fixed' ? 0 : this.policy.strategy === 'once' ? Math.min(1, this.policy.maxSwitches) : this.policy.maxSwitches
    this.state = replayAdaptive(events(), this.policy)
    this.cursor = 0; this.completedSteps = 0; this.openStep = false
    this.observe()
    this.release = this.install(this.state.current)
  }
  observe() {
    if (this.progress) {
      const value = this.progress()
      if (!Number.isSafeInteger(value.completedSteps) || value.completedSteps < 0 || typeof value.openStep !== 'boolean') throw new Error('Invalid adaptive progress projection')
      this.completedSteps = value.completedSteps; this.openStep = value.openStep
      return
    }
    const events = this.events()
    for (; this.cursor < events.length; this.cursor++) {
      if (events[this.cursor].type === 'step/start') this.openStep = true
      if (events[this.cursor].type === 'step/end') { this.openStep = false; this.completedSteps++ }
    }
  }
  save(event, reason) { this.record({ flowAdaptive: ADAPTIVE_VERSION, event, reason, state: clone(this.state) }) }
  select(target, reason) {
    this.observe()
    const reject = why => ({ accepted: false, reason: why, current: clone(this.state.current) })
    if (!validTarget(target) || typeof reason !== 'string' || !reason.trim() || reason.length > 240) return reject('Invalid selection or reason')
    if (this.state.pending) return reject('One selection is already pending for this batch')
    if (equal(target, this.state.current)) return reject('This interface and capability range are already active')
    if (this.state.switches >= this.selectionLimit) return reject('Selection limit reached; continue with the current tools')
    if (this.state.lastSwitchAt !== null && this.completedSteps - this.state.lastSwitchAt < this.policy.cooldownSteps) return reject('Cooldown: continue useful work before another selection')
    const unavailable = this.available(target)
    if (unavailable) return reject(unavailable)
    const previous = clone(this.state)
    this.state.pending = { target: clone(target), reason: reason.trim() }
    this.state.switches++
    try { this.save('queued', reason.trim()) } catch (error) { this.state = previous; throw error }
    return { accepted: true, reason: 'Applies after this tool batch, before the next request is assembled',
      current: clone(this.state.current), next: clone(target), selectionsUsed: this.state.switches }
  }
  // Synchronous prompt-variable provider: DSH evaluates variables BEFORE its
  // tool providers and prompt sections. Never change interfaces in pre-step,
  // whose assembly is already frozen, or inside a running tool batch.
  boundary() {
    this.observe()
    if (!this.state.pending || this.openStep) return this.status()
    const pending = this.state.pending, previous = clone(this.state.current)
    this.release()
    try {
      this.release = this.install(pending.target)
    } catch (error) {
      this.release = this.install(previous)
      this.state.pending = null; this.state.lastSwitchAt = this.completedSteps
      this.save('rollback', String(error.message))
      return this.status()
    }
    this.state.current = clone(pending.target)
    this.state.pending = null; this.state.lastSwitchAt = this.completedSteps
    this.save('applied', pending.reason)
    return this.status()
  }
  status() { return `Flow interface: ${this.state.current.presentation}; capabilities: ${this.state.current.capabilities}; policy: ${this.policy.strategy}; selections: ${this.state.switches}/${this.selectionLimit}; cooldown: ${this.policy.cooldownSteps} completed steps.` }
  dispose() { this.release() }
}
