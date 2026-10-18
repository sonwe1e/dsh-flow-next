import test from 'node:test'
import assert from 'node:assert/strict'
import { FlowEvidence,isVerification } from '../lib/flow-evidence.js'
import { emptyCheckProtocol,updateCheckProtocol,renderCheckProtocol,readCheckProtocol,serializeCheckProtocol,FLOW_CHECK_SOURCE } from '../lib/flow-check-protocol.js'
import { initialNextState,foldNextState,nextStateSchema,renderNextSupport,nextSupportSignature } from '../lib/flow-next.js'
const setup=()=>{
  const files={'src/runtime.js':'v1','tools/check.cjs':'check-v1','notes/task.md':'notes-v1'}
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async names=>Object.fromEntries(names.map(f=>[f,files[f]??null]))})
  for(const f of Object.keys(files))ledger.observeFile(f)
  let state=emptyCheckProtocol()
  let call=0
  const change=args=>{state=updateCheckProtocol(state,args.action==='scope'?{toolName:'pwsh',...args}:args,ledger);ledger.scopes=state.scopes;ledger.assessments=state.assessments;return state}
  const run=async(command='node tools/check.cjs',exitCode=0,callId='check-'+ ++call)=>{
    const e={name:'pwsh',callId,arguments:{command}};await ledger.begin(e)
    await ledger.finish(e,{value:{kind:'foreground',exitCode},content:[{type:'text',text:exitCode?'environment failure':'passed'}]})
    await ledger.refresh();return ledger.last[0]
  }
  return{files,ledger,change,run,state:()=>state}
}
test('syntax/audit recognition follows real invocation positions; read, output and app flags remain negative',()=>{
  for(const c of ['node --check app.cjs','node -c app.mjs','node tools/ui-audit.cjs','node --experimental-strip-types --test'])assert.equal(isVerification(c),true,c)
  for(const c of ['Get-Content tools/ui-audit.cjs','Write-Output "node --check app.cjs"','node app.cjs --test',
    'node app.cjs --check app.cjs','node -e "console.log(\"audit\")"','node --check','node tools/ui-audit.cjs --help'])assert.equal(isVerification(c),false,c)
})
test('declared scope prevents unrelated notes invalidation while code and verifier edits invalidate',async()=>{
  const s=setup();s.change({action:'scope',command:'node tools/check.cjs',files:['src/runtime.js','tools/check.cjs'],reason:'Runtime and verifier are inputs; task notes are not used'})
  await s.run();s.files['notes/task.md']='notes-v2';await s.ledger.refresh()
  assert.equal(s.ledger.last[0].freshness,'observed-inputs-unchanged');assert.equal(s.ledger.last[0].scopeKind,'agent-declared')
  assert.match(s.ledger.render(),/coverage not certified/)
  for(const file of ['src/runtime.js','tools/check.cjs']){
    s.files[file]+='changed';await s.ledger.refresh();assert.equal(s.ledger.last[0].freshness,'stale');assert.ok(s.ledger.last[0].changed.includes(file))
  }
})
test('documents can be real declared inputs; default observation does not silently ignore them',async()=>{
  for(const declare of [false,true]){
    const s=setup();if(declare)s.change({action:'scope',command:'node tools/check.cjs',files:['notes/task.md','tools/check.cjs'],reason:'The verifier consumes the document'})
    await s.run();s.files['notes/task.md']='changed specification';await s.ledger.refresh()
    assert.equal(s.ledger.last[0].freshness,'stale');assert.match(renderNextSupport(initialNextState(),s.ledger),/Assess relevance/)
  }
})
test('scope is prospective and binds full native arguments and cwd; outside paths rejected',async()=>{
  const s=setup();await s.run()
  s.change({action:'scope',command:'node tools/check.cjs',files:['src/runtime.js'],reason:'Explicit prospective inputs'})
  assert.equal(s.ledger.last[0].scopeKind,'observed')
  await s.run('node tools/check.cjs --other');assert.equal(s.ledger.last[0].scopeKind,'observed')
  await s.run();assert.equal(s.ledger.last[0].scopeKind,'agent-declared')
  for(const args of [{command:'node tools/check.cjs',files:['../outside.js']},
    {command:'node tools/check.cjs',workdir:'../outside',files:['src/runtime.js']}])
    assert.throws(()=>s.change({action:'scope',reason:'Invalid scope',...args}))
  assert.throws(()=>s.change({action:'scope',command:'node tools/check.cjs',files:['not-observed.js'],reason:'Not a file read grant'}),/permitted native/)
})
test('declared files survive observation rotation; unreadable and concurrent changes still remain unknown',async()=>{
  const s=setup();s.change({action:'scope',command:'node tools/check.cjs',files:['src/runtime.js','tools/check.cjs'],reason:'Known check inputs'})
  await s.run();for(let i=0;i<40;i++)s.ledger.observeFile(`other/${i}.txt`)
  await s.ledger.refresh();assert.equal(s.ledger.last[0].freshness,'observed-inputs-unchanged')
  delete s.files['src/runtime.js'];await s.ledger.refresh();assert.equal(s.ledger.last[0].freshness,'unknown')
  s.files['src/runtime.js']='v1';const e={name:'pwsh',callId:'during',arguments:{command:'node tools/check.cjs'}}
  await s.ledger.begin(e);await s.ledger.finish({name:'edit',arguments:{file_path:'src/runtime.js'}},{})
  await s.ledger.finish(e,{value:{kind:'foreground',exitCode:0}});await s.ledger.refresh()
  assert.equal(s.ledger.last[0].freshness,'unknown')
})
test('failure classification keeps execution facts and replacement does not certify equivalence',async()=>{
  const s=setup(),bad=await s.run('python tools/smoke-test.py',1),good=await s.run()
  s.change({action:'classify',checkId:bad.checkId,category:'superseded',replacementId:good.checkId,
    reason:'Interpreter is unavailable; use the replacement runner',evidence:'Saved environment diagnostic and mapped core assertions; hardware remains unverified'})
  assert.equal(s.ledger.unresolved.length,1);assert.equal(s.ledger.unresolved[0].state,'failed')
  assert.match(s.ledger.render(),/agent assessment=superseded.*not resolved/)
  assert.match(renderNextSupport(initialNextState(),s.ledger),/do not repeat an explained check solely/)
  assert.match(renderCheckProtocol(s.state(),s.ledger),/agent declarations, not independent acceptance/)
  const before=nextSupportSignature(initialNextState(),s.ledger)
  s.files['src/runtime.js']='regression';await s.ledger.refresh()
  assert.equal(s.ledger.assessmentFor(bad).applicableReplacement,false)
  assert.match(renderNextSupport(initialNextState(),s.ledger),/unresolved execution reported failure/)
  assert.notEqual(nextSupportSignature(initialNextState(),s.ledger),before)
})
test('stale replacement after receipt eviction is rechecked, not permanently acknowledged',async()=>{
  const s=setup(),bad=await s.run('python tools/smoke-test.py',1),good=await s.run()
  s.change({action:'classify',checkId:bad.checkId,category:'superseded',replacementId:good.checkId,reason:'Known environment issue',evidence:'Saved replacement scope'})
  await s.run('node tools/check.cjs --another');await s.run('node tools/check.cjs --third')
  assert.ok(!s.ledger.last.some(r=>r.checkId===good.checkId))
  s.files['tools/check.cjs']='new verifier';await s.ledger.refresh()
  assert.equal(s.ledger.assessmentFor(bad).applicableReplacement,false)
})
test('classifications reject invented ids, pending/zero/stale/aggregate replacements, and missing evidence',async()=>{
  const s=setup(),bad=await s.run('python tools/smoke-test.py',1),base={action:'classify',checkId:bad.checkId,category:'superseded',reason:'Cause',evidence:'Saved output'}
  assert.throws(()=>s.change(base),/replacement/)
  assert.throws(()=>s.change({...base,replacementId:'0000000000000000'}),/Replacement/)
  assert.throws(()=>s.change({...base,category:'environment',checkId:'0000000000000000'}),/observed/)
  const good=await s.run();assert.throws(()=>s.change({...base,checkId:good.checkId,replacementId:good.checkId}),/terminal/)
  s.files['src/runtime.js']='v2';await s.ledger.refresh();assert.throws(()=>s.change({...base,replacementId:good.checkId}),/Replacement/)
  const compound=await s.run('node tools/check.cjs; npm test');assert.throws(()=>s.change({...base,replacementId:compound.checkId}),/Replacement/)
  for(const [name,result] of [
    ['zero-tests',{value:{kind:'foreground',exitCode:0},content:[{type:'text',text:'ALL PASS (0 tests)'}]}],
    ['pending',{value:{kind:'background',jobId:'pending-job'}}],
    ['unknown',{content:[{type:'text',text:'ALL PASS'}]}]]){
    const e={name:'pwsh',callId:name,arguments:{command:'node tools/check.cjs --'+name}}
    await s.ledger.begin(e);await s.ledger.finish(e,result);await s.ledger.refresh()
    assert.throws(()=>s.change({...base,replacementId:s.ledger.last[0].checkId}),/Replacement/)
  }
  assert.throws(()=>s.change({...base,category:'environment',evidence:''}))
})
test('coverage reconciles skipped/missing/failed and never treats complete claimed counts as acceptance',()=>{
  const s=setup(),r={action:'coverage',group:'multi-target audit',expected:191,executed:173,failed:0,skipped:0,evidence:'Saved report; two cases absent at nine viewports'}
  s.change(r);assert.match(renderCheckProtocol(s.state(),s.ledger),/expected=191 executed=173 failed=0 skipped=0 unexecuted=18/)
  s.change({...r,skipped:18});assert.match(renderCheckProtocol(s.state(),s.ledger),/Gap.*skipped=18/)
  s.change({...r,executed:191,normalControl:'Working clean case',negativeControl:'Reverted fix fails the same behavior check'})
  const text=renderCheckProtocol(s.state(),s.ledger);assert.match(text,/counts do not certify behavior/);assert.match(text,/claims, not measured sensitivity/)
  for(const invalid of [{executed:192},{failed:174},{skipped:19},{expected:190}])assert.throws(()=>s.change({...r,...invalid}))
  s.change({...r,expected:190,reason:'Requirement changed with recorded justification; one case is outside the revised goal'})
  assert.equal(s.state().coverage[0].previousExpected,191)
  assert.match(renderCheckProtocol(s.state(),s.ledger),/191->190/)
})
test('protocol is bounded and round trips native projection without transcript or cross-session assumptions',()=>{
  const s=setup();s.change({action:'coverage',group:'transfer case',expected:3,executed:2,failed:0,skipped:1,evidence:'Saved output'})
  const value=serializeCheckProtocol(s.state()),event={type:'developer/message',data:{message:{source:{kind:FLOW_CHECK_SOURCE},content:[{type:'text',text:value}]}}}
  const state=foldNextState(initialNextState(),event)
  assert.deepEqual(readCheckProtocol(nextStateSchema.parse(JSON.parse(JSON.stringify(state))).checkProtocol),s.state())
  assert.equal(foldNextState(state,{type:'turn/start',data:{turn:2}}).checkProtocol,value)
  const {checkProtocol,...old}=initialNextState();assert.equal(nextStateSchema.parse(old).checkProtocol,null)
  assert.equal(foldNextState(initialNextState(),{...event,type:'assistant/message'}).checkProtocol,null)
  assert.throws(()=>foldNextState(state,{...event,data:{message:{source:{kind:FLOW_CHECK_SOURCE},content:[{type:'text',text:'invalid'}]}}}))
  for(let i=0;i<23;i++)s.change({action:'coverage',group:'case-'+i,expected:1,executed:0,failed:0,skipped:0,evidence:'Not run'})
  assert.throws(()=>s.change({action:'coverage',group:'overflow',expected:1,executed:0,failed:0,skipped:0,evidence:'Not run'}),/limit/)
  assert.equal(s.state().coverage.length,24)
  assert.match(renderCheckProtocol(s.state(),s.ledger),/expected=26 executed=2 failed=0 skipped=1 unexecuted=23/)
  assert.match(renderCheckProtocol(s.state(),s.ledger),/Showing 4\/24 groups with gaps/)
})
test('new process cannot apply old classification to a new execution id; history remains labeled unavailable',async()=>{
  const s=setup(),bad=await s.run('python tools/smoke-test.py',1)
  s.change({action:'classify',checkId:bad.checkId,category:'environment',reason:'Interpreter unavailable',evidence:'Recorded exit'})
  const restarted=setup();restarted.ledger.assessments=readCheckProtocol(serializeCheckProtocol(s.state())).assessments
  const newBad=await restarted.run('python tools/smoke-test.py',1,bad.callId)
  assert.notEqual(newBad.checkId,bad.checkId);assert.equal(restarted.ledger.assessmentFor(newBad),null)
  assert.match(renderCheckProtocol(s.state(),restarted.ledger),/historical receipt not available/)
})
test('restored declarations cannot fingerprint unobserved files in a new process',async()=>{
  const s=setup();s.change({action:'scope',command:'node tools/check.cjs',files:['src/runtime.js'],reason:'Previously permitted input'})
  let requested=[]
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async files=>{requested.push(...files);return{}}})
  ledger.scopes=readCheckProtocol(serializeCheckProtocol(s.state())).scopes
  const e={name:'pwsh',callId:'new-process',arguments:{command:'node tools/check.cjs'}}
  await ledger.begin(e);await ledger.finish(e,{value:{kind:'foreground',exitCode:0}});await ledger.refresh()
  assert.deepEqual(requested,[]);assert.equal(ledger.last[0].scopeKind,'observed')
  assert.equal(ledger.last[0].scopeDeclarationPending,true);assert.equal(ledger.last[0].freshness,'unknown')
  assert.match(ledger.render(),/declaration was not applied/)
  const unrelated=new FlowEvidence({root:process.cwd(),snapshot:async files=>Object.fromEntries(files.map(f=>[f,'known-notes']))})
  unrelated.observeFile('notes/task.md');unrelated.scopes=ledger.scopes
  await unrelated.begin(e);await unrelated.finish(e,{value:{kind:'foreground',exitCode:0}});await unrelated.refresh()
  assert.equal(unrelated.last[0].freshness,'observed-inputs-unchanged')
  assert.doesNotMatch(renderNextSupport(initialNextState(),unrelated),/Reuse/)
  const other={name:'pwsh',callId:'other-failure',arguments:{command:'python tools/smoke-test.py'}}
  await unrelated.begin(other);await unrelated.finish(other,{value:{kind:'foreground',exitCode:1}});await unrelated.refresh()
  assert.throws(()=>updateCheckProtocol(emptyCheckProtocol(),{action:'classify',checkId:unrelated.last[0].checkId,
    replacementId:unrelated.last[1].checkId,category:'superseded',reason:'Incomplete replacement',evidence:'A receipt with unrelated observed notes'},unrelated),/Replacement/)
})
