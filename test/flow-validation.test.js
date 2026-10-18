import test from 'node:test'
import assert from 'node:assert/strict'
import { FlowEvidence } from '../lib/flow-evidence.js'
import { selectorExpectations,createTestObservation,observeTestOutput,summarizeTestObservation } from '../lib/test-observations.js'
import { initialValidationState,recordValidation,foldValidation,validationReport,renderValidationReport,FLOW_VALIDATION_SOURCE,VALIDATION_LIMITS } from '../lib/flow-validation.js'
const output=(rows)=>rows.map(([name,state],i)=>`${i+1}/${rows.length} Test #${i+1}: ${name} ........ ${state==='passed'?'Passed':state==='disabled'?'***Not Run (Disabled)':state==='skipped'?'***Skipped':'***Failed'} 0.01 sec`).join('\n')+
  `\n${rows.some(r=>r[1]==='failed')?'50':'100'}% tests passed, ${rows.filter(r=>r[1]==='failed').length} tests failed out of ${rows.filter(r=>!['disabled','skipped'].includes(r[1])).length}\n`
const setup=()=>{
  let state=initialValidationState(),index=0
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async names=>Object.fromEntries(names.map(n=>[n,'a'.repeat(64)])),collectTests:true,onRecord:r=>{state={...recordValidation(state,r),surfaceSeq:null}}})
  ledger.observeFile('runtime.cjs')
  const run=async(command,rows,exitCode=0)=>{
    const e={name:'pwsh',callId:'call-'+ ++index,arguments:{command}}
    await ledger.begin(e);await ledger.finish(e,{value:{kind:'foreground',exitCode},content:[{type:'text',text:typeof rows==='string'?rows:output(rows)}]});await ledger.refresh();return ledger.last?.[0]
  }
  return {ledger,run,state:()=>state}
}
test('literal alternatives come from a real check invocation, with no arbitrary regex evaluation',()=>{
  assert.deepEqual(selectorExpectations("ctest -R '^suite\\.(Alpha|Beta)$'").map(e=>e.name),['suite.Alpha','suite.Beta'])
  assert.equal(selectorExpectations("pwsh tools/build.ps1 -Test -TestRegex 'ui\\.(Images|Theme)' ").length,2)
  for(const command of ['Write-Output "ctest -R \'a|(b)\'"',"ctest -R '(a+|b)'", "ctest -R '(a|b)' -R c", "ctest -R '(a|b)'; ctest -R c", "ctest -R '(a|b)' --help",'ctest -R "$name(a|b)"',"ctest -R '(a.b|c)'", "ctest -R '(a|(b|c))'"])
    assert.deepEqual(selectorExpectations(command),[],command)
})
test('normal matched sets keep a zero; nonzero aggregate cannot hide a missing branch or case mismatch',async()=>{
  const s=setup(),command="ctest -R 'suite\\.(Images|Theme)'"
  const good=await s.run(command,[['suite.Images','passed'],['suite.Theme','passed']]);assert.equal(good.state,'exited-zero');assert.equal(good.tests.selection,'observed')
  const bad=await s.run(command,[['suite.Theme','passed'],['suite.ThemeExtra','passed']]);assert.equal(bad.state,'test-selection-gap')
  assert.equal(bad.tests.counts.passed,2);assert.equal(bad.tests.expectations[0].observed,0)
  const caseMismatch=await s.run(command,[['suite.images','passed'],['suite.Theme','passed']]);assert.equal(caseMismatch.tests.selection,'gap')
})
test('disabled/skipped are named states and cannot be claimed as passed or not observed',async()=>{
  const s=setup(),r=await s.run('ctest',[['A','passed'],['B','disabled'],['C','skipped']])
  assert.equal(r.tests.complete,true);assert.deepEqual(r.tests.counts,{passed:1,failed:0,skipped:1,disabled:1})
  for(const state of ['passed','not-observed'])assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'B',state}]}),/Contradicted/)
})
test('failed-to-not-run and failed-to-passed claims reject; report facts cannot be overwritten by prose',async()=>{
  const s=setup(),r=await s.run('ctest',[['A','passed'],['B','failed']],8)
  for(const state of ['passed','not-observed'])assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'B',state}]}),/Contradicted/)
  assert.equal(validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'B',state:'failed'}]}).claimsChecked,1)
  assert.match(renderValidationReport(validationReport(s.state(),s.ledger)),/failed: B/)
  assert.equal(validationReport(s.state(),s.ledger).acceptance,'not-certified')
})
test('partial output, summary-only, duplicates and multi-run logs cannot establish absence',async()=>{
  for(const text of ['100% tests passed, 0 tests failed out of 21\n',output([['A','passed']]).replace('1/1','1/2'),output([['A','passed'],['A','passed']]),output([['A','passed']])+output([['B','passed']])]){
    const s=setup(),r=await s.run("ctest -R '(A|B)'",text)
    assert.equal(r.tests.complete,false);assert.equal(r.state,'test-results-incomplete')
    assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'C',state:'not-observed'}]}),/unprovable/)
  }
})
test('repeated names with conflicting outcomes cannot certify either first or last outcome',async()=>{
  for(const rows of [[['A','passed'],['A','failed']],[['A','failed'],['A','passed']],[['A','passed'],['A','passed']]]){
    const s=setup(),r=await s.run('ctest --repeat until-fail:2',rows)
    assert.equal(r.tests.ambiguous,true);assert.equal(r.tests.complete,false)
    for(const state of ['passed','failed','not-observed'])assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'A',state}]}),/ambiguous/)
    // The observed prefix remains inspectable, without claiming it is a unique
    // final result for the repeated identity.
    assert.equal(validationReport(s.state(),s.ledger).runs[0].tests.cases[0].state,rows[0][1])
  }
})
test('truncated output cannot certify a retained passing case that may have a missing later failure',async()=>{
  const s=setup(),r=await s.run('ctest',Array.from({length:513},(_,i)=>['case'+i,'passed']))
  assert.equal(r.tests.truncated,true)
  assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'case0',state:'passed'}]}),/truncated/)
})
test('streamed job fragments retain per-test failures, final state is producer-owned, and late jobs keep ids',async()=>{
  const s=setup(),e={name:'pwsh',callId:'background',arguments:{command:"ctest -R '(A|B)'"}}
  await s.ledger.begin(e);await s.ledger.finish(e,{value:{kind:'background',jobId:'job'}})
  const id=s.state().runs[0].id,full=output([['A','passed'],['B','failed']]),cut=full.indexOf('B')+1
  const chunk=async(text,status,detail)=>s.ledger.finish({name:'job_output',arguments:{job_id:'job'}},{value:{job:{id:'job',status,detail},text}})
  await chunk(full.slice(0,cut),'running','working');assert.equal(s.state().runs[0].state,'unfinished')
  await s.run('ctest -R C',[['C','passed']])
  await chunk(full.slice(cut),'failed','exit code: 8')
  assert.equal(s.state().runs[0].id,id);assert.equal(s.state().runs[0].tests.cases.find(c=>c.name==='B').state,'failed')
  assert.equal(s.state().runs[1].tests.cases[0].name,'C')
})
test('file reads and printed commands never create test receipts; unknown native terminal is not success',async()=>{
  const s=setup()
  await s.ledger.finish({name:'read',arguments:{file_path:'old.log'}},{content:[{type:'text',text:output([['A','passed']])}]})
  await s.run('Write-Output "ctest"',output([['A','passed']]))
  assert.equal(s.state().runs.length,0)
  const e={name:'pwsh',callId:'unknown',arguments:{command:'ctest'}}
  await s.ledger.begin(e);await s.ledger.finish(e,{content:[{type:'text',text:output([['A','passed']])}]})
  assert.equal(s.state().runs[0].state,'unfinished');assert.equal(s.state().runs[0].tests,null)
})
test('prospective exact test declarations detect equal-sized substituted sets for any admitted wrapper',async()=>{
  const {declaredCheckDescriptor}=await import('../lib/flow-evidence.js')
  const s=setup(),command='./tools/project.ps1 -Target compile',descriptor=declaredCheckDescriptor(s.ledger.root,command,'.','pwsh')
  s.ledger.scopes=[{...descriptor,command,files:['runtime.cjs'],expectedTests:['Alpha','Beta']}]
  const r=await s.run(command,[['Alpha','passed'],['Gamma','passed']])
  assert.equal(r.tests.selection,'gap');assert.equal(r.tests.expectations[1].origin,'agent-declared')
  await s.run(command+' -Other',[['Alpha','passed']]);assert.equal(s.state().runs.length,1)
})
test('empty and unsupported output retain prospective expected names and cannot clear prior failure',async()=>{
  const {declaredCheckDescriptor}=await import('../lib/flow-evidence.js')
  for(const text of ['', 'custom runner done: 2 successes\n']){
    const s=setup(),command='./tools/project.ps1 -Target compile',descriptor=declaredCheckDescriptor(s.ledger.root,command,'.','pwsh')
    s.ledger.scopes=[{...descriptor,command,files:['runtime.cjs'],expectedTests:['Alpha','Beta']}]
    const failed=await s.run(command,[['Alpha','failed'],['Beta','passed']],8)
    const r=await s.run(command,text)
    assert.equal(r.state,'test-results-incomplete');assert.equal(r.exitCode,0)
    assert.equal(r.tests.runner,'unknown');assert.equal(r.tests.selection,'unknown');assert.equal(r.tests.complete,false)
    assert.deepEqual(r.tests.expectations.map(e=>[e.name,e.observed]),[['Alpha',0],['Beta',0]])
    assert.ok(s.ledger.unresolved.length>0)
    const report=validationReport(s.state(),s.ledger)
    assert.equal(report.runs.find(row=>row.id===failed.checkId).tests.cases[0].state,'failed')
    assert.match(renderValidationReport(report),/NOT OBSERVED "Alpha"/)
    for(const state of ['passed','not-observed'])assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:r.checkId,claims:[{test:'Alpha',state}]}),/unprovable/)
  }
  const noPromise=setup(),plain=await noPromise.run('node --check runtime.cjs','')
  assert.equal(plain.state,'exited-zero');assert.equal(plain.tests,null)
  const branch=setup(),r=await branch.run("ctest -R '(Alpha|Beta)'",'')
  assert.equal(r.tests.runner,'unknown');assert.equal(r.state,'test-results-incomplete')
})
test('native checkpoint restores facts but never pretends old checks were revalidated',async()=>{
  const s=setup(),r=await s.run('ctest',[['broken','failed']],8)
  const payload=recordValidation(initialValidationState(),r)
  const event={seq:100,type:'developer/message',data:{message:{source:{kind:FLOW_VALIDATION_SOURCE},content:[{type:'text',text:JSON.stringify(payload)}]}}}
  const restored=foldValidation(initialValidationState(),event)
  assert.equal(validationReport(restored).runs[0].freshness,'historical-not-revalidated')
  assert.throws(()=>validationReport(restored,null,{checkId:r.checkId,claims:[{test:'broken',state:'not-observed'}]}))
  assert.deepEqual(foldValidation(initialValidationState(),{...event,type:'assistant/message'}),initialValidationState())
  assert.throws(()=>foldValidation(initialValidationState(),{...event,data:{message:{source:{kind:FLOW_VALIDATION_SOURCE},content:[{type:'text',text:'invalid'}]}}}))
})
test('origin survives replay and inherited checks cannot masquerade as current-session executions',async()=>{
  const s=setup(),r=await s.run('ctest',[['A','passed']])
  const payload=recordValidation(initialValidationState(),r,{originSessionId:'parent-session'})
  const event={seq:31,type:'developer/message',data:{message:{source:{kind:FLOW_VALIDATION_SOURCE},content:[{type:'text',text:JSON.stringify(payload)}]}}}
  const restored=foldValidation(initialValidationState(),event)
  const parent=validationReport(restored,s.ledger,{currentSessionId:'parent-session'})
  assert.equal(parent.runs[0].origin,'current-session');assert.equal(parent.runs[0].freshness,'observed-inputs-unchanged')
  const child=validationReport(restored,s.ledger,{currentSessionId:'child-session'})
  assert.equal(child.runs[0].origin,'inherited-session');assert.equal(child.runs[0].originSessionId,'parent-session')
  assert.equal(child.runs[0].freshness,'inherited-not-revalidated');assert.match(renderValidationReport(child),/origin=inherited-session \(parent-session\)/)
  assert.throws(()=>recordValidation(payload,r,{originSessionId:'child-session'}),/originating session/)
  assert.equal(recordValidation(payload,r).runs[0].originSessionId,'parent-session')
  const legacy=recordValidation(initialValidationState(),r)
  assert.equal(validationReport(legacy,s.ledger,{currentSessionId:'child-session'}).runs[0].origin,'unknown')
  assert.equal(validationReport(legacy).runs[0].originSessionId,null)
})
test('compact reports keep every retained exceptional id before truncation and prioritize adverse results',async()=>{
  const s=setup(),exceptionIds=[]
  for(let i=0;i<VALIDATION_LIMITS.runs;i++){
    const rows=i===3?[['Broken','failed']]:i===5?[['Only','passed']]:[['Good','passed']]
    const command=i===5?"ctest -R '(Only|Missing)'":'ctest --label-regex '+ 'long'.repeat(70)
    const r=await s.run(command,rows,i===3?8:0)
    if(i===3||i===5)exceptionIds.push(r.checkId)
  }
  const report=validationReport(s.state()),compact=renderValidationReport(report,{compact:true}),header=compact.split('\n').slice(0,3).join('\n')
  assert.ok(compact.length<=VALIDATION_LIMITS.promptChars)
  assert.match(header,/nonpassing\/incomplete runs=2/)
  for(const id of exceptionIds)assert.ok(header.includes(id))
  assert.ok(compact.indexOf('failed: Broken')<compact.indexOf('exited-zero'))
  assert.match(compact,/test-selection-gap/)
  const allExceptional={...report,runs:report.runs.map(r=>({...r,state:'test-results-incomplete'}))}
  const allHeader=renderValidationReport(allExceptional,{compact:true}).split('\n').slice(0,3).join('\n')
  for(const r of allExceptional.runs)assert.ok(allHeader.includes(r.id))
})
test('a later pass retains earlier failure history and bounds never silently become complete coverage',async()=>{
  const s=setup(),bad=await s.run('ctest',[['A','failed']],8);await s.run('ctest',[['A','passed']])
  assert.equal(validationReport(s.state(),s.ledger).runs.find(r=>r.id===bad.checkId).tests.cases[0].state,'failed')
  for(let i=0;i<VALIDATION_LIMITS.runs;i++)await s.run('ctest',[['A','passed']])
  assert.ok(s.state().omitted>0);assert.throws(()=>validationReport(s.state(),s.ledger,{checkId:bad.checkId}),/Unknown/)
  const observation=createTestObservation();observeTestOutput(observation,output(Array.from({length:513},(_,i)=>['case'+i,'passed'])),{terminal:true})
  assert.equal(summarizeTestObservation(observation,{terminal:true}).complete,false);assert.equal(observation.truncated,true)
})
