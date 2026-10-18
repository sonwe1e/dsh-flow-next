import test from 'node:test'
import assert from 'node:assert/strict'
import { initialTaskState,foldTask,taskLink,taskView,taskStateSchema,FLOW_TASK_SOURCE } from '../lib/flow-task.js'
import { FlowEvidence } from '../lib/flow-evidence.js'

function fixture(){
  let state=initialTaskState(),seq=0,goal=null,hash='a'.repeat(64)
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async files=>Object.fromEntries(files.map(file=>[file,hash]))})
  ledger.observeFile('a.js')
  const env=()=>({goal,ledger,findCheck:id=>ledger.getRecord(id)})
  const emit=(type,data)=>state=foldTask(state,{seq:++seq,type,data})
  emit('turn/start',{turn:1})
  const plan=rows=>emit('todo/write',{todos:rows.map(([content,status])=>({content,status}))})
  const link=async args=>{const value=await taskLink(state,{action:'link',item:state.items[0].key,...args},env());emit('developer/message',{message:{source:{kind:FLOW_TASK_SOURCE},content:[{type:'text',text:JSON.stringify(value)}]}})}
  const change=(id,revision,operation='create',phase='active',objective=id)=>{goal={id,revision,objective,phase};emit('goal/change',{operation,goal})}
  return {plan,link,change,emit,ledger,state:()=>state,view:()=>taskView(state,env()),hash:value=>hash=value,env}
}

test('required verification cannot silently downgrade; explained withdrawal stays visible',async()=>{
  const f=fixture();f.plan([['verify feature','completed']]);await f.link({verification:'required',reason:'original requirement'})
  await assert.rejects(f.link({verification:'unspecified'}),/new amendment reason/)
  await f.link({verification:'unspecified',reason:'User deferred integration to a later phase'})
  const view=await f.view();assert.equal(view.counts.requiredEvidenceMissing,1);assert.equal(view.items[0].requiredEver,true)
  assert.deepEqual(view.amendments.map(row=>[row.previous,row.next]),[['required','unspecified']]);taskStateSchema.parse(f.state())
})
test('removed required todo remains an explicit unresolved obligation',async()=>{
  const f=fixture();f.plan([['verify feature','completed']]);await f.link({verification:'required'});f.plan([])
  const view=await f.view();assert.equal(view.removedRequired.length,1);assert.equal(view.counts.requiredEvidenceMissing,1)
})
test('goal replacement and edit suppress old plan; native rewrite adopts only new objective',async()=>{
  const f=fixture();f.change('A',1);f.plan([['old task','in_progress']]);await f.link({verification:'required'})
  f.change('B',1);let view=await f.view();assert.equal(view.planApplicable,false);assert.deepEqual(view.next,[])
  await assert.rejects(f.link({verification:'required'}),/historical plans/)
  f.plan([['new task','pending']]);assert.equal((await f.view()).next[0].content,'new task')
  f.change('B',2,'edit','active','edited objective');assert.equal((await f.view()).planApplicable,false)
})
test('pause and resume preserve objective lineage but pause supplies no runnable next action',async()=>{
  const f=fixture();f.change('A',1);f.plan([['task','in_progress']]);await f.link({verification:'required'})
  f.change('A',2,'pause','paused');assert.deepEqual((await f.view()).next,[])
  f.change('A',3,'resume');const view=await f.view();assert.equal(view.planApplicable,true);assert.equal(view.items[0].requiredEver,true);assert.equal(view.next.length,1)
})
test('missing completed verification is not hidden behind unrelated active work',async()=>{
  const f=fixture();f.plan([['verify','completed'],['other','in_progress']])
  // Native projection sorts active first; link the intended completed item.
  const key=f.state().items.find(row=>row.content==='verify').key
  const value=await taskLink(f.state(),{action:'link',item:key,verification:'required'},f.env())
  f.emit('developer/message',{message:{source:{kind:FLOW_TASK_SOURCE},content:[{type:'text',text:JSON.stringify(value)}]}})
  assert.equal((await f.view()).next[0].content,'verify')
})
test('third check does not expire unchanged linked evidence; mutation and cold process remain unknown',async()=>{
  const f=fixture();f.plan([['verify','completed']])
  const run=async id=>{const exec={name:'pwsh',callId:id,arguments:{command:'node --check '+id+'.js'}};await f.ledger.begin(exec);await f.ledger.finish(exec,{value:{kind:'foreground',exitCode:0},content:[]});await f.ledger.refresh();return f.ledger.last[0]}
  const a=await run('A');await f.link({verification:'required',checks:[a.checkId]});await run('B');await run('C')
  assert.ok(!f.ledger.last.some(row=>row.checkId===a.checkId));assert.equal((await f.view()).items[0].evidence,'observed-checks-pass')
  f.hash('b'.repeat(64));assert.equal((await f.view()).items[0].evidence,'historical-or-unknown')
  const cold=new FlowEvidence({root:process.cwd(),snapshot:f.ledger.snapshot});cold.observeFile('a.js')
  const view=await taskView(f.state(),{...f.env(),ledger:cold});assert.equal(view.items[0].evidence,'historical-or-unknown')
})
test('no plan ordinary turn stays empty; old goalless todos are not revived across turns',async()=>{
  const f=fixture();assert.deepEqual((await f.view()).next,[]);f.plan([['task','pending']]);f.emit('turn/start',{turn:2});assert.deepEqual((await f.view()).next,[])
})

test('goal clear cannot revive an earlier goalless plan; budget-only edit retains objective lineage',async()=>{
  const f=fixture();f.plan([['old goalless','pending']]);f.change('A',1);f.emit('goal/change',{operation:'clear'})
  assert.equal((await taskView(f.state(),{...f.env(),goal:null})).planApplicable,false)
  const g=fixture();g.change('A',1);g.plan([['task','pending']]);g.change('A',2,'edit');assert.equal((await g.view()).planApplicable,true)
})
