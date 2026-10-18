import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestObservation,observeTestOutput,summarizeTestObservation } from '../lib/test-observations.js'
import { stageCheck,stageReport } from '../lib/flow-stage.js'
import { checkBinding,createCheckResources } from '../lib/flow-check-run.js'
const observe=(text,command='ctest',expected=[])=>{const state=createTestObservation(expected,{command,cwd:'G:/repo'});observeTestOutput(state,text,{terminal:true});return summarizeTestObservation(state,{terminal:true})}
const receipt=tests=>({id:'a'.repeat(16),callId:'call',rootCallId:'root',toolName:'pwsh',command:'ctest',state:'exited-zero',exitCode:0,jobId:null,sequence:1,tests,originSessionId:'root',files:{'test.js':'a'.repeat(64)}})

test('1348 CTest cases retain exact disjoint totals beyond inline bound and critical membership',()=>{
  const lines=Array.from({length:1348},(_,i)=>`${i+1}/1348 Test #${i+1}: case${i} .... ${i>=1344?'***Not Run (Disabled)':i>=1340?'***Skipped':'Passed'} 0.01 sec`)
  const tests=observe(lines.join('\n')+'\n100% tests passed, 0 tests failed out of 1344\n','ctest',[{name:'case1347',match:'exact',origin:'agent-declared'}])
  assert.equal(tests.complete,false);assert.equal(tests.streamComplete,true);assert.equal(tests.omittedCases,836);assert.equal(tests.expectations[0].observed,1)
  const row=stageCheck(receipt(tests),{currentSessionId:'root'});assert.deepEqual(row.counts,{passed:1340,failed:0,skipped:4,disabled:4,ignored:0,todo:0});assert.equal(row.registered,1348)
})
test('duplicate identity beyond inline limit prevents stream certification; real truncation remains unknown',()=>{
  const lines=Array.from({length:520},(_,i)=>`${i+1}/521 Test #${i+1}: case${i} .... Passed 0.01 sec`)
  const tests=observe(lines.join('\n')+'\n521/521 Test #521: case519 .... ***Failed 0.01 sec\n100% tests passed, 0 tests failed out of 521\n')
  assert.equal(tests.ambiguous,true);assert.equal(stageCheck(receipt(tests)).counts,null)
  const state=createTestObservation();observeTestOutput(state,'1/1 Test #1: A .... Passed\n100% tests passed, 0 tests failed out of 1\n',{terminal:true});state.dataTruncated=true;state.truncated=true
  assert.equal(summarizeTestObservation(state,{terminal:true}).streamComplete,false)
})
test('Rust ignored/build-only and Vitest aggregate/named/JSON states remain distinct',()=>{
  const rust=observe('running 2 tests\ntest a ... ok\ntest b ... ignored\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out;\n','cargo test')
  assert.equal(rust.complete,true);assert.equal(rust.streamCounts.ignored,1)
  assert.equal(observe('Finished test profile\n','cargo test --no-run').execution.mode,'build-only')
  const vitest=observe(' RUN v3.0.0 G:/repo\n Tests 2 passed | 1 skipped (3)\n','npx vitest run')
  assert.equal(vitest.complete,false);assert.equal(vitest.aggregateComplete,true);assert.equal(stageCheck(receipt(vitest)).counts.passed,2)
  const json=observe(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:1,success:true,testResults:[{name:'G:/repo/a.test.js',assertionResults:[{fullName:'suite ok',status:'passed'},{fullName:'suite todo',status:'todo'}]}]})+'\n','npx vitest run --reporter=json')
  assert.equal(json.complete,true);assert.equal(json.cases[0].name,'a.test.js > suite ok');assert.equal(json.streamCounts.todo,1)
})
test('stage report never adds retries or child counts into one suite and retains old failure',()=>{
  const a=receipt(observe('1/1 Test #1: A .... ***Failed\n0% tests passed, 1 tests failed out of 1\n'));a.state='failed';a.exitCode=8
  const b={...receipt(observe('1/1 Test #1: A .... Passed\n100% tests passed, 0 tests failed out of 1\n')),id:'b'.repeat(16)}
  const report=stageReport({sessionId:'root',runs:[a,b],children:[{sessionId:'child',checks:[b]}]})
  assert.equal(report.checks.length,2);assert.equal(report.checks[0].counts.failed,1);assert.equal(report.checks[1].counts.passed,1);assert.equal(report.acceptance,'not-certified');assert.equal(report.totalPassed,undefined)
})
test('changed validator and removed expected name remain explicit despite clean current runner result',()=>{
  const args={label:'gate',command:'ctest',definitions:['test.js'],expectedTests:['critical'],environment:'toolchain-1',amendmentReason:''}
  const before=checkBinding(args,{inputs:{'test.js':'a'.repeat(64)}})
  const after=checkBinding({...args,expectedTests:[]},{inputs:{'test.js':'b'.repeat(64)},previous:{id:'a'.repeat(16),binding:before}})
  const row=stageCheck({...receipt(null),binding:after,files:{'test.js':'b'.repeat(64)}})
  assert.deepEqual(row.validationChanges.definitions,['test.js']);assert.deepEqual(row.validationChanges.removedExpectedTests,['critical']);assert.equal(row.validationChanges.reason,'');assert.match(row.attribution,/unattributed/)
})
test('resource admission prevents duplicate launch, binds native job and releases only matching owner',()=>{
  const r=createCheckResources();assert.equal(r.acquire('build','parent','call-A').acquired,true);r.bind('build','call-A','native-job')
  const blocked=r.acquire('build','child','call-B');assert.equal(blocked.acquired,false);assert.equal(blocked.jobId,'native-job')
  r.releaseJob('child','native-job');assert.equal(r.acquire('build','child','call-B').acquired,false)
  r.releaseJob('parent','native-job');assert.equal(r.acquire('build','child','call-B').acquired,true)
})

test('native checks without explicit links still expose changed observed inputs and new disabling',()=>{
  const a={...receipt(observe('1/2 Test #1: A .... Passed\n2/2 Test #2: B .... Passed\n100% tests passed, 0 tests failed out of 2\n')),commandSha256:'c'.repeat(64),cwd:'G:/repo',inputBefore:{'test.js':'a'.repeat(64)}}
  const b={...receipt(observe('1/2 Test #1: A .... Passed\n2/2 Test #2: B .... ***Not Run (Disabled)\n100% tests passed, 0 tests failed out of 1\n')),id:'b'.repeat(16),commandSha256:'c'.repeat(64),cwd:'G:/repo',files:{'test.js':'b'.repeat(64)},inputBefore:{'test.js':'b'.repeat(64)}}
  const view=stageReport({sessionId:'root',runs:[a,b]}),change=view.checks[1].observedChangesSincePrior
  assert.deepEqual(change.files,['test.js']);assert.equal(change.disabledDelta,1);assert.equal(change.runnerSetChanged,true);assert.equal(b.binding,undefined)
})
test('streamed set identity ignores runner interleaving order but detects outcome changes',()=>{
  const first=observe('1/2 Test #1: A .... Passed\n2/2 Test #2: B .... Passed\n100% tests passed, 0 tests failed out of 2\n')
  const reversed=observe('1/2 Test #2: B .... Passed\n2/2 Test #1: A .... Passed\n100% tests passed, 0 tests failed out of 2\n')
  const changed=observe('1/2 Test #2: B .... ***Skipped\n2/2 Test #1: A .... Passed\n100% tests passed, 0 tests failed out of 2\n')
  assert.equal(first.caseSetSha256,reversed.caseSetSha256);assert.notEqual(first.caseSetSha256,changed.caseSetSha256)
})

test('pending JSON assertions and overflowed Rust groups cannot certify terminal completion',()=>{
  const pending=observe(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:0,numPendingTests:1,numTodoTests:0,success:true,testResults:[{name:'G:/repo/a.test.js',assertionResults:[{fullName:'ok',status:'passed'},{fullName:'still queued',status:'pending'}]}]})+'\n','npx vitest run --reporter=json')
  assert.equal(pending.complete,false);assert.equal(pending.aggregateComplete,false);assert.equal(pending.cases.some(row=>row.name.includes('queued')),false)
  const rust=observe(Array.from({length:513},(_,i)=>`running 1 test\ntest case${i} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n`).join(''),'cargo test')
  assert.equal(rust.streamComplete,false);assert.equal(rust.aggregateComplete,false)
})
