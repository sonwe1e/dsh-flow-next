import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { renderToolsSdk,renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import { createFlowCoordination } from '../lib/flow-coordination.js'

const teamSchemas=()=>[
  {name:'send_message',description:'Send a durable Team message.',parameters:{type:'object',properties:{target:{type:'string',description:'Member target.'},message:{type:'string'}},required:['target','message']}},
  {name:'interrupt_agent',description:'Interrupt a teammate. Team Lead only.',parameters:{type:'object',properties:{target:{type:'string',description:'Teammate target.'}},required:['target']}},
  {name:'list_agents',description:'List Team members.',parameters:{type:'object',properties:{}}},
  {name:'wait_agent',description:'Wait for Team changes.',parameters:{type:'object',properties:{timeout_ms:{type:'integer'}}}}
].map(schema=>({...schema,output:{type:'object',properties:{native:{type:'boolean'}}}}))

function fixture(){
  const events=new EventEmitter(),agent={id:'owner'},job={id:'work',status:'running',output:{total:0,earliest:0}}
  let bytes='',reads=0,waits=0,send=0,interrupt=0
  const jobs={get(id,owner){if(id!=='work'||owner!=='owner')throw Error('unknown or foreign');return structuredClone(job)},
    events:{subscribe(_filter,listener){events.on('job',listener);return()=>events.off('job',listener)}},
    wait(_id,ms,_owner,signal){waits++;return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);events.off('terminal',done);signal.removeEventListener('abort',cancel)}
      const done=()=>{cleanup();resolve()},cancel=()=>{cleanup();reject(Error('aborted'))}
      signal.addEventListener('abort',cancel,{once:true});events.on('terminal',done);const timer=setTimeout(done,ms)
    })}}
  const next=async()=>{reads++;const text=bytes;bytes='';return{isError:false,value:{text,job:{id:'work',status:job.status}}}}
  const update=text=>{bytes+=text;job.output.total+=text.length;events.emit('job',{type:'output',id:'work'})}
  const finish=(status='completed')=>{job.status=status;events.emit('terminal');events.emit('job',{type:'settled',job});events.emit('job',{type:'output',id:'work'})}
  const rows=[{id:'child',mode:'continuable'},{id:'one-shot',mode:'one-shot'},{id:'teammate-id',mode:'continuable'}],live=new Map([['child',{id:'child',status:'idle'}]])
  const roster=[{id:'owner',name:'lead'},{id:'teammate-id',name:'teammate'}]
  const subagents={listChildren:async()=>rows,sendMessage:async()=>{send++;return'message-1'},interrupt:()=>{interrupt++}}
  const teams={tryMembership:()=>true,listMembers:()=>roster,waitForChange:(_agent,_timeout,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}
  const definitions=new Map(teamSchemas().map(schema=>[schema.name,schema]))
  const c=createFlowCoordination({agent,jobs,subagents,teams,agents:{get:id=>live.get(id)},context:text=>({text}),
    on:(name,fn)=>{events.on(name,fn);return()=>events.off(name,fn)},toolFor:name=>definitions.get(name),waitMs:20})
  const contexts=[],exec=(name,args={},signal=new AbortController().signal)=>({name,arguments:args,agent,signal,deferContext:x=>contexts.push(x)})
  const poll=args=>c.execute(exec('job_output',{job_id:'work',...args}),next)
  return{c,agent,job,jobs,events,next,update,finish,rows,roster,live,teams,subagents,definitions,contexts,exec,poll,counts:()=>({reads,waits,send,interrupt})}
}
test('first read is immediate; repeated implicit empty read waits for native output without consuming it twice',async()=>{
  const f=fixture();await f.poll();assert.equal(f.counts().waits,0)
  const pending=f.poll();await Promise.resolve();assert.equal(f.counts().reads,1)
  f.update('progress\n');const result=await pending
  assert.equal(result.value.text,'progress\n');assert.equal(f.counts().waits,1);assert.equal(f.events.listenerCount('job'),0)
  await f.poll();assert.equal(f.counts().waits,1,'Non-empty receipt does not arm suppression')
})
test('new output already present, explicit false, explicit true, mixed work and other tools retain native execution',async()=>{
  const f=fixture();await f.poll();await f.poll({wait:false});await f.poll({wait:true});assert.equal(f.counts().waits,0)
  f.update('new');assert.equal((await f.poll()).value.text,'new');assert.equal(f.counts().waits,0)
  await f.poll();f.c.observe({type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'job_output'},{type:'tool-call',name:'read'}]}}})
  await f.poll();assert.equal(f.counts().waits,0)
  f.c.observe({type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'job_output'},{type:'tool-call',name:'job_output'}]}}})
  await f.poll();assert.equal(f.counts().waits,0,'Another job in the same exclusive batch must remain immediately readable')
  assert.equal(await f.c.execute(f.exec('read'),()=>123),123)
  f.c.observe({type:'step/end'});await f.poll();const pending=f.poll();f.finish();assert.equal((await pending).value.job.status,'completed')
})
test('terminal failure remains failed; bounded timeout remains running and does not kill producer',async()=>{
  const f=fixture();await f.poll();assert.equal((await f.poll()).value.job.status,'running');assert.equal(f.counts().waits,1)
  const pending=f.poll();f.finish('failed');assert.equal((await pending).value.job.status,'failed')
  await f.poll();assert.equal(f.counts().waits,2);assert.equal(f.events.listenerCount('job'),0)
})
test('cancellation and disposal release waits without a read or a kill',async()=>{
  for(const dispose of [false,true]){
    const f=fixture();await f.poll();const abort=new AbortController(),pending=f.c.execute(f.exec('job_output',{job_id:'work'},abort.signal),f.next)
    if(dispose)f.c.dispose();else abort.abort(Error('user cancelled'))
    await assert.rejects(pending,/cancelled|disposed/);assert.equal(f.counts().reads,1);assert.equal(f.job.status,'running');assert.equal(f.events.listenerCount('job'),0)
  }
})
test('read races, denied receipts, unknown jobs, progress and unrelated job events are handled conservatively',async()=>{
  const f=fixture()
  await f.c.execute(f.exec('job_output',{job_id:'work'}),async()=>{f.update('raced');return{isError:false,value:{text:'',job:{id:'work',status:'running'}}}})
  assert.equal((await f.poll()).value.text,'raced');assert.equal(f.counts().waits,0)
  await f.c.execute(f.exec('job_output',{job_id:'work'}),async()=>({isError:true}));await f.poll();assert.equal(f.counts().waits,0)
  assert.equal(await f.c.execute(f.exec('job_output',{job_id:'foreign'}),()=>42),42)
  const pending=f.poll();f.events.emit('job',{type:'output',id:'other'});await Promise.resolve();assert.equal(f.counts().reads,2)
  f.job.progress='phase two';f.events.emit('job',{type:'progress',job:f.job});await pending;assert.equal(f.c.stats.jobChanges,1)
})
test('native children route once through native message/interrupt APIs; Team names, ids and unknown targets retain host dispatch',async()=>{
  const f=fixture(),host=()=>({host:true})
  assert.deepEqual(await f.c.execute(f.exec('send_message',{target:'child',message:'continue'}),host),{isError:false,value:{messageId:'message-1',status:'accepted'}})
  assert.deepEqual(await f.c.execute(f.exec('interrupt_agent',{target:'child'}),host),{isError:false,value:{previousStatus:'inactive'}})
  for(const target of ['teammate','teammate-id','foreign'])assert.deepEqual(await f.c.execute(f.exec('send_message',{target,message:'x'}),host),{host:true})
  assert.deepEqual(await f.c.execute(f.exec('send_message',{agent_id:'child',message:'x'}),host),{host:true})
  assert.deepEqual(f.counts(),{reads:0,waits:0,send:1,interrupt:1})
})
test('one-shot and ambiguous identities never dispatch or silently fall back',async()=>{
  const f=fixture();f.roster.push({id:'different',name:'child'})
  await assert.rejects(f.c.execute(f.exec('send_message',{target:'child',message:'x'}),()=>assert.fail()),/Ambiguous/)
  await assert.rejects(f.c.execute(f.exec('send_message',{target:'one-shot',message:'x'}),()=>assert.fail()),/not continuable/)
  assert.equal(f.counts().send,0)
})
test('catalog supplements but never changes the Team schema, marks availability without grading tasks, and bounds context',async()=>{
  const f=fixture();for(let i=0;i<50;i++)f.rows.push({id:'extra-'+i,mode:'continuable'})
  const host={isError:false,value:[{target:'lead',role:'lead',status:'inactive',diagnostics:[]}]}
  assert.equal(await f.c.execute(f.exec('list_agents'),()=>host),host)
  const data=JSON.parse(f.contexts[0].text.split('\n')[1]);assert.equal(data.nativeSubagents.length,32);assert.equal(data.omitted,20)
  assert.ok(data.nativeSubagents.every(x=>x.status==='not-resident'));assert.match(f.contexts[0].text,/not task completion/)
  f.subagents.listChildren=async()=>{throw Error('query unavailable')}
  assert.equal(await f.c.execute(f.exec('list_agents'),()=>host),host);assert.match(f.contexts.at(-1).text,/unavailable/)
})
test('empty child catalogs remain discoverable and do not advertise unavailable child routes',async()=>{
  const f=fixture();f.rows.length=0;f.definitions.delete('send_message')
  const result={isError:false,value:[]};assert.equal(await f.c.execute(f.exec('list_agents'),()=>result),result)
  const catalog=JSON.parse(f.contexts[0].text.split('\n')[1])
  assert.deepEqual(catalog.nativeSubagents,[]);assert.equal(catalog.omitted,0)
  assert.deepEqual(catalog.nativeControls,{send_message:false,interrupt_agent:true,wait_agent:true})
})
test('native active child wakes a native Team wait; inactive child and invalid timeout retain no-progress host behavior',async()=>{
  const f=fixture();const host=()=>({host:true})
  assert.deepEqual(await f.c.execute(f.exec('wait_agent'),host),{host:true})
  f.live.get('child').status='running'
  assert.deepEqual(await f.c.execute(f.exec('wait_agent',{timeout_ms:1}),host),{host:true})
  const pending=f.c.execute(f.exec('wait_agent'),host);await new Promise(resolve=>setImmediate(resolve))
  f.live.get('child').status='idle';f.events.emit('agent/status',{agent:f.live.get('child')})
  assert.deepEqual(await pending,{isError:false,value:{timedOut:false}});assert.equal(f.events.listenerCount('agent/status'),0)
})
test('non-Team installation and a disposed controller are no-ops',async()=>{
  const f=fixture();f.teams.tryMembership=()=>undefined
  assert.equal(await f.c.execute(f.exec('send_message',{target:'child'}),()=>17),17)
  await f.poll();f.c.dispose();await f.poll();assert.equal(f.counts().waits,0)
})

test('a native inbox item wakes the waiting parent while the child continues running',async()=>{
  const f=fixture();f.live.get('child').status='running'
  const pending=f.c.execute(f.exec('wait_agent'),()=>assert.fail());await new Promise(resolve=>setImmediate(resolve))
  f.events.emit('agent/inbox/inserted',{agent:{id:'other'}});assert.equal(f.events.listenerCount('agent/inbox/inserted'),1)
  f.events.emit('agent/inbox/inserted',{agent:f.agent})
  assert.deepEqual(await pending,{isError:false,value:{timedOut:false}});assert.equal(f.live.get('child').status,'running')
  assert.equal(f.events.listenerCount('agent/inbox/inserted'),0);assert.equal(f.events.listenerCount('agent/status'),0)
})

test('an inbox edge during asynchronous child discovery is not lost',async()=>{
  const f=fixture();f.live.get('child').status='running'
  f.subagents.listChildren=async()=>{f.events.emit('agent/inbox/inserted',{agent:f.agent});return f.rows}
  f.teams.waitForChange=()=>assert.fail('An already-observed edge must not start a new wait')
  assert.deepEqual(await f.c.execute(f.exec('wait_agent'),()=>assert.fail()),{isError:false,value:{timedOut:false}})
  assert.equal(f.events.listenerCount('agent/inbox/inserted'),0)
})

test('intervening work and a new user turn reset the polling streak',async()=>{
  const f=fixture();await f.poll();await f.c.execute(f.exec('read'),()=>({isError:false,value:'useful result'}))
  await f.poll();assert.equal(f.counts().waits,0)
  f.c.observe({type:'turn/start'});await f.poll();assert.equal(f.counts().waits,0)
  const pending=f.poll();f.finish();await pending;assert.equal(f.counts().waits,1)
})

test('PTC orchestration alone does not reset a polling streak across model requests',async()=>{
  const f=fixture();await f.c.execute(f.exec('run_code'),()=>f.poll())
  f.c.observe({type:'step/end'})
  const pending=f.c.execute(f.exec('run_code'),()=>f.poll());f.finish()
  assert.equal((await pending).value.job.status,'completed');assert.equal(f.counts().waits,1)
})

test('native and PTC descriptions project the same live capabilities without changing execution schemas or shared definitions',()=>{
  const f=fixture(),schemas=[...f.definitions.values()],before=structuredClone(schemas)
  const assembly={tools:schemas,sections:[{name:'unrelated',text:'unchanged'}],contexts:[{name:'original',text:'host-owned'}]}
  const native=f.c.assemble(assembly)
  for(const schema of native.tools){
    assert.match(schema.description,/Native direct-child path/)
    assert.equal(schema.output,schemas.find(item=>item.name===schema.name).output)
    assert.deepEqual({...schema.parameters,properties:Object.fromEntries(Object.entries(schema.parameters.properties).map(([name,value])=>[name,{...value,description:undefined}]))},
      {...schemas.find(item=>item.name===schema.name).parameters,properties:Object.fromEntries(Object.entries(schemas.find(item=>item.name===schema.name).parameters.properties).map(([name,value])=>[name,{...value,description:undefined}]))})
  }
  assert.match(native.tools.find(schema=>schema.name==='send_message').parameters.properties.target.description,/exact target id/)
  assert.match(native.tools.find(schema=>schema.name==='wait_agent').description,/even when no Team peer is active/)
  assert.match(native.tools.find(schema=>schema.name==='list_agents').description,/separate additional context/)
  assert.deepEqual(schemas,before,'Do not mutate registry-owned definitions or their nested JSON')
  assert.equal(native.contexts,assembly.contexts);assert.equal(native.sections,assembly.sections)
  for(const renderSdk of [renderToolsSdk,renderToolsSdkPy]){
    const sdk={tools:[{name:'run_code'}],sections:[{name:'unrelated',text:'unchanged'},{name:'tools:sdk',text:'old'}]}
    const projected=f.c.assemble(sdk,{sdkSchemas:()=>schemas,renderSdk})
    assert.equal(projected.sections[1].text,renderSdk(native.tools))
    assert.equal(projected.sections[0],sdk.sections[0]);assert.equal(projected.tools[0],sdk.tools[0])
  }
})

test('non-Team, native agent_id controls, hidden or incompatible shadow definitions and disposal do not advertise or route capabilities',async()=>{
  for(const kind of ['non-Team','agent_id','hidden','extended-shadow','wrong-required','enum-shadow','disposed']){
    const f=fixture(),schemas=teamSchemas()
    if(kind==='non-Team')f.teams.tryMembership=()=>undefined
    if(kind==='agent_id')f.definitions.set('send_message',{...schemas[0],parameters:{type:'object',properties:{agent_id:{type:'string'},message:{type:'string'}},required:['agent_id','message']}})
    if(kind==='hidden')f.definitions.delete('send_message')
    if(kind==='extended-shadow')f.definitions.set('send_message',{...schemas[0],parameters:{...schemas[0].parameters,properties:{...schemas[0].parameters.properties,custom:{type:'string'}}}})
    if(kind==='wrong-required')f.definitions.set('send_message',{...schemas[0],parameters:{...schemas[0].parameters,required:[]}})
    if(kind==='enum-shadow')f.definitions.set('send_message',{...schemas[0],parameters:{...schemas[0].parameters,properties:{...schemas[0].parameters.properties,target:{type:'string',enum:['restricted-target']}}}})
    if(kind==='disposed')f.c.dispose()
    assert.equal(f.c.describe([schemas[0]])[0],schemas[0],kind)
    assert.equal(await f.c.execute(f.exec('send_message',{target:'child',message:'x'}),()=>17),17,kind)
    assert.equal(f.counts().send,0,kind)
  }
})

test('missing native service methods do not advertise or dispatch unavailable operations',async()=>{
  for(const [name,service] of [['send_message','sendMessage'],['interrupt_agent','interrupt'],['wait_agent','waitForChange']]){
    const f=fixture(),schema=f.definitions.get(name)
    if(name==='wait_agent')delete f.teams[service];else delete f.subagents[service]
    assert.equal(f.c.describe([schema])[0],schema)
    assert.equal(await f.c.execute(f.exec(name,{target:'child',message:'x'}),()=>19),19)
  }
  const f=fixture();f.subagents.listChildren=undefined
  const assembly={tools:teamSchemas(),sections:[{name:'tools:sdk',text:'unchanged'}]}
  assert.equal(f.c.assemble(assembly,{sdkSchemas:()=>teamSchemas(),renderSdk:()=>assert.fail()}),assembly)
})
