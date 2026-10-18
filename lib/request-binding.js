import { createHash } from 'node:crypto'
import { hashOf } from './protocol.js'

// DSH projects these sections as user runtime-context snapshots. Select the
// latest snapshot, including an empty replacement, rather than stale history.
export function flowEvidenceText(messages = []) {
  const snapshot = messages.filter(message => message.source?.kind === 'runtime-context').at(-1)
  if (snapshot) return snapshot.source.sections?.find(section => section.name === 'flow:execution-evidence')?.text ?? ''
  return ''
}
export function flowContextText(messages = []) {
  return messages.filter(message=>message.source?.kind==='runtime-context').at(-1)?.source.sections
    ?.find(section=>section.name==='flow:compacted-human-context')?.text ?? ''
}
export function flowTaskSupportText(messages = []) {
  return messages.filter(message=>message.source?.kind==='runtime-context').at(-1)?.source.sections
    ?.find(section=>section.name==='flow:task-support')?.text ?? ''
}
export function flowCheckProtocolText(messages = []) {
  return messages.filter(message=>message.source?.kind==='runtime-context').at(-1)?.source.sections
    ?.find(section=>section.name==='flow:check-protocol')?.text ?? ''
}

// Only the loop-owned runtime snapshot can bind a mode revision. Quoted user
// text and an exporter's currently installed package version are not evidence.
export function flowModeBinding(messages = []) {
  const snapshot = messages.filter(message => message.source?.kind === 'runtime-context').at(-1)
  const text = snapshot?.source.sections?.find(section => section.name === 'flow:configuration')?.text
  try {
    const value = JSON.parse(text)
    if (!['flow','flow-next'].includes(value.mode) || !/^\d+\.\d+\.\d+$/.test(value.modeVersion)
      || typeof value.evidencePolicyRevision !== 'string' || value.evidencePolicyRevision.length > 80
      || !/^[a-f0-9]{64}$/.test(value.guidanceSha256)) return null
    if (value.contextPolicyRevision !== undefined && (typeof value.contextPolicyRevision!=='string'||value.contextPolicyRevision.length>80)) return null
    if (value.harnessPolicyRevision !== undefined && (typeof value.harnessPolicyRevision!=='string'||value.harnessPolicyRevision.length>80)) return null
    if (value.coordinationPolicyRevision !== undefined && (typeof value.coordinationPolicyRevision!=='string'||value.coordinationPolicyRevision.length>80)) return null
    if (value.validationPolicyRevision !== undefined && (typeof value.validationPolicyRevision!=='string'||value.validationPolicyRevision.length>80)) return null
    if (value.taskPolicyRevision !== undefined && (typeof value.taskPolicyRevision!=='string'||value.taskPolicyRevision.length>80)) return null
    return { mode: value.mode, modeVersion: value.modeVersion, evidencePolicyRevision: value.evidencePolicyRevision,
      guidanceSha256: value.guidanceSha256, ...(value.contextPolicyRevision===undefined?{}:{contextPolicyRevision:value.contextPolicyRevision}),
      ...(value.harnessPolicyRevision===undefined?{}:{harnessPolicyRevision:value.harnessPolicyRevision}),
      ...(value.coordinationPolicyRevision===undefined?{}:{coordinationPolicyRevision:value.coordinationPolicyRevision}),
      ...(value.validationPolicyRevision===undefined?{}:{validationPolicyRevision:value.validationPolicyRevision}),
      ...(value.taskPolicyRevision===undefined?{}:{taskPolicyRevision:value.taskPolicyRevision}) }
  } catch { return null }
}

// Observation only. Never return message text, tool arguments, adapter defaults,
// API keys, or headers. The caller forwards the original request unchanged.
export function requestBinding(request, { batchText = '', verifyText = '', flowText = '', flowNativeText = '' } = {}) {
  const messages = request.messages ?? []
  const system = messages.filter(message => message.role === 'system').flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  const evidence = flowEvidenceText(messages)
  const context = flowContextText(messages)
  const support = flowTaskSupportText(messages)
  const checks = flowCheckProtocolText(messages)
  const task=messages.filter(message=>message.source?.kind==='runtime-context').at(-1)?.source.sections?.find(section=>section.name==='flow:task-state')?.text??''
  return { sessionId: request.sessionId, provider: request.provider, model: request.model,
    systemChars: system.length, systemSha256: createHash('sha256').update(system).digest('hex'),
    batchIncluded: Boolean(batchText) && system.includes(batchText), verifyIncluded: Boolean(verifyText) && system.includes(verifyText),
    flowIncluded: Boolean(flowText) && system.includes(flowText),
    ...(flowNativeText ? { flowNativeIncluded: system.includes(flowNativeText) } : {}),
    flowEvidenceIncluded: evidence.length > 0, flowEvidenceChars: evidence.length,
    flowEvidenceSha256: evidence ? createHash('sha256').update(evidence).digest('hex') : null,
    flowModeBinding: flowModeBinding(messages),
    flowContextIncluded: context.length>0, flowContextChars: context.length,
    flowContextSha256: context?createHash('sha256').update(context).digest('hex'):null,
    flowTaskSupportIncluded:support.length>0,flowTaskSupportChars:support.length,
    flowCheckProtocolIncluded:checks.length>0,flowCheckProtocolChars:checks.length,
    flowTaskStateIncluded:task.length>0,flowTaskStateChars:task.length,
    toolSchemaHash: hashOf([...(request.tools ?? [])].sort((a,b) => a.name.localeCompare(b.name))) }
}
