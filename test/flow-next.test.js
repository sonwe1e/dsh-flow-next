import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { nextDefinition } from '../modes/flow-next-preset.js'
import { FLOW_NEXT_GUIDANCE,FLOW_NEXT_SOURCE,FLOW_NEXT_POLICY,initialNextState,foldNextState,nextStateSchema,nextCheckpointEvents,renderNextSupport,nextSupportSignature } from '../lib/flow-next.js'
import { AdaptiveFlow,replayAdaptive } from '../lib/flow-adaptive.js'
const e=(type,data={})=>({type,data})
test('Next changes persona and composes existing capabilities, recall and one scoped policy',()=>{
  const base=JSON.parse(fs.readFileSync(new URL('../modes/native-coding.json',import.meta.url))),next=nextDefinition()
  assert.equal(next.id,'flow-next');assert.deepEqual(next.plugins.slice(0,-2).filter(p=>p.id!=='persona'),base.plugins.filter(p=>p.id!=='persona'))
  assert.ok(next.plugins.find(p=>p.id==='persona').config.prefix.includes(FLOW_NEXT_GUIDANCE))
  assert.ok(!next.plugins.some(p=>['local-tool-policy','checked-change','submit-work','flow-adaptive-policy'].includes(p.id)))
})
test('native projection retains bounded checkpoint/progress, excludes transcript, and resets only turn-local counts',()=>{
  let state=initialNextState()
  for(const event of [e('turn/start',{turn:1}),e('step/start',{step:1}),e('tool/call',{name:'write'}),
    e('assistant/message',{message:{source:{kind:'model'},content:[{type:'text',text:'private-response'}]}}),
    e('developer/message',{message:{source:{kind:FLOW_NEXT_SOURCE},content:[{type:'text',text:'{"flowAdaptive":1}'}]}}),e('step/end')])state=foldNextState(state,event)
  assert.equal(state.completedSteps,1);assert.equal(state.editAttempts,1);assert.equal(state.openStep,false)
  assert.ok(!JSON.stringify(state).includes('private-response'))
  state=foldNextState(state,e('turn/start',{turn:2}));assert.equal(state.toolCalls,0);assert.equal(state.completedSteps,1);assert.ok(state.checkpoint)
  assert.deepEqual(nextStateSchema.parse(JSON.parse(JSON.stringify(state))),state)
  assert.throws(()=>foldNextState(state,e('developer/message',{message:{source:{kind:FLOW_NEXT_SOURCE},content:[]}})),/Invalid/)
})
test('projection progress preserves batch boundary, cooldown and checkpoint recovery without full-log reads',()=>{
  let state=initialNextState()
  const record=checkpoint=>{state=foldNextState(state,e('developer/message',{message:{source:{kind:FLOW_NEXT_SOURCE},content:[{type:'text',text:JSON.stringify(checkpoint)}]}}))}
  const make=()=>new AdaptiveFlow({events:()=>nextCheckpointEvents(state),progress:()=>state,config:FLOW_NEXT_POLICY,
    install:()=>()=>{},available:()=>undefined,record})
  const controller=make();state=foldNextState(state,e('step/start',{step:1}))
  assert.equal(controller.select({presentation:'ptc',capabilities:'full'},'Read independent inputs').accepted,true)
  controller.boundary();assert.equal(controller.state.current.presentation,'native')
  state=foldNextState(state,e('step/end'));controller.boundary();assert.equal(controller.state.current.presentation,'ptc')
  assert.equal(replayAdaptive(nextCheckpointEvents(state),FLOW_NEXT_POLICY).current.presentation,'ptc')
  const resumed=make();assert.equal(resumed.state.current.presentation,'ptc')
  assert.equal(resumed.select({presentation:'native',capabilities:'full'},'Return').accepted,false)
  state=foldNextState(state,e('step/end'));assert.equal(resumed.select({presentation:'native',capabilities:'full'},'Direct edit').accepted,true)
})
test('task support is conditional, honors actual evidence states and does not revive repaired failures',()=>{
  const state=initialNextState(),receipt=(status,freshness='observed-inputs-unchanged')=>({state:status,freshness})
  assert.equal(renderNextSupport(state,{last:null}),'')
  assert.match(renderNextSupport(state,{last:[receipt('zero-tests')]}),/actual executed count/)
  assert.match(renderNextSupport(state,{last:[receipt('failed')]}),/intended negative check/)
  assert.match(renderNextSupport(state,{last:[receipt('exited-zero','stale')]}),/Assess relevance.*rerun affected checks/)
  const unrelated=renderNextSupport(state,{last:[receipt('exited-zero'),receipt('failed','stale')]})
  assert.match(unrelated,/unresolved execution reported failure/);assert.doesNotMatch(unrelated,/Reuse/)
  const repaired=renderNextSupport(state,{last:[receipt('exited-zero'),receipt('failed','stale')],unresolved:[]})
  assert.match(repaired,/Reuse/);assert.doesNotMatch(repaired,/reported failure|Reverify/)
  assert.match(renderNextSupport(state,{last:[receipt('unfinished')]}),/terminal results/)
  assert.match(renderNextSupport({...state,toolCalls:10},{last:[]}),/does not prove a stall/)
})

test('partial scopes and unresolved jobs prevent reuse and support signatures track semantic transitions',()=>{
  const state=initialNextState(),clean={sequence:1,state:'exited-zero',freshness:'observed-inputs-unchanged'}
  for(const partial of [{unobserved:true},{outcomesTruncated:true},{last:[{...clean,aggregate:true}]},
    {last:[{...clean,laterEditedFiles:['src/new.js']}]},{last:[{...clean,omittedInputs:['src/old.js']}]}]) {
    const text=renderNextSupport(state,{last:[clean],unresolved:[],...partial})
    assert.match(text,/scope is partial/);assert.doesNotMatch(text,/Reuse/)
  }
  const ledger={last:[clean],unresolved:[{sequence:0,state:'unfinished',remainingKeys:['check']}]}
  assert.match(renderNextSupport(state,ledger),/terminal results/)
  assert.doesNotMatch(renderNextSupport(state,ledger),/Reuse/)
  const signature=nextSupportSignature(state,ledger)
  assert.equal(nextSupportSignature({...state,toolCalls:2},ledger),signature)
  assert.notEqual(nextSupportSignature({...state,turn:1},ledger),signature)
  assert.notEqual(nextSupportSignature(state,{...ledger,last:[{...clean,freshness:'stale'}]}),signature)
})
