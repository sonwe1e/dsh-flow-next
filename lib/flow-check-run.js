import { z } from 'zod'
import { createHash } from 'node:crypto'

const digest=z.string().regex(/^[a-f0-9]{64}$/),files=z.record(z.string().max(4096),digest.nullable())
export const checkBindingSchema=z.object({label:z.string().min(1).max(120),commandSha256:digest,resource:z.string().max(120).nullable(),
  environment:z.string().max(240),definitions:files,inputBefore:files,expectedTests:z.array(z.string().max(240)).max(64),amendmentReason:z.string().max(600),
  previousCheckId:z.string().regex(/^[a-f0-9]{16}$/).nullable(),changedDefinitions:z.array(z.string().max(4096)).max(24),removedExpectedTests:z.array(z.string().max(240)).max(64)}).strict()
export const runCheckRequest=z.object({label:z.string().trim().min(1).max(120),command:z.string().min(1).max(12000),toolName:z.enum(['pwsh','bash','shell']).optional(),
  workdir:z.string().max(4096).optional(),files:z.array(z.string().min(1).max(4096)).min(1).max(24),
  definitions:z.array(z.string().min(1).max(4096)).max(24).default([]),expectedTests:z.array(z.string().min(1).max(240)).max(64).default([]),
  resource:z.string().trim().min(1).max(120).optional(),environment:z.string().max(240).default('unknown'),amendmentReason:z.string().max(600).default(''),
  timeoutMs:z.number().int().positive().optional(),run_in_background:z.boolean().optional()}).strict()
export const commandDigest=command=>createHash('sha256').update(command).digest('hex')
export function compareCheckRuns(old,current){
  const identity=row=>[row.originSessionId??row.sessionId,row.toolName,row.cwd,row.commandSha256??row.binding?.commandSha256]
  if(!old||!identity(current)[3]||JSON.stringify(identity(old))!==JSON.stringify(identity(current)))return null
  const counts=row=>row.countsComplete?row.counts:row.tests?.streamComplete?row.tests.streamCounts:row.tests?.complete?row.tests.counts:row.tests?.aggregateComplete?row.tests.aggregateCounts:null
  const before=counts(old),after=counts(current),registered=row=>row.registered??row.tests?.registered??null
  const inputs=current.inputBefore??current.binding?.inputBefore??{}
  return {checkId:old.id,files:Object.keys(inputs).filter(file=>old.files?.[file]&&inputs[file]&&old.files[file]!==inputs[file]),
    registeredDelta:registered(old)!==null&&registered(current)!==null?registered(current)-registered(old):null,
    disabledDelta:before&&after?(after.disabled??0)-(before.disabled??0):null,skippedDelta:before&&after?(after.skipped??0)-(before.skipped??0):null,
    runnerSetChanged:(current.caseSetSha256??current.tests?.caseSetSha256)&&(old.caseSetSha256??old.tests?.caseSetSha256)&&before&&after?
      (current.caseSetSha256??current.tests.caseSetSha256)!==(old.caseSetSha256??old.tests.caseSetSha256):null,dependencyRelevance:'unknown'}
}
export const noteworthyCheckChange=change=>Boolean(change&&(change.files.length||change.disabledDelta>0||change.skippedDelta>0||change.registeredDelta<0))
export function checkBinding(args,{inputs,previous}){
  const definitions=Object.fromEntries(args.definitions.map(file=>[file,inputs[file]??null])),old=previous?.binding
  return checkBindingSchema.parse({label:args.label,commandSha256:commandDigest(args.command),resource:args.resource??null,environment:args.environment,
    definitions,inputBefore:inputs,expectedTests:args.expectedTests,amendmentReason:args.amendmentReason,previousCheckId:previous?.id??null,
    changedDefinitions:old?[...new Set([...Object.keys(old.definitions),...Object.keys(definitions)])].filter(file=>old.definitions[file]!==definitions[file]):[],
    removedExpectedTests:old?old.expectedTests.filter(name=>!args.expectedTests.includes(name)):[]})
}
export const FLOW_RUN_CHECK_PARAMETERS={
  label:{type:'string',required:true,description:'Stable name for this check across retries; changes to definitions/expected tests are compared under this label.'},
  command:{type:'string',required:true,description:'Exact command to execute once through the native shell. Emit runner stdout; redirected/hidden output cannot certify inner statuses.'},
  files:{type:'array',required:true,items:{type:'string'},description:'1..24 workspace input files. Missing observations are acquired through the permission-checked native read tool before execution.'},
  definitions:{type:'array',items:{type:'string'},description:'Validator/test/allowlist definition files. Combined input set must fit 24; before/after changes remain visible.'},
  expectedTests:{type:'array',items:{type:'string'},description:'Up to 64 exact critical test names; missing, skipped and disabled remain distinct.'},
  toolName:{type:'string',enum:['pwsh','bash','shell'],description:'Visible native shell tool. Defaults to pwsh on Windows, bash elsewhere. Native guards and restrictions apply.'},
  workdir:{type:'string',description:'Workspace-relative native working directory.'},resource:{type:'string',description:'Optional shared resource key for cooperating checks in this workspace. Busy resources return the native owning job; no speculative second launch.'},
  environment:{type:'string',description:'Relevant toolchain/build/environment identity declaration. Unknown does not establish environment equivalence.'},
  amendmentReason:{type:'string',description:'Explain changes to earlier validation definitions or expected names; explanation never certifies acceptance.'},
  timeoutMs:{type:'integer',description:'Native foreground timeout; host limits and promotion semantics remain authoritative.'},
  run_in_background:{type:'boolean',description:'Native background launch; collect with job_output. No private polling loop or process cancellation.'},
}

// Reservations describe cooperating calls only; native jobs own waiting,
// cancellation and terminal state. Uninstrumented shell calls remain unknown.
export function createCheckResources(){
  const leases=new Map()
  return {
    acquire(key,owner,callId){const current=leases.get(key);if(current)return {acquired:false,...current};const lease={owner,callId,jobId:null};leases.set(key,lease);return {acquired:true,...lease}},
    bind(key,callId,jobId){const lease=leases.get(key);if(lease?.callId===callId)lease.jobId=jobId},
    release(key,callId){if(leases.get(key)?.callId===callId)leases.delete(key)},
    restore(key,lease){if(!leases.has(key))leases.set(key,lease)},
    releaseJob(owner,jobId){for(const [key,lease]of leases)if(lease.owner===owner&&lease.jobId===jobId)leases.delete(key)},
    disposeOwner(owner,{keepJobs=false}={}){for(const [key,lease]of leases)if(lease.owner===owner&&(!keepJobs||!lease.jobId))leases.delete(key)},
  }
}
