import { FlowEvidence } from '../lib/flow-evidence.js'
import { FLOW_CONFIGURATION } from '../lib/flow-guidance.js'
export const name = 'flow-evidence-policy'
export const inject = ['tools', 'systemPrompt']

export function createEvidenceObserver(agent, { configuration = FLOW_CONFIGURATION, support, supportSignature, protocol, collectTests=false, onRecord } = {}) {
  if (typeof agent?.session?.header?.cwd !== 'string') return null
  const ledger = new FlowEvidence({ root: agent.session.header.cwd,collectTests,onRecord })
  let settled = Promise.resolve(), available = true, lastAssemblySignature = null
  let assembledSupportSignature = null, deliveredSupportSignature = null
  const observe = async operation => {
    if (!available) return
    try { await operation() } catch { available = false }
  }
  return {
    ledger,
    get available(){return available},
    settle: async () => { await settled; if (protocol) { const p = protocol(); ledger.scopes = p.scopes; ledger.assessments = p.assessments } await ledger.refresh() },
    before: async exec => { await settled; await observe(() => { if (protocol) { const p = protocol(); ledger.scopes = p.scopes; ledger.assessments = p.assessments } return ledger.begin(exec) }) },
    // Final notifications are not awaited by DSH. Serialize their observations
    // and await the queue before presenting any receipt to the next request.
    after: (exec, result) => {
      // Flow Next persists the structured final result within this synchronous
      // native callback. Only file freshness work may continue asynchronously.
      if(collectTests){const current=observe(()=>ledger.finish(exec,result));settled=Promise.all([settled,current]).then(()=>{})}
      else settled = settled.then(() => observe(() => ledger.finish(exec, result)))
    },
    // Only a real model response/attempt acknowledges delivery. Prompt previews,
    // rejected pre-steps and empty turns never consume a conditional reminder.
    acknowledgeRequest: () => { deliveredSupportSignature = assembledSupportSignature },
    assemble: async assembly => {
      await settled; await observe(() => { if (protocol) { const p = protocol(); ledger.scopes = p.scopes; ledger.assessments = p.assessments } return ledger.refresh() })
      const signature = available ? ledger.signature() : null
      // Assembly previews may run without a model request. Compact repeats still
      // retain the current states/scope; no preview consumes or hides evidence.
      const text = available ? ledger.render({ compact: signature !== null && signature === lastAssemblySignature })
        : 'Flow execution evidence is unavailable. Use actual tool results; no current-code verification is certified.'
      lastAssemblySignature = signature
      assembledSupportSignature = available && supportSignature ? supportSignature(ledger) : null
      const repeatedSupport = assembledSupportSignature !== null && assembledSupportSignature === deliveredSupportSignature
      // Facts remain in execution evidence on every assembly; omit only the
      // unchanged instruction. A new check, stale input or turn reactivates it.
      const supportText = available && support && !repeatedSupport ? support(ledger) : ''
      return { ...assembly, contexts: [...assembly.contexts,
        { name: 'flow:configuration', order: 89, text: configuration },
        ...(supportText ? [{ name: 'flow:task-support', order: 88, text: supportText }] : []),
        ...(text ? [{ name: 'flow:execution-evidence', order: 90, text }] : [])] }
    },
  }
}
export function apply(ctx) {
  // The desktop can mount a preset AFTER Agent creation, before its first turn.
  // Register hooks in the preset scope and initialize each Agent lazily. These
  // listeners disappear with that preset; none escape into agent.ctx.
  const observers = new WeakMap()
  const forAgent = agent => {
    if (!agent || typeof agent !== 'object') return null
    if (!observers.has(agent)) observers.set(agent, createEvidenceObserver(agent))
    return observers.get(agent)
  }
  ctx.on('tools/execute', async (exec, next) => { await forAgent(exec.agent)?.before(exec); return next() })
  ctx.on('tools/result', (exec, result) => { forAgent(exec.agent)?.after(exec, result) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    return forAgent(context.scope)?.assemble(assembly) ?? assembly
  })
}
