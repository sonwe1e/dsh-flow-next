import { createHash } from 'node:crypto'
import { z } from 'zod'
import { boundedOutput } from './check-evidence.js'

export const FLOW_TASK_KEY='flow_task_links'
export const FLOW_TASK_SOURCE='flow-task-link'
export const FLOW_TASK_REVISION='native-plan-obligations-v2'
export const TASK_LIMITS=Object.freeze({items:64,links:64,artifacts:8,checks:8,promptChars:1800,eventChars:12000,amendments:32})
const id=z.string().regex(/^[a-f0-9]{16}$/),seq=z.number().int().nonnegative()
const goalRef=z.object({id:z.string().max(240),revision:seq}).strict().nullable()
const verification=z.enum(['unspecified','required','deferred','not-needed'])
const link=z.object({key:id,planSeq:seq,turn:seq,goal:goalRef,artifacts:z.array(z.object({path:z.string().max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict()).max(TASK_LIMITS.artifacts),
  checks:z.array(id).max(TASK_LIMITS.checks),verification,requiredEver:z.boolean().default(false),reason:z.string().max(600),gap:z.string().max(600),nextAction:z.string().max(600),sourceSeq:seq}).strict()
const amendment=z.object({key:id,goal:goalRef,turn:seq,previous:verification,next:verification,reason:z.string().max(600),seq}).strict()
export const taskStateSchema=z.object({turn:seq,planTurn:seq.nullable(),planSeq:seq.nullable(),goal:goalRef,planGoal:goalRef,goalEpoch:seq,planEpoch:seq,goalObjectiveSha256:z.string().nullable(),
  items:z.array(z.object({key:id,content:z.string().max(600),status:z.enum(['pending','in_progress','completed'])}).strict()).max(TASK_LIMITS.items),
  omitted:seq,links:z.array(link).max(TASK_LIMITS.links),amendments:z.array(amendment).max(TASK_LIMITS.amendments),omittedAmendments:seq,surfaceSeq:seq.nullable()}).strict()
export const initialTaskState=()=>({turn:0,planTurn:null,planSeq:null,goal:null,planGoal:null,goalEpoch:0,planEpoch:0,goalObjectiveSha256:null,items:[],omitted:0,links:[],amendments:[],omittedAmendments:0,surfaceSeq:null})
const keyOf=content=>createHash('sha256').update(content).digest('hex').slice(0,16)
export const taskGoalRef=goal=>goal?{id:String(goal.id),revision:goal.revision}:null
const sameGoal=(a,b)=>a===null&&b===null||a!==null&&b!==null&&a.id===b.id&&a.revision===b.revision
const activePlan=(state,goal)=>state.planSeq!==null&&state.planEpoch===state.goalEpoch&&sameGoal(state.planGoal,state.goal)&&
  (goal?state.goal?.id===String(goal.id):state.goal===null&&state.planTurn===state.turn)

// Consume the host's durable goal/todo events. Pausing/resuming a goal changes
// its control revision, not the objective epoch to which a plan belongs.
export function foldTask(state,event){
  if(event.type==='turn/start')return {...state,turn:event.data?.turn??state.turn}
  if(event.type==='goal/change'){
    const change=event.data
    if(change.operation==='clear')return {...state,goal:null,goalObjectiveSha256:null,goalEpoch:event.seq,links:[],amendments:[]}
    if(['create','edit'].includes(change.operation)){
      const objective=createHash('sha256').update(change.goal.objective??'').digest('hex')
      if(change.operation==='edit'&&state.goal?.id===String(change.goal.id)&&state.goalObjectiveSha256===objective)return state
      return {...state,goal:taskGoalRef(change.goal),goalObjectiveSha256:objective,goalEpoch:event.seq,links:[],amendments:[]}
    }
    return state
  }
  if(event.type==='todo/write'){
    const all=event.data?.todos
    if(!Array.isArray(all))return state
    const selected=[...all.filter(item=>item.status==='in_progress'),...all.filter(item=>item.status==='pending'),...all.filter(item=>item.status==='completed')].slice(0,TASK_LIMITS.items)
    return {...state,planSeq:event.seq,planTurn:state.turn,planGoal:state.goal,planEpoch:state.goalEpoch,
      links:state.links.filter(row=>sameGoal(row.goal,state.goal)&&(state.goal!==null||row.turn===state.turn)),
      items:selected.map(item=>({key:keyOf(item.content),content:boundedOutput(item.content,600),status:item.status})),omitted:Math.max(0,all.length-selected.length)}
  }
  if(event.type!=='developer/message'||event.data?.message?.source?.kind!==FLOW_TASK_SOURCE)return state
  const blocks=event.data.message.content
  if(blocks?.length!==1||blocks[0].type!=='text'||blocks[0].text.length>TASK_LIMITS.eventChars)throw new Error('Invalid task link checkpoint')
  const value=link.omit({sourceSeq:true}).parse(JSON.parse(blocks[0].text))
  if(value.planSeq!==state.planSeq||value.turn!==state.turn||!state.items.some(item=>item.key===value.key))throw new Error('Task link does not belong to the current native plan')
  const previous=state.links.find(row=>row.key===value.key&&sameGoal(row.goal,value.goal)),changed=previous&&previous.verification!==value.verification
  if(previous?.requiredEver&&changed&&value.verification!=='required'&&!value.reason.trim())throw new Error('Withdrawing required verification needs an amendment reason')
  value.requiredEver ||= value.verification==='required'||Boolean(previous?.requiredEver)
  const amendments=changed?[...state.amendments,{key:value.key,goal:value.goal,turn:value.turn,previous:previous.verification,next:value.verification,reason:value.reason,seq:event.seq}]:state.amendments
  const links=[...state.links.filter(item=>item.key!==value.key),{...value,sourceSeq:event.seq}]
  if(links.length>TASK_LIMITS.links)throw new Error('Task link limit reached; prior obligations cannot be silently evicted')
  return {...state,links,amendments:amendments.slice(-TASK_LIMITS.amendments),omittedAmendments:state.omittedAmendments+Math.max(0,amendments.length-TASK_LIMITS.amendments),surfaceSeq:event.seq}
}

const request=z.object({action:z.literal('link'),item:id,artifacts:z.array(z.string().min(1).max(4096)).max(TASK_LIMITS.artifacts).optional(),
  checks:z.array(id).max(TASK_LIMITS.checks).optional(),verification:verification.optional(),reason:z.string().max(600).optional(),gap:z.string().max(600).optional(),nextAction:z.string().max(600).optional()}).strict()
export async function taskLink(state,args,{goal,goalAvailable=true,ledger,findCheck}){
  const input=request.parse(args),item=state.items.find(item=>item.key===input.item)
  if(!goalAvailable||!item||!activePlan(state,goal))throw new Error('Select a current native todo under the current goal/turn; historical plans must be rewritten with todo_write')
  const old=state.links.find(row=>row.key===item.key),previous=old&&sameGoal(old.goal,state.planGoal)&&(state.planGoal!==null||old.turn===state.turn)?old:null
  const verification=input.verification??previous?.verification??'unspecified',reason=input.reason??previous?.reason??''
  if(previous?.requiredEver&&verification!==previous.verification&&verification!=='required'&&!input.reason?.trim())throw new Error('Withdrawing required verification needs a new amendment reason; the obligation remains visible')
  if(['deferred','not-needed'].includes(verification)&&!reason.trim())throw new Error('Deferred or unnecessary verification needs a reason; it does not certify completion')
  let artifacts=previous?.artifacts??[]
  if(input.artifacts!==undefined){
    const paths=[...new Set(input.artifacts.map(file=>ledger?.fileName(file)))]
    if(paths.some(file=>!file||!ledger.files.has(file)))throw new Error('Artifacts must be workspace files already observed through permitted native tools')
    const hashes=paths.length?await ledger.snapshot(paths):{}
    artifacts=paths.map(path=>({path,sha256:hashes[path]??null}))
  }
  const checks=[...new Set(input.checks??previous?.checks??[])]
  if(checks.some(id=>!findCheck(id)))throw new Error('Check links require an observed same-session check id')
  return link.omit({sourceSeq:true}).parse({key:item.key,planSeq:state.planSeq,turn:state.turn,goal:state.planGoal,artifacts,checks,verification,
    requiredEver:verification==='required'||Boolean(previous?.requiredEver),reason,gap:input.gap??previous?.gap??'',nextAction:input.nextAction??previous?.nextAction??''})
}

export async function taskView(state,{goal,goalAvailable=true,ledger,findCheck}){
  const planApplicable=goalAvailable&&activePlan(state,goal),applies=row=>sameGoal(row.goal,state.planGoal)&&(state.planGoal!==null||row.turn===state.turn)
  const annotations=state.links.filter(applies),paths=[...new Set(annotations.flatMap(row=>row.artifacts.map(file=>file.path)))],observed=paths.filter(file=>ledger?.files.has(file)),hashes={}
  for(let offset=0;offset<observed.length;offset+=24)Object.assign(hashes,await ledger.snapshot(observed.slice(offset,offset+24)))
  const checked=new Map()
  for(const checkId of new Set(annotations.flatMap(row=>row.checks)))checked.set(checkId,await ledger?.revalidate?.(checkId))
  const items=state.items.map(item=>{
    const stored=state.links.find(row=>row.key===item.key),annotation=stored&&planApplicable&&applies(stored)?stored:null
    const artifacts=(annotation?.artifacts??[]).map(file=>({...file,currentSha256:hashes[file.path]??null,
      state:file.sha256&&hashes[file.path]?file.sha256===hashes[file.path]?'observed-unchanged':'changed':'unknown',review:'not-established'}))
    const checks=(annotation?.checks??[]).map(id=>{
      const receipt=findCheck(id),live=checked.get(id)??ledger?.last?.find(row=>row.checkId===id)
      return receipt?{id,state:receipt.state,originSessionId:receipt.originSessionId??null,freshness:live?.freshness??'historical-not-revalidated',
        scopeLimited:Boolean(receipt.aggregate||live?.laterEditedFiles?.length||live?.omittedInputs?.length),runner:receipt.tests?.runner??null,
        completeObservedSet:receipt.tests?.complete??false}: {id,state:'unavailable',freshness:'unknown'}
    })
    let evidence='no-check-linked'
    if(checks.length){
      if(checks.some(check=>['failed','reported-test-failure','reported-diagnostic-failure'].includes(check.state)))evidence='check-failed'
      else if(checks.some(check=>check.state!=='exited-zero'))evidence='incomplete'
      else if(checks.some(check=>check.freshness!=='observed-inputs-unchanged'||check.scopeLimited))evidence='historical-or-unknown'
      else evidence='observed-checks-pass'
    }
    if(artifacts.some(file=>file.state==='changed'))evidence='artifact-changed'
    else if(artifacts.some(file=>file.state==='unknown')&&evidence==='observed-checks-pass')evidence='artifact-unknown'
    return {...item,annotationSourceSeq:annotation?.sourceSeq??null,planLinkSeq:annotation?.planSeq??null,goalLinkMismatch:Boolean(stored&&!annotation),
      verification:annotation?.verification??'unspecified',requiredEver:annotation?.requiredEver??false,reason:annotation?.reason??'',gap:annotation?.gap??'',nextAction:annotation?.nextAction??'',artifacts,checks,evidence}
  })
  const active=items.filter(item=>item.status==='in_progress'),pending=items.filter(item=>item.status==='pending')
  const missing=items.filter(item=>item.requiredEver&&(item.verification!=='required'||item.status==='completed'&&item.evidence!=='observed-checks-pass'))
  const removed=planApplicable?annotations.filter(row=>row.requiredEver&&!items.some(item=>item.key===row.key)).map(row=>({key:row.key,verification:row.verification,reason:row.reason,sourceSeq:row.sourceSeq})):[]
  const canAct=planApplicable&&(!goal||goal.phase==='active')
  const next=(canAct?[...missing,...active,...pending].filter((item,i,all)=>all.findIndex(row=>row.key===item.key)===i):[]).slice(0,3).map(item=>({item:item.key,content:item.content,
    reason:missing.includes(item)?'required-evidence-missing':item.status,suggestedAction:item.nextAction||item.gap||null}))
  return {provenance:'Native goal/todo state plus agent-authored links; observed checks do not certify product acceptance',
    goal:goal?{...taskGoalRef(goal),objective:boundedOutput(goal.objective,2000),phase:goal.phase}:null,goalAvailable,planSeq:state.planSeq,planCurrentTurn:state.planTurn===state.turn,planApplicable,
    counts:{pending:pending.length,inProgress:active.length,completed:items.filter(item=>item.status==='completed').length,requiredEvidenceMissing:missing.length+removed.length},
    removedRequired:removed,amendments:state.amendments.filter(row=>sameGoal(row.goal,state.planGoal)&&(state.planGoal!==null||row.turn===state.turn)),omittedAmendments:state.omittedAmendments,omitted:state.omitted,items,next,acceptance:'not-certified'}
}

export function renderTaskView(view){
  if(!view.goal&&(!view.items.length||!view.planCurrentTurn))return ''
  const lines=['Flow task state: native plan; links are agent declarations, checks are observations.']
  if(view.goal)lines.push(`Goal ${view.goal.phase}: ${boundedOutput(view.goal.objective,240)}`)
  lines.push(`Native todos: pending=${view.counts.pending}, active=${view.counts.inProgress}, completed=${view.counts.completed}; required evidence missing=${view.counts.requiredEvidenceMissing}; removed required=${view.removedRequired.length}; omitted=${view.omitted}.`)
  if(!view.planApplicable)lines.push('Historical plan: its goal/turn does not match. No next action is inferred; use native todo_write to adopt a current plan.')
  for(const row of view.amendments.slice(-3))lines.push(`Verification amendment ${row.key}: ${row.previous}->${row.next}; ${boundedOutput(row.reason,100)}`)
  for(const row of view.removedRequired.slice(0,3))lines.push(`Removed required todo ${row.key}; no acceptance established.`)
  for(const candidate of view.next){const item=view.items.find(row=>row.key===candidate.item);lines.push(`${item.key} ${item.status}; evidence=${item.evidence}; ${boundedOutput(item.content,160)}${candidate.suggestedAction?`; next=${boundedOutput(candidate.suggestedAction,120)}`:''}`)}
  if(view.goal&&view.goal.phase!=='active')lines.push('Native goal is not active. No next action, resume or scheduling is requested by this view.')
  return boundedOutput(lines.join('\n'),TASK_LIMITS.promptChars)
}

export const FLOW_TASK_PARAMETERS={
  action:{type:'string',enum:['status','link'],required:true},item:{type:'string',description:'link: exact current native todo key from status.'},
  artifacts:{type:'array',items:{type:'string'},description:'link: replace artifact links with up to 8 already observed workspace files; [] clears links.'},
  checks:{type:'array',items:{type:'string'},description:'link: replace check links with up to 8 native check ids; [] clears links.'},
  verification:{type:'string',enum:['unspecified','required','deferred','not-needed'],description:'link: declaration, never acceptance. Withdrawing required verification needs a new reason and remains visible.'},
  reason:{type:'string',description:'link: decision or amendment basis, at most 600 characters.'},gap:{type:'string',description:'link: remaining uncertainty, at most 600 characters.'},
  nextAction:{type:'string',description:'link: next useful action, at most 600 characters. Nothing is executed.'},
  offset:{type:'integer',description:'status: zero-based page offset, default 0.'},limit:{type:'integer',description:'status: page size 1..20, default 10.'},
}
