import { defineTool,renderToolsSdk,renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import { createDeveloperMessage,createUserMessage } from '@deepseek-ai/dsh-llm'
import { createFlowCoordination } from '../lib/flow-coordination.js'
import { AdaptiveFlow } from '../lib/flow-adaptive.js'
import { presentationInstaller } from './flow-adaptive-policy.js'
import { createEvidenceObserver } from './flow-evidence-policy.js'
import { FLOW_NEXT_VERSION,FLOW_NEXT_CONFIGURATION,FLOW_NEXT_KEY,FLOW_NEXT_SOURCE,FLOW_NEXT_POLICY,
  nextStateSchema,initialNextState,foldNextState,nextCheckpointEvents,renderNextSupport,nextSupportSignature } from '../lib/flow-next.js'
import { FLOW_CHECK_SOURCE,FLOW_CHECK_PARAMETERS,readCheckProtocol,serializeCheckProtocol,updateCheckProtocol,renderCheckProtocol } from '../lib/flow-check-protocol.js'
import { FLOW_VALIDATION_KEY,validationStateSchema,initialValidationState,foldValidation,renderValidationReport,
  FLOW_VALIDATION_INDEX_KEY,validationIndexSchema,initialValidationIndex,foldValidationIndex,validationIndexViewSchema,validationIndexView } from '../lib/flow-validation.js'
import { createValidationState } from './flow-validation-state.js'
import { FLOW_TASK_KEY,FLOW_TASK_PARAMETERS,taskStateSchema,initialTaskState,foldTask } from '../lib/flow-task.js'
import { createTaskState } from './flow-task-state.js'
import { FLOW_RUN_CHECK_PARAMETERS,createCheckResources } from '../lib/flow-check-run.js'
import { createCheckRunner } from './flow-check-runner.js'
import { createStageState } from './flow-stage-state.js'
import { FLOW_STAGE_KEY,stageStateSchema,initialStageState,foldStage,renderStageReport } from '../lib/flow-stage.js'
import path from 'node:path'

const hosts=new WeakMap()
function sharedHost(ctx){
  let shared=hosts.get(ctx.root)
  if(!shared){
    shared={resources:createCheckResources(),ledgers:new Set(),users:0}
    const stopTools=ctx.root.on('tools/result',(exec,result)=>{
      if(result.isError||!['write','edit'].includes(exec.name)||typeof exec.arguments?.file_path!=='string'||!exec.agent)return
      const file=path.resolve(exec.agent.session.header.cwd,exec.arguments.file_path)
      for(const ledger of shared.ledgers)ledger.observeExternalEdit(file)
    })
    const stopJobs=ctx.root.get('jobs')?.events?.subscribe({owners:'scope'},event=>{
      if(event.type==='settled'&&event.job?.owner)shared.resources.releaseJob(event.job.owner,event.job.id)
    })
    shared.stop=()=>{stopTools();stopJobs?.()}
    hosts.set(ctx.root,shared)
  }
  shared.users++
  ctx.effect(()=>()=>{if(--shared.users===0){shared.stop();hosts.delete(ctx.root)}})
  return shared
}

export const name='flow-next-policy'
export const inject=['tools','systemPrompt','sessionProjections','commands']
export function apply(ctx) {
  const projections=ctx.get('sessionProjections'),tools=ctx.get('tools'),prompt=ctx.get('systemPrompt')
  projections.register({key:FLOW_NEXT_KEY,stateSchema:nextStateSchema,init:initialNextState,apply:foldNextState,stateVersion:1})
  projections.register({key:FLOW_VALIDATION_KEY,stateSchema:validationStateSchema,init:initialValidationState,apply:foldValidation,stateVersion:3})
  projections.register({key:FLOW_VALIDATION_INDEX_KEY,stateSchema:validationIndexSchema,init:initialValidationIndex,apply:foldValidationIndex,stateVersion:1,
    wire:{viewSchema:validationIndexViewSchema,view:validationIndexView}})
  projections.register({key:FLOW_TASK_KEY,stateSchema:taskStateSchema,init:initialTaskState,apply:foldTask,stateVersion:2})
  projections.register({key:FLOW_STAGE_KEY,stateSchema:stageStateSchema,init:initialStageState,apply:foldStage,stateVersion:1,
    wire:{viewSchema:stageStateSchema,view:state=>state}})
  const controllers=new WeakMap(),live=new Set(),shared=sharedHost(ctx),resources=shared.resources
  const stateOf=agent=>projections.stateOf(agent.session,FLOW_NEXT_KEY)
  const forAgent=agent=>{
    if(!agent?.session)return null
    if(controllers.has(agent))return controllers.get(agent)
    const pending=[]
    const record=checkpoint=>{
      const state=stateOf(agent)
      if(!state.openStep){pending.push(checkpoint);return}
      agent.session.append('developer/message',{turn:state.turn,step:state.step,
        message:createDeveloperMessage({source:{kind:FLOW_NEXT_SOURCE},content:[{type:'text',text:JSON.stringify(checkpoint)}]})},{surfaceOp:'append'})
    }
    const controller=new AdaptiveFlow({events:()=>nextCheckpointEvents(stateOf(agent)),progress:()=>stateOf(agent),
      config:FLOW_NEXT_POLICY,record,install:presentationInstaller(agent.ctx,agent),available:target=>{
        if(target.capabilities!=='full')return 'Flow Next keeps full capabilities; choose full'
        try{if(target.presentation==='ptc')tools.requirePtcRuntime('ptc')}catch(error){return error.message}
      }})
    if(controller.state.current.capabilities!=='full'||controller.state.pending?.target.capabilities==='local') {
      controller.dispose();throw new Error('Flow Next cannot restore a narrowed capability checkpoint')
    }
    const validation=createValidationState(agent,projections,()=>stateOf(agent))
    const evidence=createEvidenceObserver(agent,{configuration:FLOW_NEXT_CONFIGURATION,collectTests:true,onRecord:validation.record,
      support:ledger=>renderNextSupport(stateOf(agent),ledger),supportSignature:ledger=>nextSupportSignature(stateOf(agent),ledger),
      protocol:()=>readCheckProtocol(stateOf(agent).checkProtocol)})
    shared.ledgers.add(evidence.ledger)
    const task=createTaskState(agent,projections,()=>stateOf(agent),{ledger:evidence?.ledger,findCheck:validation.find})
    const runner=createCheckRunner(agent,{tools,evidence,validation,resources,jobs:agent.ctx.get('jobs')})
    const stage=createStageState(agent,{validation,evidence,task,subagents:agent.ctx.get('subagents'),query:agent.ctx.get('sessionQuery'),agents:agent.ctx.get('agents')})
    const coordination=createFlowCoordination({agent,jobs:agent.ctx.get('jobs'),subagents:agent.ctx.get('subagents'),
      teams:agent.ctx.get('agentTeams'),agents:agent.ctx.get('agents'),on:(...args)=>ctx.root.on(...args),
      context:text=>createUserMessage({source:{kind:'flow-coordination'},content:[{type:'text',text}]}),toolFor:name=>tools.get(name,agent)})
    let disposed=false,stopSelection,stopLifetime
    const value={controller,evidence,coordination,validation,task,runner,stage,finals:new WeakSet(),flush:()=>{for(const checkpoint of pending.splice(0))record(checkpoint)},
      dispose:()=>{if(disposed)return;disposed=true;controller.dispose();coordination.dispose();runner.dispose();validation.dispose();shared.ledgers.delete(evidence.ledger);stopSelection?.();stopLifetime?.();pending.length=0;live.delete(value);controllers.delete(agent)}}
    controllers.set(agent,value);live.add(value)
    // A preset generation is shared by multiple Agents. Presentation belongs
    // to the individual Agent, and explicit disposers bind it to BOTH lives.
    stopSelection=agent.ctx.on('session/event',(session,event)=>{
      if(session===agent.session)coordination.observe(event)
      if(session===agent.session&&(event.type==='assistant/attempt'||event.type==='assistant/message'&&
        (event.data?.message?.source?.kind==='model'||event.data?.message?.source?.provider)))evidence?.acknowledgeRequest()
      if(session===agent.session&&event.type==='agent-preset/selected'&&event.data?.agentPreset!=='flow-next')value.dispose()
    })
    stopLifetime=agent.ctx.effect(()=>()=>value.dispose())
    return value
  }
  ctx.effect(()=>()=>{for(const value of [...live])value.dispose()})
  // Variables run before tool providers; laziness covers direct mount and
  // preset selection AFTER Agent creation, without escaping the preset scope.
  prompt.variable('flow_next_boundary',({scope})=>forAgent(scope)?.controller.boundary()??'')
  prompt.context({name:'flow:next-interface',order:50,text:({scope})=>forAgent(scope)?.controller.status()??''})
  ctx.on('agent/request',async ({agent},next)=>{
    const value=forAgent(agent);value?.flush();await value?.evidence?.settle()
    // Assembly precedes step/start; request admission is the first legal native
    // boundary for repairing a restored/forked surface before model dispatch.
    value?.validation.flush(value.evidence?.ledger);return next()
  })
  ctx.on('agent/pre-step',async ({agent},next)=>{
    const decision=await next(),value=forAgent(agent)
    if(value&&tools.modeFor(agent)!==value.controller.state.current.presentation)throw new Error('Flow Next interface drift detected')
    return decision
  })
  ctx.on('tools/execute',async (exec,next)=>{
    const value=forAgent(exec.agent);await value?.evidence?.before(exec);value?.validation.flush(value.evidence?.ledger)
    const planned=value?.evidence?.ledger.pending.get(exec.callId)
    if(planned?.binding&&Object.keys(planned.binding.inputBefore).some(file=>planned.binding.inputBefore[file]!==planned.before[file]))throw new Error('Check inputs changed during admission; no process was launched. Read current inputs and retry.')
    const result=await (value?.coordination?value.coordination.execute(exec,next):next())
    if(value&&!value.finals.has(exec)){value.finals.add(exec);value.evidence.after(exec,result)}
    await value?.evidence?.settle()
    await value?.runner.recover(exec,result)
    value?.validation.flush(value.evidence?.ledger)
    return result
  })
  ctx.on('tools/result',(exec,result)=>{const value=forAgent(exec.agent);if(value&&!value.finals.has(exec)){value.finals.add(exec);value.evidence.after(exec,result)}})
  ctx.on('agent/turn-stopping',async({agent})=>{
    const value=forAgent(agent);await value?.evidence?.settle()
    // Never inject, conclude, retry, or wake a child from this hook.
  })
  ctx.on('system-prompt/assemble',async (_assembly,context,next)=>{
    const original=await next(),value=forAgent(context.scope)
    const assembly=value?.coordination.assemble(original,{sdkSchemas:()=>tools.sdkSchemas(context.scope),renderSdk:schemas=>{
      const runtime=tools.requirePtcRuntime(tools.modeFor(context.scope));return(runtime.language==='python'?renderToolsSdkPy:renderToolsSdk)(schemas)
    }})??original
    if(!value?.evidence)return assembly
    const observed=await value.evidence.assemble(assembly)
    value.validation.flush(value.evidence.ledger)
    const protocol=renderCheckProtocol(readCheckProtocol(stateOf(context.scope).checkProtocol),value.evidence.ledger)
    const task=await value.task.context()
    return {...observed,contexts:[...observed.contexts,...(protocol?[{name:'flow:check-protocol',order:91,text:protocol}]:[]),
      ...(task?[{name:'flow:task-state',order:87,text:task}]:[])]}
  })
  tools.register(defineTool({name:'flow_task',description:'Read the native goal/todo view, or attach observed artifact/check references, remaining gaps and a next action to an existing native todo. status is paginated; link records agent declarations in the native session. Use todo_write for plan changes. No action creates a goal, runs checks, changes todo completion or certifies acceptance.',
    parameters:FLOW_TASK_PARAMETERS,isConcurrencySafe:()=>false,
    execute:async(args,exec)=>{
      const value=forAgent(exec.agent)
      if(!value)return{text:JSON.stringify({accepted:false,reason:'No current Flow Next Agent'})}
      try{await value.evidence?.settle();value.validation.flush(value.evidence?.ledger)
        return{text:JSON.stringify({accepted:true,...await value.task.execute(args)})}
      }catch(error){return{text:JSON.stringify({accepted:false,reason:error.message})}}
    },output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]}}))
  tools.register(defineTool({name:'flow_run_check',description:'Execute one check with inputs and expected names bound to the actual native call. Inputs are acquired through native read permissions; shell guards, restrictions, background jobs and cancellation remain native. Emit runner stdout; only producer-owned native spills can complete truncated output. Definitions and removed expectations are recorded as amendments. A busy resource joins only your owned native job and does not execute the newly requested check. No action certifies product acceptance.',
    parameters:FLOW_RUN_CHECK_PARAMETERS,isConcurrencySafe:()=>false,
    execute:async(args,exec)=>{try{return {text:JSON.stringify(await forAgent(exec.agent).runner.run(args,exec))}}catch(error){return {text:JSON.stringify({accepted:false,launched:null,reason:error.message})}}},
    output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]}}))
  tools.register(defineTool({name:'flow_stage',description:'Read a host-generated stage report with native per-run totals, failed/skipped/disabled/unknown distinctions, source ids, validation changes and required-task gaps. Optional exact direct-child ids are checked against the native parent catalog and observed without resuming children; child facts remain distinct historical executions. Never certifies semantic coverage, baseline causality or visual review. Simple questions need no report.',
    parameters:{children:{type:'array',items:{type:'string'},description:'Optional up to 8 exact native direct-child ids; foreign children are rejected before session reads.'}},isConcurrencySafe:()=>false,
    execute:async(args,exec)=>{try{if(Object.keys(args).some(key=>key!=='children'))throw new Error('Unexpected stage parameter');return {text:JSON.stringify(await forAgent(exec.agent).stage.report(args,exec.signal))}}catch(error){return {text:JSON.stringify({accepted:false,reason:error.message})}}},
    output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]}}))
  tools.register(defineTool({name:'flow_select',description:'Choose native or PTC for the next request in this same task. Use PTC for already determined operations or result curation; retain native for direct work. Current-batch operations keep their interface. Full capabilities and permissions remain. A failing test alone is not a reason to switch. Inspect acceptance, cooldown and session budget.',
    parameters:{presentation:{type:'string',enum:['native','ptc'],required:true},capabilities:{type:'string',enum:['full'],required:true},
      reason:{type:'string',required:true,description:'Concrete useful next operation; at most 240 characters.'}},isConcurrencySafe:()=>false,
    execute:(args,exec)=>({text:JSON.stringify(forAgent(exec.agent)?.controller.select({presentation:args.presentation,capabilities:args.capabilities},args.reason)??{accepted:false,reason:'No current Agent'})}),
    output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]}}))
  tools.register(defineTool({name:'flow_check',description:'Inspect native execution evidence or retain prospective scope. history pages same-session check locations, including older checkpoints, with optional command/file filters. report retrieves one exact check id or the recent window and can compare historical named test states. classify annotates live failures; coverage and scope remain agent declarations. No action runs checks or certifies product acceptance. Simple work needs no protocol.',
    parameters:FLOW_CHECK_PARAMETERS,isConcurrencySafe:()=>false,
    execute:async(args,exec)=>{
      const value=forAgent(exec.agent)
      if(!value?.evidence)return{text:JSON.stringify({accepted:false,reason:'No current Flow Next evidence observer'})}
      try{
        await value.evidence.settle()
        value.validation.flush(value.evidence.ledger)
        if(args.action==='history'){
          if(Object.keys(args).some(k=>!['action','cursor','limit','query','file','fingerprint'].includes(k)))throw new Error('Unexpected history parameter')
          const {action,...query}=args
          return{text:JSON.stringify({accepted:true,observerAvailable:value.evidence.available,...value.validation.history(query)})}
        }
        if(args.action==='report'){
          if(Object.keys(args).some(k=>!['action','checkId','claims'].includes(k)))throw new Error('Unexpected report parameter')
          return{text:JSON.stringify({accepted:true,observerAvailable:value.evidence.available,...value.validation.report(value.evidence.ledger,args)})}
        }
        const state=stateOf(exec.agent),previous=readCheckProtocol(state.checkProtocol)
        const next=updateCheckProtocol(previous,args,value.evidence.ledger)
        if(args.action!=='status'){
          if(!state.openStep)throw new Error('Check declarations must be recorded during the current tool step')
          exec.agent.session.append('developer/message',{turn:state.turn,step:state.step,
            message:createDeveloperMessage({source:{kind:FLOW_CHECK_SOURCE},content:[{type:'text',text:serializeCheckProtocol(next)}]})},{surfaceOp:'append'})
          await value.evidence.settle()
        }
        return{text:JSON.stringify({accepted:true,provenance:'Agent declarations; execution states are observations, not acceptance.',
          latestChecks:(value.evidence.ledger.last??[]).map(r=>({id:r.checkId,state:r.state,freshness:r.freshness,
            toolName:r.toolName,callId:r.callId,rootCallId:r.rootCallId,jobId:r.jobId,exitCode:r.exitCode,
            statusGranularity:r.statusGranularity,scopeKind:r.scopeKind,files:Object.keys(r.files)})),
          unresolvedChecks:value.evidence.ledger.unresolved.slice(-8).map(r=>({id:r.checkId,state:r.state,
            toolName:r.toolName,callId:r.callId,rootCallId:r.rootCallId,jobId:r.jobId,exitCode:r.exitCode,
            assessment:value.evidence.ledger.assessmentFor(r)?.category})),
          ...(args.action==='status'?{records:next}:{}),
          protocol:renderCheckProtocol(next,value.evidence.ledger)})}
      }catch(error){return{text:JSON.stringify({accepted:false,reason:error.message})}}
    },output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]}}))
  ctx.get('commands').register({name:'flow-next',description:'Show Flow Next version, current interface and selection budget',recordInput:false,
    handler:async invocation=>{
      if(String(invocation.rawInput??'').trim()&&!['status','report','task','history','stage'].includes(String(invocation.rawInput).trim()))return {kind:'error',text:'Usage: /flow-next [status|report|task|history|stage]'}
      const value=forAgent(invocation.agent)
      if(value&&String(invocation.rawInput??'').trim()==='stage')return {kind:'success',text:renderStageReport(await value.stage.report({},invocation.signal))||'No observed checks or required-task gaps. No acceptance is certified.'}
      if(value&&String(invocation.rawInput??'').trim()==='task'){
        await value.evidence?.settle()
        return {kind:'success',text:JSON.stringify(await value.task.execute({action:'status'}),null,2)}
      }
      if(value&&String(invocation.rawInput??'').trim()==='history')return {kind:'success',text:JSON.stringify(value.validation.history(),null,2)}
      if(value&&String(invocation.rawInput??'').trim()==='report'){
        await value.evidence?.settle();value.validation.flush(value.evidence?.ledger)
        return{kind:'success',text:(value.evidence?.available===false?'Evidence observer unavailable; recent results may be missing.\n':'')+
          (renderValidationReport(value.validation.report(value.evidence?.ledger))||'No observed checks in this session. No acceptance is certified.')}
      }
      return value?{kind:'success',text:`Flow Next ${FLOW_NEXT_VERSION}\n${value.controller.status()}\nNative coordination: ${JSON.stringify(value.coordination.stats)}\nTrial mode; quality and efficiency improvements remain unmeasured.`}
        :{kind:'error',text:'No current Flow Next Agent'}
    }})
}
