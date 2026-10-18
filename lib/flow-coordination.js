// Adapt the native control planes after tool guards; never own jobs, Agents,
// output cursors, mailboxes, model turns, or task-completion judgments here.
export const FLOW_COORDINATION_REVISION='native-jobs-adjacent-control-v2'
export const FLOW_POLL_WAIT_MS=30000
const active=job=>job?.status==='running'||job?.status==='stopping'
const fingerprint=job=>job?JSON.stringify([job.status,job.progress,job.detail,job.output?.total,job.output?.earliest]):null
const success=value=>({isError:false,value})
const controlParameters={send_message:{target:'string',message:'string'},interrupt_agent:{target:'string'},list_agents:{},wait_agent:{timeout_ms:'integer'}}
const controlRequired={send_message:['message','target'],interrupt_agent:['target'],list_agents:[],wait_agent:[]}
const nativeDescription={
  send_message:'Native direct-child path: also accepts the exact id of a continuable native child owned by this agent, from subagent/subagent_fork or the supplemental nativeSubagents catalog returned by list_agents. Delivery and cold continuation use the native subagent service. One-shot children, foreign ids and raw Team member ids are not native-child addresses.',
  interrupt_agent:'Native direct-child path: also interrupts this agent\'s own continuable native child by its exact id; it does not delete the child. Team targets retain the Team Lead permission rule. One-shot children, foreign ids and raw Team member ids are not native-child addresses.',
  list_agents:'Native direct-child path: a separate additional context supplies a bounded nativeSubagents catalog with exact target ids, modes and current availability. The structured return value remains the Team list. Availability does not certify task completion or acceptance.',
  wait_agent:'Native direct-child path: also waits for a running continuable native direct child to change status, or for a native message to reach this parent, even when no Team peer is active. It never starts an inactive child. If neither path has active work, the native noProgress response remains. After wakeup, inspect the child result or list_agents; wakeup does not certify task completion or acceptance.'
}
// DSH has no definition-provenance or schema-description middleware. Match the
// effective Team control contract conservatively rather than shadowing tools.
// Incompatible/extended third-party definitions and native agent_id controls
// remain entirely native. An exact protocol-compatible shadow is indistinguish-
// able from the host definition, so all host guards still remain authoritative.
function teamControlContract(name,definition){
  const expected=controlParameters[name],schema=definition?.parameters
  if(!expected||schema?.type!=='object'||!schema.properties)return false
  const keys=Object.keys(schema.properties).sort(),required=[...(schema.required??[])].sort()
  return JSON.stringify(keys)===JSON.stringify(Object.keys(expected).sort())&&
    JSON.stringify(required)===JSON.stringify(controlRequired[name])&&
    keys.every(key=>schema.properties[key]?.type===expected[key]&&Object.keys(schema.properties[key]).every(field=>['type','description'].includes(field)))
}

// Job APIs enforce ownership on every observation. Failed observations must
// leave the real tool responsible for its normal error, without waiting.
function visibleJob(jobs,id,owner){try{return jobs?.get(id,owner)}catch{return undefined}}

export function createFlowCoordination({agent,jobs,subagents,teams,agents,on,context,toolFor,waitMs=FLOW_POLL_WAIT_MS}) {
  const empty=new Map(),lifetime=new AbortController()
  const stats={jobWaits:0,jobChanges:0,childMessages:0,childInterrupts:0,childWaits:0}
  let mixedBatch=false
  const members=()=>teams?.tryMembership?.(agent)?teams.listMembers(agent):null
  const available=name=>!lifetime.signal.aborted&&Boolean(members())&&typeof subagents?.listChildren==='function'&&
    teamControlContract(name,toolFor?.(name))&&
    (name!=='send_message'||typeof subagents.sendMessage==='function')&&
    (name!=='interrupt_agent'||typeof subagents.interrupt==='function')&&
    (name!=='wait_agent'||typeof on==='function'&&typeof agents?.get==='function'&&typeof teams.waitForChange==='function')
  const describe=schemas=>schemas.map(schema=>{
    if(!available(schema.name)||!teamControlContract(schema.name,schema))return schema
    const description=`Team path: ${schema.description??''}\n${nativeDescription[schema.name]}`
    const target=schema.parameters.properties.target
    return{...schema,description,...(target?{parameters:{...schema.parameters,properties:{...schema.parameters.properties,
      target:{...target,description:`Team path: ${target.description??'Named Team target.'} Native direct-child path: exact target id of this agent's continuable child from subagent/subagent_fork or list_agents supplemental nativeSubagents catalog. Do not substitute a raw Team member id.`}}}}:{})}
  })
  const children=async(signal,roster)=>{
    const rows=await subagents.listChildren(agent.id,signal)
    // Teammates are also native children. Keep their Team mailbox and Lead
    // permission rules authoritative; a raw id must not bypass those rules.
    return rows.filter(row=>!roster.some(member=>member.id===row.id))
  }
  const childStatus=id=>{const live=agents?.get(id);return live?(live.status==='running'?'running':'inactive'):'not-resident'}
  const catalog=rows=>({nativeControls:Object.fromEntries(['send_message','interrupt_agent','wait_agent'].map(name=>[name,available(name)])),
    nativeSubagents:rows.slice(-32).map(row=>({target:row.id,mode:row.mode,status:childStatus(row.id),
    ...(row.label?{label:row.label.length>120?row.label.slice(0,119)+'…':row.label}:{})})),omitted:Math.max(0,rows.length-32)})
  const deferCatalog=(exec,rows)=>{
    exec.deferContext(context('Native direct-child catalog (separate from Team members). nativeControls reports which native-child routes are available in this tool surface; message and interrupt require a continuable child and its exact target id. wait_agent observes running continuable children. Availability is not task completion or acceptance.\n'+JSON.stringify(catalog(rows))))
  }
  async function waitForJob(exec,id,baseline){
    const changed=new AbortController(),signal=AbortSignal.any([exec.signal,lifetime.signal,changed.signal])
    const notice=event=>{
      if((event.id??event.job?.id)!==id||event.type==='settled')return
      const current=visibleJob(jobs,id,agent.id)
      // Settlement releases native waiters first, preserving `awaited` and
      // the host's completion-notification suppression.
      if((active(current)&&fingerprint(current)!==baseline)||!current)changed.abort()
    }
    const stop=jobs.events.subscribe({owner:agent.id},notice)
    try{
      if(fingerprint(visibleJob(jobs,id,agent.id))!==baseline)return
      stats.jobWaits++
      const requested=exec.arguments.timeout_ms
      const timeout=Number.isFinite(requested)&&requested>0?Math.min(requested,waitMs):waitMs
      try{await jobs.wait(id,timeout,agent.id,signal)}catch(error){
        exec.signal.throwIfAborted();lifetime.signal.throwIfAborted()
        if(!changed.signal.aborted)throw error
      }
      exec.signal.throwIfAborted();lifetime.signal.throwIfAborted()
      if(changed.signal.aborted)stats.jobChanges++
    }finally{stop()}
  }
  async function jobOutput(exec,next){
    const id=exec.arguments.job_id,before=visibleJob(jobs,id,agent.id)
    const key=fingerprint(before)
    if(active(before)&&exec.arguments.wait===undefined&&!mixedBatch&&empty.get(id)===key&&jobs?.wait&&jobs?.events){
      await waitForJob(exec,id,key)
    }
    const justBefore=fingerprint(visibleJob(jobs,id,agent.id)),result=await next()
    const after=visibleJob(jobs,id,agent.id),receipt=result?.value
    // A producer racing this read must never have its unseen bytes held back.
    empty.delete(id)
    if(!mixedBatch&&!result?.isError&&receipt?.text===''&&receipt.job?.id===id&&active(after)&&justBefore===fingerprint(after)){
      empty.set(id,fingerprint(after))
      if(empty.size>128)empty.delete(empty.keys().next().value)
    }
    return result
  }
  async function waitForAgents(exec,next,roster){
    const timeout=exec.arguments.timeout_ms??30000
    // Leave invalid arguments and installations without the native event API
    // to the host. Observe the parent inbox BEFORE asynchronous catalog IO.
    if(!on||!Number.isSafeInteger(timeout)||timeout<10000||timeout>3600000)return next()
    const changed=new AbortController(),signal=AbortSignal.any([exec.signal,lifetime.signal,changed.signal])
    const stopInbox=on('agent/inbox/inserted',({agent:owner})=>{if(owner===agent)changed.abort()})
    try{
      const rows=await children(exec.signal,roster)
      const running=rows.filter(row=>row.mode==='continuable'&&childStatus(row.id)==='running')
      if(!running.length)return next()
      const ids=new Set(running.map(row=>row.id))
      const stopStatus=on('agent/status',({agent:child})=>{if(ids.has(child.id))changed.abort()})
      try{
        if(changed.signal.aborted||running.some(row=>childStatus(row.id)!=='running'))return success({timedOut:false})
        stats.childWaits++
        try{return success(await teams.waitForChange(agent,timeout,signal))}catch(error){
          exec.signal.throwIfAborted();lifetime.signal.throwIfAborted()
          if(!changed.signal.aborted)throw error
          return success({timedOut:false})
        }
      }finally{stopStatus()}
    }finally{stopInbox()}
  }
  async function controls(exec,next){
    const roster=members()
    if(!roster||!available(exec.name))return next()
    if(exec.name==='list_agents'){
      const result=await next()
      if(!result.isError){
        // An optional catalog failure must not turn a successful Team list
        // into a failure or hide its original data.
        try{deferCatalog(exec,await children(exec.signal,roster))}catch(error){
          exec.signal.throwIfAborted()
          exec.deferContext(context('Native child catalog unavailable: '+String(error.message).slice(0,300)))
        }
      }
      return result
    }
    if(exec.name==='wait_agent')return waitForAgents(exec,next,roster)
    const rows=await children(exec.signal,roster)
    const target=exec.arguments.target
    // Non-Team native controls use agent_id; do not alter their contract.
    if(typeof target!=='string')return next()
    const child=rows.find(row=>row.id===target)
    if(!child)return next()
    if(roster.some(member=>member.name===target))throw new Error('Ambiguous target: native child id also names a Team member; use distinct Team names')
    if(child.mode!=='continuable')throw new Error('Native child is not continuable; no message or interrupt was dispatched')
    exec.signal.throwIfAborted();lifetime.signal.throwIfAborted()
    if(exec.name==='send_message'){
      const messageId=await subagents.sendMessage(agent,target,[{type:'text',text:exec.arguments.message}],{signal:AbortSignal.any([exec.signal,lifetime.signal])})
      stats.childMessages++;return success({messageId,status:'accepted'})
    }
    const previousStatus=childStatus(target)==='running'?'running':'inactive'
    subagents.interrupt(target,{kind:'ancestor',agent})
    stats.childInterrupts++;return success({previousStatus})
  }
  return {
    stats,
    describe,
    // Annotation-only projection at DSH's native assembly boundary. Never
    // register a replacement definition: that changes shadowing, restrictions,
    // scheduling and permission ownership. SDK output types stay native too.
    assemble(assembly,{sdkSchemas,renderSdk}={}){
      if(lifetime.signal.aborted)return assembly
      const tools=describe(assembly.tools??[])
      let sections=assembly.sections,changed=tools.some((tool,index)=>tool!==assembly.tools[index])
      if(sections?.some(section=>section.name==='tools:sdk')&&sdkSchemas&&renderSdk){
        const original=sdkSchemas(),projected=describe(original)
        if(projected.some((schema,index)=>schema!==original[index])){
          sections=sections.map(section=>section.name==='tools:sdk'?{...section,text:renderSdk(projected)}:section);changed=true
        }
      }
      return changed?{...assembly,tools,sections}:assembly
    },
    observe(event){
      if(event.type==='assistant/message'){
        const calls=event.data?.message?.content?.filter(block=>block.type==='tool-call')??[]
        // Native job tools may be scheduled exclusively. Do not hold up a
        // sibling read (including another job) in an explicit tool batch.
        mixedBatch=calls.length>1
        if(mixedBatch)empty.clear()
      }
      if(event.type==='turn/start')empty.clear()
      if(event.type==='step/end'||event.type==='turn/start')mixedBatch=false
    },
    async execute(exec,next){
      if(lifetime.signal.aborted)return next()
      if(exec.name==='job_output')return jobOutput(exec,next)
      // Useful intervening work ends a polling streak. Its next status read
      // must stay immediate even when that job has remained silent.
      if(exec.name!=='run_code')empty.clear()
      if(['send_message','interrupt_agent','list_agents','wait_agent'].includes(exec.name))return controls(exec,next)
      return next()
    },
    dispose(){lifetime.abort(new Error('Flow coordination disposed'));empty.clear()}
  }
}
