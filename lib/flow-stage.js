import { boundedOutput } from './check-evidence.js'
import { z } from 'zod'
import { FLOW_VALIDATION_SOURCE,validationPayloadSchema } from './flow-validation.js'
import { compareCheckRuns,noteworthyCheckChange } from './flow-check-run.js'

export const FLOW_STAGE_KEY='flow_stage_facts'
export const stageStateSchema=z.object({sessionId:z.string(),checks:z.array(z.json()).max(8),omitted:z.number().int().nonnegative()}).strict()
export const initialStageState=header=>({sessionId:header.id,checks:[],omitted:0})
export function foldStage(state,event){
  if(event.type!=='developer/message'||event.data?.message?.source?.kind!==FLOW_VALIDATION_SOURCE)return state
  const payload=validationPayloadSchema.parse(JSON.parse(event.data.message.content[0].text))
  return {...state,checks:stageReport({sessionId:state.sessionId,runs:payload.runs.map(row=>({...row,sourceEventSeq:event.seq}))}).checks.map(row=>{
    const {files,inputBefore,nonpassingObserved,...view}=row
    return {...view,observedFileCount:Object.keys(files).length,nonpassingObserved:nonpassingObserved.slice(0,16)}
  }),omitted:payload.omitted}
}

// Numeric delivery is computed from runner observations. Never add attempts,
// different snapshots or parent/child runs into a fictitious single test suite.
export function stageCheck(receipt,{originSessionId,currentSessionId,sourceEventSeq=null}={}){
  const tests=receipt.tests,stream=tests?.streamComplete,complete=Boolean(stream||tests?.complete||tests?.aggregateComplete)
  const raw=stream?tests.streamCounts:tests?.complete?tests.counts:tests?.aggregateComplete?tests.aggregateCounts:null
  const counts=raw?Object.fromEntries(['passed','failed','skipped','disabled','ignored','todo'].map(key=>[key,raw[key]??0])):null
  const expected=tests?.expectations??[],binding=receipt.binding
  const changedDuring=(binding?Object.keys(binding.definitions).filter(file=>binding.definitions[file]!==receipt.files?.[file]):[])
  return {id:receipt.id,sessionId:originSessionId??receipt.originSessionId??null,sourceEventSeq,callId:receipt.callId,rootCallId:receipt.rootCallId,jobId:receipt.jobId,
    label:binding?.label??null,command:receipt.command,cwd:receipt.cwd??null,toolName:receipt.toolName,commandSha256:receipt.commandSha256??binding?.commandSha256??null,state:receipt.state,exitCode:receipt.exitCode,
    origin:receipt.originSessionId===currentSessionId?'current-session':receipt.originSessionId?'other-session':'unknown',freshness:receipt.freshness??'historical-not-revalidated',
    counts,countsComplete:complete,observedCounts:tests?.counts??null,registered:tests?.registered??null,caseSetSha256:tests?.caseSetSha256??null,
    inlineNamesOmitted:tests?.omittedCases??0,execution:tests?.execution??null,selection:tests?.selection??'unknown',missingExpected:expected.filter(row=>!row.observed).map(row=>row.name),
    expectedResults:expected.map(row=>({name:row.name,match:row.match,observed:row.observed,states:row.states??null})),
    nonpassingObserved:(tests?.cases??[]).filter(row=>row.state!=='passed'),inputChangedDuringExecution:Boolean(receipt.changedDuringExecution),
    scope:receipt.scopeKind??'unknown',scopeLimited:Boolean(receipt.aggregate)||!binding,files:receipt.files??{},inputBefore:receipt.inputBefore??binding?.inputBefore??{},environment:binding?.environment??'unknown',
    validationChanges:binding?{previousCheckId:binding.previousCheckId,definitions:binding.changedDefinitions,removedExpectedTests:binding.removedExpectedTests,
      duringExecution:changedDuring,reason:binding.amendmentReason,acceptance:'not-certified'}:null,
    attribution:'unattributed; no same-configuration baseline proof is implied',artifactReview:'not-established',acceptance:'not-certified'}
}
export function stageReport({sessionId,runs=[],omitted=0,task=null,children=[],observerAvailable=true}){
  const rows=runs.map(row=>stageCheck(row,{currentSessionId:sessionId,sourceEventSeq:row.sourceEventSeq??null})),latest=new Map(),previous=new Map()
  for(const row of rows){
    const key=row.commandSha256?JSON.stringify([row.sessionId,row.toolName,row.cwd,row.commandSha256]):null,old=key?previous.get(key):null
    row.observedChangesSincePrior=compareCheckRuns(old,row)
    if(key)previous.set(key,row)
  }
  for(const row of rows)latest.set(row.label??row.id,row.id)
  return {provenance:'Host-derived native execution facts, not agent-written test totals',sessionId,observerAvailable,
    checks:rows.map(row=>({...row,latestForLabel:latest.get(row.label??row.id)===row.id})),omittedChecks:omitted,children,
    task:task?{goal:task.goal,planApplicable:task.planApplicable,counts:task.counts,removedRequired:task.removedRequired,amendments:task.amendments,
      omittedAmendments:task.omittedAmendments,omitted:task.omitted}:null,
    limits:'Attempts and child runs remain separate. Unknown scope, source/build/environment equivalence and semantic coverage are not certified.',acceptance:'not-certified'}
}
export function renderStageReport(report,{compact=false}={}){
  if(!report.checks.length&&!report.children.length&&!report.task?.counts.requiredEvidenceMissing)return ''
  const lines=['Flow 阶段执行事实（宿主生成；不认证需求完成）',`Observed checks=${report.checks.length}; omitted=${report.omittedChecks}; observer=${report.observerAvailable?'available':'unavailable'}.`]
  if(report.task)lines.push(`Required evidence missing=${report.task.counts.requiredEvidenceMissing}; removed required=${report.task.removedRequired.length}; verification amendments=${report.task.amendments.length}; omitted amendments=${report.task.omittedAmendments}.`)
  for(const row of (compact?report.checks.filter(row=>row.latestForLabel).slice(-4):report.checks)){
    lines.push(`${row.id}${row.label?' '+row.label:''}: ${row.state}; ${row.freshness}; ${row.counts?Object.entries(row.counts).map(([key,n])=>key+'='+n).join(' '):'counts unknown (partial or unsupported output)'}`)
    if(row.missingExpected.length)lines.push('  Missing expected: '+row.missingExpected.join(', ')+`; selection=${row.selection}`)
    if(row.execution?.mode==='build-only')lines.push('  Build-only: no test execution is established.')
    for(const e of row.expectedResults.filter(e=>e.states&&(e.states.failed||e.states.skipped||e.states.disabled||e.states.ignored||e.states.todo)))lines.push('  Expected selection '+e.name+': '+JSON.stringify(e.states))
    if(row.validationChanges&&(row.validationChanges.definitions.length||row.validationChanges.removedExpectedTests.length||row.validationChanges.duringExecution.length))lines.push('  VALIDATION CHANGED: '+JSON.stringify(row.validationChanges))
    if(row.inputChangedDuringExecution)lines.push('  Inputs changed during execution; this run does not verify the final tree.')
    const changes=row.observedChangesSincePrior
    if(noteworthyCheckChange(changes))lines.push('  OBSERVED CHANGE since '+changes.checkId+': '+JSON.stringify(changes)+'; not proof of a valid acceptance change.')
  }
  for(const child of report.children)lines.push(`Child ${child.sessionId}: ${child.error??'checks='+child.checks.length+'; activity='+child.activity+'; omitted='+child.omittedChecks}; native source retained; not a parent execution.`)
  lines.push('Runs are separate; skipped/disabled are not passed. Baseline attribution and visual review are not established by these counts.')
  return compact?boundedOutput(lines.join('\n'),1800):lines.join('\n')
}
