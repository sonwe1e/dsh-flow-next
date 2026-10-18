import { z } from 'zod'
import { boundedOutput } from './check-evidence.js'
import { checkBindingSchema,compareCheckRuns,noteworthyCheckChange } from './flow-check-run.js'
export const FLOW_VALIDATION_KEY='flow_validation_receipts'
export const FLOW_VALIDATION_SOURCE='flow-validation-checkpoint'
export const FLOW_VALIDATION_SUMMARY_SOURCE='flow-validation-summary'
export const FLOW_VALIDATION_REVISION='native-stage-execution-bindings-v3'
export const FLOW_VALIDATION_INDEX_KEY='flow_validation_history_index'
export const VALIDATION_LIMITS=Object.freeze({runs:8,chars:262144,promptChars:1800})
const item=z.object({name:z.string().max(240),state:z.enum(['passed','failed','skipped','disabled','ignored','todo'])}).strict()
const count=z.number().int().nonnegative()
const tests=z.object({runner:z.enum(['ctest','rust','vitest','unknown']),cases:z.array(item).max(512),counts:z.object({passed:count,failed:count,skipped:count,disabled:count,ignored:count.optional(),todo:count.optional()}).strict(),
  registered:count.nullable(),summary:z.object({failed:count,total:count}).strict().nullable(),complete:z.boolean(),truncated:z.boolean(),ambiguous:z.boolean(),
  expectations:z.array(z.object({name:z.string().max(1200),match:z.enum(['exact','prefix','suffix','contains']),origin:z.enum(['selection-branch','agent-declared']),observed:count,
    states:z.object({passed:count,failed:count,skipped:count,disabled:count,ignored:count,todo:count}).strict().optional()}).strict()).max(64),
  selection:z.enum(['not-declared','gap','unknown','observed']),provenance:z.string().max(200),
  execution:z.object({build:z.enum(['unknown','started','passed','failed']),tests:z.enum(['not-observed','started','finished']),mode:z.enum(['tests','build-only'])}).strict().optional(),
  aggregateCounts:z.object({passed:count,failed:count,skipped:count,todo:count,ignored:count.optional(),disabled:count.optional()}).strict().nullable().optional(),aggregateComplete:z.boolean().optional(),runnerFailed:z.boolean().optional(),
  streamCounts:z.object({passed:count,failed:count,skipped:count,disabled:count,ignored:count,todo:count}).strict().optional(),streamComplete:z.boolean().optional(),omittedCases:count.optional(),caseSetSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
const run=z.object({id:z.string().regex(/^[a-f0-9]{16}$/),callId:z.string().max(240),rootCallId:z.string().max(240),toolName:z.string().max(30),
  command:z.string().max(400),state:z.string().max(64),exitCode:z.number().int().nullable(),jobId:z.string().max(240).nullable(),
  sequence:count,tests:tests.nullable(),originSessionId:z.string().min(1).max(240).optional(),
  cwd:z.string().max(4096).optional(),files:z.record(z.string().max(4096),z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional(),
  changedDuringExecution:z.boolean().optional(),scopeKind:z.string().max(64).optional(),aggregate:z.boolean().optional(),binding:checkBindingSchema.optional(),
  commandSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),inputBefore:z.record(z.string().max(4096),z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional(),
  outputSources:z.array(z.object({path:z.string().max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/),nativeReadCallId:z.string().max(240)}).strict()).max(4).optional()}).strict()
export const validationPayloadSchema=z.object({version:z.literal(1),runs:z.array(run).max(VALIDATION_LIMITS.runs),omitted:count}).strict()
export const validationStateSchema=validationPayloadSchema.extend({surfaceSeq:z.number().int().nullable()}).strict()
export const initialValidationState=()=>({version:1,runs:[],omitted:0,surfaceSeq:null})
// Store only native event locations. The full receipts remain in the host's
// immutable session; they are not copied into another database or prompt.
export const validationIndexSchema=z.object({order:z.array(z.string().regex(/^[a-f0-9]{16}$/)),
  locations:z.record(z.string().regex(/^[a-f0-9]{16}$/),z.object({seq:count}).strict())}).strict()
export const validationIndexViewSchema=validationIndexSchema.extend({total:count,omitted:count}).strict()
export const validationIndexView=state=>({order:state.order.slice(-128),locations:Object.fromEntries(state.order.slice(-128).map(id=>[id,state.locations[id]])),total:state.order.length,omitted:Math.max(0,state.order.length-128)})
export const initialValidationIndex=()=>({order:[],locations:{}})
export function foldValidationIndex(state,event){
  if(event.type!=='developer/message'||event.data?.message?.source?.kind!==FLOW_VALIDATION_SOURCE)return state
  const content=event.data.message.content
  if(content?.length!==1||content[0].type!=='text'||content[0].text.length>VALIDATION_LIMITS.chars)throw new Error('Invalid validation index source')
  const payload=validationPayloadSchema.parse(JSON.parse(content[0].text)),order=[...state.order],locations={...state.locations}
  for(const receipt of payload.runs){if(!Object.hasOwn(locations,receipt.id))order.push(receipt.id);locations[receipt.id]={seq:event.seq}}
  return {order,locations}
}
export function foldValidation(state,event){
  if(event.type!=='developer/message')return state
  const message=event.data?.message,source=message?.source?.kind
  if(source===FLOW_VALIDATION_SUMMARY_SOURCE)return {...state,surfaceSeq:event.seq}
  if(source!==FLOW_VALIDATION_SOURCE)return state
  const content=message.content
  if(content?.length!==1||content[0].type!=='text'||content[0].text.length>VALIDATION_LIMITS.chars)throw new Error('Invalid validation checkpoint')
  return {...validationPayloadSchema.parse(JSON.parse(content[0].text)),surfaceSeq:event.seq}
}
export function recordValidation(state,receipt,{originSessionId=receipt.originSessionId}={}){
  const previous=state.runs.findIndex(r=>r.id===receipt.checkId),oldOrigin=state.runs[previous]?.originSessionId
  if(oldOrigin&&originSessionId&&oldOrigin!==originSessionId)throw new Error('An observed check cannot change its originating session')
  originSessionId??=oldOrigin
  const entry=run.parse({id:receipt.checkId,callId:receipt.callId,rootCallId:receipt.rootCallId,toolName:receipt.toolName,
    command:boundedOutput(receipt.command,400),state:receipt.state,exitCode:receipt.exitCode??null,jobId:receipt.jobId??null,
    sequence:receipt.sequence,tests:receipt.tests??null,...(originSessionId!==undefined?{originSessionId}:{}),
    ...(receipt.cwd!==undefined?{cwd:receipt.cwd}:{}),...(receipt.files?{files:receipt.files}:{}),
    ...(receipt.changedDuringExecution!==undefined?{changedDuringExecution:receipt.changedDuringExecution}:{}),
    ...(receipt.scopeKind?{scopeKind:receipt.scopeKind}:{}),...(receipt.aggregate!==undefined?{aggregate:receipt.aggregate}:{}),...(receipt.binding?{binding:receipt.binding}:{}),
    ...(receipt.commandSha256?{commandSha256:receipt.commandSha256}:{}),...(receipt.inputBefore?{inputBefore:receipt.inputBefore}:{}),
    ...(receipt.outputSources?{outputSources:receipt.outputSources}:{})})
  const runs=[...state.runs]
  if(previous<0)runs.push(entry);else runs[previous]=entry
  const next={version:1,runs,omitted:state.omitted}
  while(next.runs.length>VALIDATION_LIMITS.runs||JSON.stringify(next).length>VALIDATION_LIMITS.chars){
    if(next.runs.length===1)throw new Error('Single validation observation exceeds bound')
    next.runs.shift();next.omitted++
  }
  return validationPayloadSchema.parse(next)
}
export function validationReport(state,ledger,{checkId,claims,currentSessionId}={}){
  const selected=checkId?state.runs.filter(r=>r.id===checkId):state.runs
  if(checkId&&!selected.length)throw new Error('Unknown observed check id; omitted or foreign records cannot certify a claim')
  const runs=selected.map(r=>{
    const origin=!r.originSessionId||!currentSessionId?'unknown':r.originSessionId===currentSessionId?'current-session':'inherited-session'
    return {...r,originSessionId:r.originSessionId??null,origin,
      freshness:origin==='inherited-session'?'inherited-not-revalidated':ledger?.getRecord?.(r.id)?.freshness??ledger?.last?.find(l=>l.checkId===r.id)?.freshness??'historical-not-revalidated'}
  })
  if(claims!==undefined){
    if(!checkId||!Array.isArray(claims)||!claims.length||claims.length>64)throw new Error('Claims need one observed check id and 1..64 exact test names/states')
    const observed=runs[0].tests
    if(!observed)throw new Error('This execution has no observed per-test results')
    // In repeated or truncated output a first Passed line may hide a later
    // Failed line for the same identity. Retain observations but certify no
    // unique per-case outcome from this ambiguous set.
    if(observed.ambiguous||observed.truncated)throw new Error('Contradicted or unprovable test-state claims: ambiguous or truncated runner output has no unique complete case outcomes')
    for(const claim of claims){
      if(!claim||Object.keys(claim).some(k=>!['test','state'].includes(k))||typeof claim.test!=='string'||!claim.test.length||claim.test.length>240||!['passed','failed','skipped','disabled','ignored','todo','not-observed'].includes(claim.state))throw new Error('Invalid test-state claim')
      const actual=observed.cases.find(c=>c.name===claim.test)?.state
      if(actual!==claim.state&&!(claim.state==='not-observed'&&!actual&&observed.complete))throw new Error(`Contradicted or unprovable claim ${JSON.stringify(claim.test)}: claimed=${claim.state}; observed=${actual??'unknown/not-observed'}`)
    }
  }
  return {provenance:'Native execution observations, not model claims or independent product acceptance',scope:'Records retained in this session; inherited and unknown origins are labeled. Child reports and unobserved commands are not implicitly included.',
    omitted:state.omitted,runs,claimsChecked:claims?.length??0,acceptance:'not-certified'}
}
export function renderValidationReport(report,{compact=false}={}){
  if(!report.runs.length&&!report.omitted)return ''
  const changes=new Map(report.runs.map((row,index)=>[row.id,report.runs.slice(0,index).reverse().map(old=>compareCheckRuns(old,row)).find(Boolean)??null]))
  const exceptional=r=>r.state!=='exited-zero'||noteworthyCheckChange(changes.get(r.id))||Boolean(r.binding&&(r.binding.changedDefinitions.length||r.binding.removedExpectedTests.length))||Boolean(r.tests&&(
    r.tests.execution?.mode!=='build-only'&&!r.tests.complete&&!(r.tests.aggregateComplete&&!r.tests.expectations.length)
    ||r.tests.counts.failed||r.tests.counts.skipped||r.tests.counts.disabled||r.tests.counts.ignored||r.tests.counts.todo
    ||r.tests.aggregateCounts?.skipped||r.tests.aggregateCounts?.todo||r.tests.aggregateCounts?.ignored||['gap','unknown'].includes(r.tests.selection)))
  const exceptions=report.runs.filter(exceptional),inherited=report.runs.filter(r=>r.origin==='inherited-session'),unknown=report.runs.filter(r=>r.origin==='unknown')
  // The complete bounded exception-id list stays ahead of all truncatable
  // detail, including after restore when the live evidence ledger is empty.
  const heading=['Flow 检查事实 / observed check report（不认证需求完成或当前代码全部通过）:',
    `Retained runs=${report.runs.length}; omitted=${report.omitted}; nonpassing/incomplete runs=${exceptions.length}; ids=${exceptions.map(r=>r.id).join(',')||'none'}.`,
    `Origin: inherited=${inherited.length}; unknown=${unknown.length}. Historical origin never certifies current-session execution.`]
  if(report.omitted)heading.push('Earlier observations exceeded the bounded view; original native checkpoints remain in session history.')
  const lines=[],ordered=compact?[...exceptions,...report.runs.filter(r=>!exceptional(r))]:report.runs
  for(const r of ordered){
    lines.push(`${r.id} ${r.state}; exit=${r.exitCode??'unknown'}; ${r.freshness}; origin=${r.origin??'unknown'}${!compact&&r.originSessionId?` (${r.originSessionId})`:''}; ${compact?boundedOutput(r.command,100):r.command}`)
    if(r.binding&&(r.binding.changedDefinitions.length||r.binding.removedExpectedTests.length))lines.push(`  VALIDATION CHANGED: definitions=${JSON.stringify(r.binding.changedDefinitions)}; removed expected=${JSON.stringify(r.binding.removedExpectedTests)}; reason=${JSON.stringify(r.binding.amendmentReason)}; change is not acceptance.`)
    if(noteworthyCheckChange(changes.get(r.id)))lines.push('  OBSERVED INPUT/SELECTION CHANGE: '+JSON.stringify(changes.get(r.id))+'; relevance and valid acceptance are not established.')
    const t=r.tests;if(!t)continue
    if(t.execution)lines.push(`  build=${t.execution.build}; tests=${t.execution.tests}; mode=${t.execution.mode}`)
    if(t.streamComplete)lines.push(`  Complete streamed counts: ${JSON.stringify(t.streamCounts)}; omitted inline names=${t.omittedCases}; set=${t.caseSetSha256}`)
    if(t.aggregateComplete&&!t.complete)lines.push('  Runner aggregate is complete; named case coverage is not complete.')
    lines.push(`  ${t.runner} observed named cases: passed=${t.counts.passed} failed=${t.counts.failed} skipped=${t.counts.skipped} disabled=${t.counts.disabled}${t.counts.ignored!==undefined?`; ignored=${t.counts.ignored}`:''}${t.counts.todo!==undefined?`; todo=${t.counts.todo}`:''}; completeObservedSet=${t.complete}; selection=${t.selection}`)
    if(t.summary&&!t.complete)lines.push(`  Runner aggregate (not a complete named set): total=${t.summary.total}, failed=${t.summary.failed}.`)
    for(const e of t.expectations.filter(e=>!e.observed))lines.push(`  NOT OBSERVED ${JSON.stringify(e.name)} (${e.origin}); ${t.complete?'selection gap':'incomplete output, absence is unknown'}`)
    for(const e of t.expectations.filter(e=>e.states&&(e.states.failed||e.states.skipped||e.states.disabled||e.states.ignored||e.states.todo)))lines.push(`  Expected selection ${JSON.stringify(e.name)} includes nonpassing states: ${JSON.stringify(e.states)}`)
    for(const c of t.cases.filter(c=>c.state!=='passed').slice(0,compact?8:64))lines.push(`  ${c.state}: ${c.name}`)
    if(t.truncated||t.ambiguous)lines.push(t.streamComplete?'  Full stream counted; inline named view is bounded.':'  Partial/ambiguous runner output; no complete-set assertion.')
  }
  const footer='Facts are historical to each execution. Unobserved scope and dependency completeness remain unknown; a pause never triggers more work.'
  const prefix=heading.join('\n'),details=lines.join('\n')
  return [prefix,compact?boundedOutput(details,VALIDATION_LIMITS.promptChars-prefix.length-footer.length-2):details,footer].filter(Boolean).join('\n')
}
