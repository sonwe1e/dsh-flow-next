import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ADAPTIVE_SOURCE } from './flow-adaptive.js'
import { FLOW_CONTEXT_REVISION, FLOW_EVIDENCE_REVISION } from './flow-guidance.js'
import { FLOW_CHECK_SOURCE,FLOW_CHECK_MAX_CHARS,readCheckProtocol } from './flow-check-protocol.js'
import { FLOW_COORDINATION_REVISION } from './flow-coordination.js'
import { FLOW_VALIDATION_REVISION } from './flow-validation.js'
import { FLOW_TASK_REVISION } from './flow-task.js'

export const FLOW_NEXT_VERSION = '1.8.3'
export const FLOW_NEXT_SOURCE = 'flow-next-interface-state'
export const FLOW_NEXT_KEY = 'flow_next_runtime'
export const FLOW_NEXT_REVISION = 'native-stage-execution-obligations-v8'
export const FLOW_NEXT_POLICY = Object.freeze({ strategy:'adaptive',maxSwitches:8,cooldownSteps:1 })
// Relaxed writing guidance adopted at the user's request after the DINOv2/ResNet
// trials, grounded in https://x.com/karpathy/status/2105819303471976479 and its
// attached overview. This is an adaptation, not full ASD-STE100 compliance.
export const FLOW_NEXT_EXPLANATION_GUIDANCE = `When explaining technical concepts, mechanisms or implementations, prefer short sentences with one main idea and paragraphs with one topic. Preserve causal, conditional and contrast links when splitting sentences; use lists for complex parallel items or steps. Use the same name for the same concept, familiar words and brief first-use explanations of necessary terms. Unpack noun clusters; make the actor, action and object explicit, retain needed conditions, and use pronouns only when their referent is clear. Preserve technical meaning, facts and limits. Adapt to the response language without rigid word counts. Apply these rules to explanations and prose comments while preserving exact code, identifiers, formulas and user-specified formats. Keep simple answers brief.`
export const FLOW_NEXT_GUIDANCE = `Complete the user's actual goal. Quality comes first; reduce unnecessary work after requirements are met. Answer simple questions directly. For code changes, use repository instructions, confirmed environment facts and existing checks. Ask only for material choices you cannot resolve by inspection.
${FLOW_NEXT_EXPLANATION_GUIDANCE}
Choose the next useful operation from current evidence. Use native tools for direct work. Use flow_select to choose PTC for already determined operations or result curation; it applies after the current batch. Independent operations may run together; dependent decisions stay sequential. Full capabilities remain available. Do not switch merely because a test failed.
For complex work, use existing goal, plans or notes to retain scope, decisions, changed contracts, evidence and gaps across stages; simple work needs no ceremony. When changing shared data or state, check producer and consumer conventions (units, origin, lifecycle transitions) at their integration boundary. Corrections, priors and compensation must preserve real wrong inputs as wrong; choose a relevant negative control. Ground test expectations and tolerances in the requirement or independent evidence; explain changes. Investigate failures before assigning causes. After an edit mismatch, refresh the needed context before another guess. Use short saved results for known operations; retain full logs for diagnosis.
Verify affected behavior and required checks. Passing helpers or an outer shell exit do not certify integration. Reuse unchanged checks only within their recorded scope. An observed file change is not automatically a dependency change; assess relevance before rerunning. Use names from current tool schemas. For broad checks, reconcile planned, executed, failed and skipped cases; use flow_check to retain scope, explained failures or coverage when useful. When building or changing a key verifier, first confirm a working control and a relevant wrong input or reverted fix remains detectable, then expand to affected cases and required full checks. A repaired-object list is not proof of repaired behavior. Keep completed, deferred and unverified requirements distinct; do not silently narrow the goal at delivery. Finish when the agreed scope is covered. Separate facts, inferences and unknowns.`
export const FLOW_NEXT_CONFIGURATION = JSON.stringify({mode:'flow-next',modeVersion:FLOW_NEXT_VERSION,
  guidanceSha256:createHash('sha256').update(FLOW_NEXT_GUIDANCE).digest('hex'),evidencePolicyRevision:FLOW_EVIDENCE_REVISION,
  contextPolicyRevision:FLOW_CONTEXT_REVISION,harnessPolicyRevision:FLOW_NEXT_REVISION,coordinationPolicyRevision:FLOW_COORDINATION_REVISION,
  validationPolicyRevision:FLOW_VALIDATION_REVISION,taskPolicyRevision:FLOW_TASK_REVISION})

export const nextStateSchema = z.object({turn:z.number().int().nonnegative(),step:z.number().int().nonnegative(),
  completedSteps:z.number().int().nonnegative(),openStep:z.boolean(),toolCalls:z.number().int().nonnegative(),
  editAttempts:z.number().int().nonnegative(),checkpoint:z.string().max(8000).nullable(),
  checkProtocol:z.string().max(FLOW_CHECK_MAX_CHARS).nullable().default(null)}).strict()
export const initialNextState=()=>({turn:0,step:0,completedSteps:0,openStep:false,toolCalls:0,editAttempts:0,checkpoint:null,checkProtocol:null})
// Incremental native projection: no transcript copies or repeated full-log scans.
export function foldNextState(state,event) {
  const d=event.data??{}
  if(event.type==='turn/start')return {...state,turn:d.turn??state.turn,step:0,openStep:false,toolCalls:0,editAttempts:0}
  if(event.type==='step/start')return {...state,step:d.step??state.step,openStep:true}
  if(event.type==='step/end')return {...state,openStep:false,completedSteps:state.completedSteps+1}
  if(event.type==='tool/call')return {...state,toolCalls:state.toolCalls+1,editAttempts:state.editAttempts+ +['write','edit'].includes(d.name)}
  if(event.type==='developer/message'&&d.message?.source?.kind===FLOW_CHECK_SOURCE) {
    const blocks=d.message.content
    if(blocks?.length!==1||blocks[0].type!=='text')throw new Error('Invalid check protocol checkpoint')
    readCheckProtocol(blocks[0].text)
    return {...state,checkProtocol:blocks[0].text}
  }
  if(event.type==='developer/message'&&d.message?.source?.kind===FLOW_NEXT_SOURCE) {
    const blocks=d.message.content
    if(blocks?.length!==1||blocks[0].type!=='text'||typeof blocks[0].text!=='string'||blocks[0].text.length>8000)throw new Error('Invalid Flow Next interface checkpoint')
    return {...state,checkpoint:blocks[0].text}
  }
  return state
}
export function nextCheckpointEvents(state) {
  return state.checkpoint===null?[]:[{type:'developer/message',data:{message:{source:{kind:ADAPTIVE_SOURCE},content:[{type:'text',text:state.checkpoint}]}}}]
}
export function renderNextSupport(state,ledger) {
  const receipts=ledger.last??[],latest=receipts[0],lines=[]
  const unresolved=ledger.unresolved??receipts.filter(r=>r.state!=='exited-zero')
  const failures=unresolved.filter(r=>['failed','reported-test-failure','reported-diagnostic-failure'].includes(r.state))
  const unassessed=failures.filter(r=>{const a=ledger.assessmentFor?.(r);return !a||a.category==='unknown'||a.replacementId&&!a.applicableReplacement})
  const failed=failures.length>0
  if(unresolved.some(r=>r.state==='unfinished'))lines.push('Relevant checks may still be pending. Collect their actual terminal results before relying on them; do not busy-poll.')
  if(latest?.freshness==='stale')lines.push('Observed files changed; dependency relevance is not inferred. Assess relevance, then rerun affected checks before applying old evidence. Unrelated notes alone need no rerun.')
  if(unresolved.some(r=>r.state==='zero-tests'))lines.push('A check reported zero tests. Inspect the runner, selection and actual executed count; exit zero alone is inconclusive.')
  if(unresolved.some(r=>r.state==='all-tests-skipped'))lines.push('Every observed case was ignored, skipped, disabled or todo. No passing execution is established by that run.')
  if(unresolved.some(r=>r.state==='test-selection-gap'))lines.push('An observed test set omitted a declared name or a simple selection branch. Inspect flow_check report; a nonzero aggregate count does not establish that each selected group ran.')
  if(unresolved.some(r=>r.state==='test-results-incomplete'))lines.push('Runner output was partial, repeated or inconsistent. Per-test absence is unknown; flow_check report retains observed states without certifying complete coverage.')
  if(unassessed.length)lines.push('An unresolved execution reported failure. Read its saved output and decision conditions; distinguish an intended negative check, environment problem, wrong expectation and implementation defect. A different passing check does not resolve it.')
  else if(failed)lines.push('Earlier failures have agent assessments; originals remain unresolved execution facts. Inspect replacement scope and remaining requirements; do not repeat an explained check solely to clear the ledger. Assessments are not acceptance.')
  const missing=latest?.laterEditedFiles?.length||latest?.omittedInputs?.length||latest?.aggregate||latest?.scopeDeclarationPending||ledger.unobserved||ledger.outcomesTruncated
  if(missing&&!failed&&(receipts.length||unresolved.length))lines.push('Check scope is partial or individual statuses are unknown. Inspect changed dependencies and per-check results; do not extend a receipt beyond its observed inputs.')
  if(!unresolved.length&&!missing&&latest?.state==='exited-zero'&&latest.freshness==='observed-inputs-unchanged')lines.push('Reuse applicable unchanged evidence. Inspect remaining requested behavior and required checks, then deliver; avoid unrelated expansion or duplicate verification.')
  if(state.toolCalls>=10&&state.editAttempts===0&&receipts.length===0)lines.push('Several tool records occurred without native edit attempts or recorded checks. This does not prove a stall: research and shell edits may be legitimate. If enough evidence is available, take the next useful action rather than continue inventory.')
  return lines.length?'Flow Next task support (observations, not independent acceptance):\n'+lines.join('\n'):''
}
// Assembly previews do not consume the transition. On unchanged states the
// receipt ledger remains visible; only the repeated instruction is shortened.
export function nextSupportSignature(state,ledger) {
  return JSON.stringify({turn:state.turn,inventory:state.toolCalls>=10&&state.editAttempts===0,
    receipts:(ledger.last??[]).map(r=>({sequence:r.sequence,state:r.state,freshness:r.freshness,
      aggregate:Boolean(r.aggregate),missing:Boolean(r.laterEditedFiles?.length||r.omittedInputs?.length||r.scopeDeclarationPending)})),
    unresolved:(ledger.unresolved??[]).map(r=>({sequence:r.sequence,state:r.state,remaining:r.remainingKeys.length})),
    assessments:(ledger.assessments??[]).map(a=>({id:a.checkId,category:a.category,replacement:a.replacementId,
      applicable:Boolean(ledger.assessmentFor?.({checkId:a.checkId})?.applicableReplacement)})),
    scopeLimited:Boolean(ledger.unobserved||ledger.outcomesTruncated)})
}
