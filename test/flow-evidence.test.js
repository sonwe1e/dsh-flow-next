import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FlowEvidence, fingerprintObserved, EVIDENCE_LIMITS, isVerification } from '../lib/flow-evidence.js'
import { createEvidenceObserver } from '../modes/flow-evidence-policy.js'
import { initialNextState, renderNextSupport, nextSupportSignature } from '../lib/flow-next.js'

const execution = (callId, command = 'node test/smoke.js') => ({ callId, name: 'pwsh', arguments: { command } })
const zero = { value: { kind: 'foreground', exitCode: 0 }, content: [{ type: 'text', text: 'ALL PASS' }] }
const setup = () => {
  const values = { 'src/service.js': 'original', 'tests/check.js': 'test-v1' }
  const ledger = new FlowEvidence({ root: process.cwd(), snapshot: async files => Object.fromEntries(files.map(file => [file, values[file] ?? null])) })
  ledger.observeFile('src/service.js'); ledger.observeFile('tests/check.js')
  return { values, ledger }
}
const run = async (ledger, exec = execution('check'), result = zero) => { await ledger.begin(exec); await ledger.finish(exec, result); await ledger.refresh() }

test('final native outcome reaches the synchronous checkpoint before asynchronous freshness reads',async()=>{
  const observer=createEvidenceObserver({session:{header:{cwd:process.cwd()}}},{collectTests:true,onRecord:r=>records.push(structuredClone(r))})
  const records=[],exec=execution('durable','ctest -R Alpha')
  await observer.before(exec)
  let release
  observer.ledger.snapshot=()=>new Promise(resolve=>{release=()=>resolve({})})
  observer.after(exec,{value:{kind:'foreground',exitCode:1},content:[{type:'text',text:'1/1 Test #1: Alpha .... ***Failed 0.01 sec\n0% tests passed, 1 tests failed out of 1\n'}]})
  assert.equal(records.length,1)
  assert.equal(records[0].tests.cases[0].state,'failed')
  // This is the point where the host can close or abort the step. Only file
  // freshness work remains; no delayed callback is needed to persist facts.
  observer.ledger.snapshot=async()=>({});release();await observer.settle()
  assert.ok(records.length>=1)
  assert.ok(records.every(record=>record.checkId===records[0].checkId&&record.tests.cases[0].state==='failed'))
})

test('slow older file snapshots cannot evict newer concurrent outcomes or reverse the current evidence',async()=>{
  const ledger=new FlowEvidence({root:process.cwd(),collectTests:true,limits:{...EVIDENCE_LIMITS,receipts:2,outcomes:2},snapshot:async()=>({})})
  const calls=[1,2,3].map(i=>execution('parallel-'+i,'node --check source'+i+'.js'))
  for(const call of calls)await ledger.begin(call)
  const releases=[];ledger.snapshot=()=>new Promise(resolve=>releases.push(()=>resolve({})))
  const results=calls.map(call=>ledger.finish(call,zero))
  for(const i of [2,1,0]){releases[i]();await results[i]}
  ledger.snapshot=async()=>({});await ledger.refresh()
  assert.deepEqual(ledger.last.map(r=>r.callId),['parallel-3','parallel-2'])
  assert.deepEqual([...ledger.history.values()].map(r=>r.callId).sort(),['parallel-2','parallel-3'])
})

const background = jobId => ({ value: { kind: 'background', jobId }, content: [{ type: 'text', text: `started background job ${jobId}` }] })
const collect = async (ledger, id, status = 'completed', text = 'ALL PASS', detail = 'exit code: 0') => {
  await ledger.finish({ name: 'job_output', arguments: { job_id: id } }, { value: { job: { id, status, detail }, text }, content: [{ type: 'text', text }] })
  await ledger.refresh()
}

test('failures survive unrelated passes and display eviction; a matching independent check resolves them',async()=>{
  const {ledger}=setup()
  await run(ledger,execution('ts-fail','npx tsc --noEmit | Select-Object -First 30'),
    {...zero,content:[{type:'text',text:'src/service.ts(1,2): error TS2322: mismatch'}]})
  assert.equal(ledger.last[0].state,'reported-diagnostic-failure')
  for(let i=0;i<3;i++)await run(ledger,execution('other-'+i,'npx vitest run'))
  assert.equal(ledger.receipts.length,2);assert.equal(ledger.unresolved.length,1)
  assert.match(ledger.render(),/Unresolved checks/)
  assert.doesNotMatch(renderNextSupport(initialNextState(),ledger),/Reuse/)
  await run(ledger,execution('ts-fixed','npx tsc --noEmit | Select-Object -Last 12'))
  assert.equal(ledger.unresolved.length,0)
  assert.match(renderNextSupport(initialNextState(),ledger),/Reuse/)
})

test('compound outer success cannot clear each constituent failure; invocation arguments and cwd remain distinct',async()=>{
  const {ledger}=setup(),fail={...zero,content:[{type:'text',text:'Tests  1 failed | 3 passed (4)'}]}
  await run(ledger,execution('compound','npx tsc --noEmit; npx vitest run'),fail)
  assert.equal(ledger.last[0].aggregate,true);assert.equal(ledger.unresolved[0].remainingKeys.length,2)
  await run(ledger,execution('outer-zero','npx tsc --noEmit; npx vitest run'))
  assert.equal(ledger.unresolved[0].remainingKeys.length,2)
  await run(ledger,execution('different-args','npx vitest run tests/selected.test.ts'))
  assert.equal(ledger.unresolved[0].remainingKeys.length,2)
  await run(ledger,{...execution('different-cwd','npx vitest run'),arguments:{command:'npx vitest run',workdir:'subdir'}})
  assert.equal(ledger.unresolved[0].remainingKeys.length,2)
  await run(ledger,execution('ts','npx tsc --noEmit'))
  assert.equal(ledger.unresolved[0].remainingKeys.length,1)
  await run(ledger,execution('test','npx vitest run'))
  assert.equal(ledger.unresolved.length,0)
})

test('unresolved tracking is bounded and exceeding the limit retains an explicit unknown scope',async()=>{
  const {ledger}=setup();ledger.limits={...EVIDENCE_LIMITS,outcomes:2}
  for(let i=0;i<3;i++)await run(ledger,execution('fail-'+i,`node tests/check-${i}.cjs`),{...zero,isError:true})
  assert.equal(ledger.unresolved.length,2);assert.equal(ledger.outcomesTruncated,true)
  for(let i=0;i<3;i++)await run(ledger,execution('fix-'+i,`node tests/check-${i}.cjs`))
  assert.equal(ledger.unresolved.length,0)
  assert.match(ledger.render(),/Earlier unresolved checks exceeded/)
  assert.doesNotMatch(renderNextSupport(initialNextState(),ledger),/Reuse/)
})

test('new writes displace inventory at the observation cap; later reads never displace retained writes',async()=>{
  const values={},ledger=new FlowEvidence({root:process.cwd(),snapshot:async files=>Object.fromEntries(files.map(f=>[f,values[f]??null]))})
  for(let i=0;i<24;i++){values[`inventory-${i}.js`]='read';ledger.observeFile(`inventory-${i}.js`)}
  await run(ledger)
  for(let i=0;i<12;i++){
    const file=`changed-${i}.js`;values[file]='changed'
    await ledger.finish({name:'write',arguments:{file_path:file}},{})
  }
  assert.equal(ledger.files.size,24);assert.equal(ledger.edited.size,12)
  assert.ok([...ledger.edited].every(f=>ledger.files.has(f)))
  await ledger.refresh()
  assert.equal(ledger.last[0].freshness,'unknown');assert.equal(ledger.last[0].omittedInputs.length,12)
  assert.equal(ledger.last[0].laterEditedFiles.length,12)
  assert.doesNotMatch(renderNextSupport(initialNextState(),ledger),/Reuse/)
  await run(ledger,execution('new-scope'))
  assert.ok([...ledger.edited].every(f=>Object.hasOwn(ledger.last[0].files,f)))
  values['changed-11.js']='regression';await ledger.refresh()
  assert.equal(ledger.last[0].freshness,'stale')
  for(let i=12;i<30;i++){
    const file=`changed-${i}.js`;values[file]='changed'
    await ledger.finish({name:'edit',arguments:{file_path:file}},{})
  }
  assert.equal(ledger.files.size,24);assert.equal(ledger.edited.size,24)
  const retained=[...ledger.files];ledger.observeFile('later-read.js')
  assert.deepEqual([...ledger.files],retained)
  await ledger.refresh();assert.ok(ledger.last[0].omittedInputs.length>0)
  assert.match(ledger.render(),/bounded observation scope/)
})

test('a concurrent native edit and restore cannot make a running check certify unchanged inputs',async()=>{
  const {ledger}=setup(),exec=execution('running')
  await ledger.begin(exec)
  await ledger.finish({name:'edit',arguments:{file_path:'src/service.js'}},{})
  await ledger.finish({name:'edit',arguments:{file_path:'src/service.js'}},{})
  await ledger.finish(exec,zero);await ledger.refresh()
  assert.equal(ledger.last[0].changedDuringExecution,true);assert.equal(ledger.last[0].freshness,'unknown')
})

test('older background completion cannot clear a newer failure of the same invocation',async()=>{
  const {ledger}=setup()
  await run(ledger,execution('old'),background('old'))
  await run(ledger,execution('new'),{...zero,value:{kind:'foreground',exitCode:1}})
  await collect(ledger,'old')
  assert.equal(ledger.unresolved.length,1);assert.equal(ledger.unresolved[0].callId,'new')
})

test('late older job failures cannot revive a newer matching pass; changed-during-check success cannot resolve a failure',async()=>{
  const {ledger}=setup()
  await run(ledger,execution('old'),background('old'))
  await run(ledger,execution('new-pass'))
  await collect(ledger,'old','failed','Error: old job failed','exit code: 1')
  assert.equal(ledger.unresolved.length,0)
  await run(ledger,execution('failure'),{...zero,value:{kind:'foreground',exitCode:1}})
  const exec=execution('edited-during-check');await ledger.begin(exec)
  await ledger.finish({name:'edit',arguments:{file_path:'src/service.js'}},{})
  await ledger.finish(exec,zero);await ledger.refresh()
  assert.equal(ledger.unresolved.length,1)
  await run(ledger,execution('stable-pass'));assert.equal(ledger.unresolved.length,0)
})

test('only actual request acknowledgment suppresses repeated support; evidence survives previews and repeats',async()=>{
  const {values}=setup(),state=initialNextState(),observer=createEvidenceObserver({session:{header:{cwd:process.cwd()}}},
    {support:ledger=>renderNextSupport(state,ledger),supportSignature:ledger=>nextSupportSignature(state,ledger)})
  observer.ledger.snapshot=async files=>Object.fromEntries(files.map(f=>[f,values[f]??null]))
  observer.ledger.observeFile('src/service.js')
  const contexts=async()=> (await observer.assemble({contexts:[]})).contexts
  const exec=execution('failed');await observer.before(exec);observer.after(exec,{...zero,value:{kind:'foreground',exitCode:1}})
  const first=await contexts(),preview=await contexts()
  assert.deepEqual(first.find(c=>c.name==='flow:task-support'),preview.find(c=>c.name==='flow:task-support'))
  observer.acknowledgeRequest()
  const repeat=await contexts()
  assert.ok(!repeat.some(c=>c.name==='flow:task-support'))
  assert.match(repeat.find(c=>c.name==='flow:execution-evidence').text,/Unresolved checks.*failed/)
  values['src/service.js']='changed'
  assert.ok((await contexts()).some(c=>c.name==='flow:task-support'))
  state.turn++
  assert.ok((await contexts()).some(c=>c.name==='flow:task-support'))
})

test('background checks join their own terminal result, including out-of-order completion and session isolation', async () => {
  const { ledger } = setup(), other = setup().ledger
  await run(ledger, execution('build-A'), background('A'))
  await run(ledger, execution('build-B'), background('B'))
  await collect(ledger, 'A')
  assert.deepEqual(ledger.last.map(r => [r.callId,r.state]), [['build-B','unfinished'],['build-A','exited-zero']])
  await collect(other, 'B'); assert.equal(other.receipts.length, 0)
  await collect(ledger, 'B', 'completed', 'failed', 'exit code: 2')
  assert.equal(ledger.last[0].state,'failed'); assert.equal(ledger.last[0].exitCode,2)
  assert.match(ledger.render(), /job B: completed/)
})

test('streamed failures survive later clean chunks, zero exits and duplicate collections', async () => {
  for (const [text,state] of [['FAIL  test:browser','reported-test-failure'],['parse failed','reported-diagnostic-failure'],['ALL PASS (0 tests)','zero-tests'],
    ['[==========] Running 0 tests from 0 test suites.','zero-tests'], ['[  FAILED  ] PersistenceTests.UpdateThenReload','reported-test-failure'],
    ['99% tests passed, 1 tests failed out of 386','reported-test-failure']]) {
    const { ledger } = setup()
    await run(ledger,execution('stream'), {...background('stream'),value:{kind:'promoted',jobId:'stream'}})
    await collect(ledger,'stream','running',text,'')
    assert.equal(ledger.last[0].state,'unfinished')
    await collect(ledger,'stream','completed','ALL PASS')
    assert.equal(ledger.last[0].state,state)
    await collect(ledger,'stream','completed','ALL PASS')
    assert.equal(ledger.last[0].state,state); assert.equal(ledger.receipts.length,1)
  }
})

test('job completion cannot certify cancellation, missing exit details, failed reads or mismatched jobs', async () => {
  for (const [status,detail,state] of [['killed','exit code: 0','unfinished'],['failed','','failed'],['completed','','unfinished']]) {
    const { ledger }=setup(); await run(ledger,execution('job'),background('job'))
    await collect(ledger,'job',status,'ALL PASS',detail); assert.equal(ledger.last[0].state,state)
  }
  const { ledger }=setup(); await run(ledger,execution('job'),background('job'))
  await ledger.finish({name:'job_output',arguments:{job_id:'job'}},{isError:true,value:{job:{id:'job',status:'completed',detail:'exit code: 0'}}})
  await ledger.finish({name:'job_output',arguments:{job_id:'job'}},{value:{job:{id:'other',status:'completed',detail:'exit code: 0'},text:'ALL PASS'}})
  await ledger.refresh(); assert.equal(ledger.last[0].state,'unfinished')
  await collect(ledger,'job','completed','[status: completed, exit code: 0]','')
  assert.equal(ledger.last[0].state,'unfinished','stdout cannot supply missing producer metadata')
})

test('changes between background launch and collection, including change then restore, remain unverified', async () => {
  const { ledger,values }=setup()
  await run(ledger,execution('job'),background('job'))
  values['src/service.js']='broken'; await ledger.refresh()
  values['src/service.js']='original'; await collect(ledger,'job')
  assert.equal(ledger.last[0].state,'exited-zero'); assert.equal(ledger.last[0].freshness,'unknown')
  const second=setup()
  await run(second.ledger,execution('job'),background('job'))
  await second.ledger.finish({name:'edit',arguments:{file_path:'src/service.js'}},{})
  await collect(second.ledger,'job')
  assert.equal(second.ledger.last[0].freshness,'unknown')
  values['src/service.js']='later'; await ledger.refresh(); assert.equal(ledger.last[0].freshness,'stale')
})

test('job tracking stays bounded and reused job ids remain ambiguous rather than passing', async () => {
  const { ledger }=setup()
  for (let i=0;i<20;i++) await run(ledger,execution('job-'+i),background('job-'+i))
  assert.equal(ledger.jobs.size,16); assert.equal(ledger.receipts.length,2)
  await run(ledger,execution('reused'),background('job-19'))
  await collect(ledger,'job-19'); assert.ok(ledger.receipts.every(r=>r.state==='unfinished'))
})

test('evidence distinguishes unchanged inputs from a later semantic regression or a modified test', async () => {
  const { values, ledger } = setup()
  await run(ledger)
  assert.equal(ledger.last[0].freshness, 'observed-inputs-unchanged')
  values['src/service.js'] = 'references-undefined-variable'
  await ledger.refresh()
  assert.equal(ledger.last[0].freshness, 'stale')
  assert.match(ledger.render(), /Assess relevance.*rerun affected checks/)
  assert.match(ledger.render(), /Unrelated notes alone need no rerun/)
  values['src/service.js'] = 'original'; values['tests/check.js'] = 'test-v2'
  await ledger.refresh()
  assert.deepEqual(ledger.last[0].changed, ['tests/check.js'])
})

test('a new auxiliary file does not falsely invalidate previously observed inputs or certify the new file', async () => {
  const { values, ledger } = setup()
  await run(ledger)
  values['probe.js'] = 'new auxiliary script'; ledger.observeFile('probe.js')
  await ledger.refresh()
  assert.equal(ledger.last[0].freshness, 'observed-inputs-unchanged')
  assert.deepEqual(ledger.last[0].laterObservedFiles, ['probe.js'])
  assert.match(ledger.render(), /outside that receipt/)
})

test('zero-test, failed, cancelled and background executions never become passed checks', async () => {
  for (const [result, expected] of [
    [{ ...zero, content: [{ type: 'text', text: 'ALL PASS (0 tests)' }] }, 'zero-tests'],
    [{ ...zero, content: [{ type: 'text', text: 'FORMAT=0\nLINT=0\nTEST=0\n100% tests passed, 0 tests failed out of 390' }] }, 'exited-zero'],
    [{ ...zero, content: [{ type: 'text', text: '[==========] Running 0 tests from 0 test suites.\n[  PASSED  ] 0 tests.' }] }, 'zero-tests'],
    [{ ...zero, content: [{ type: 'text', text: '[  FAILED  ] PersistenceTests.UpdateThenReload (13 ms)' }] }, 'reported-test-failure'],
    [{ ...zero, content: [{ type: 'text', text: '99% tests passed, 1 tests failed out of 386' }] }, 'reported-test-failure'],
    [{ ...zero, value: { kind: 'foreground', exitCode: 1 } }, 'failed'],
    [{ ...zero, content: [{ type: 'text', text: 'PASS  test\nFAIL  test:browser' }] }, 'reported-test-failure'],
    [{ ...zero, content: [{ type: 'text', text: 'ℹ fail 2' }] }, 'reported-test-failure'],
    [{ ...zero, content: [{ type: 'text', text: 'ConvertFrom-Json: 从 JSON 转换失败' }] }, 'reported-diagnostic-failure'],
    [{ ...zero, content: [{ type: 'text', text: 'parse failed' }] }, 'reported-diagnostic-failure'],
    [{ ...zero, isError: true }, 'failed'],
    [{ ...zero, value: { kind: 'foreground', exitCode: 0, timedOut: true } }, 'unfinished'],
    [{ ...zero, value: { kind: 'foreground', exitCode: 0, aborted: true } }, 'unfinished'],
    [{ ...zero, value: { kind: 'background', jobId: 'running' } }, 'unfinished'],
    [{ content: [{ type: 'text', text: 'ALL PASS' }] }, 'unfinished'],
  ]) {
    const { ledger } = setup(); await run(ledger, execution(expected), result)
    assert.equal(ledger.last[0].state, expected)
  }
})

test('verification recognition follows actual runner/script positions and excludes query strings and paths', async () => {
  for (const command of ['node tests/check.cjs','node --test test/unit.test.js','npm test','npm run test:browser',
    'pnpm run typecheck','yarn lint','npx vitest run','uv run python -m pytest','python -m unittest discover',
    '& "C:\\Python\\python.exe" -m pytest','ctest --test-dir out','ruff check src','go test ./...',
    'cargo test','dotnet test','cmake --build out --target lint','pwsh -NoProfile -File tools/Test-Gates.ps1',
    '& .\\tools\\build\\build.ps1 -Test','echo "checking"; node tests/check.cjs','FOO=bar pytest']) assert.equal(isVerification(command),true,command)
  for (const command of ['Test-Path tests/check.cjs','test -f tests/check.cjs',
    "$roots=@('out/verification','test'); foreach($r in $roots){if(Test-Path $r){Get-ChildItem $r}}",
    "Get-Content 'out/verification/test-gate.log' | Select-String 'ALL PASS'",
    "rg pytest README.md","Write-Output 'node tests/check.cjs'",'echo "pytest; npm test"',
    '$message="pytest"; Write-Output $message',"Get-ChildItem @('pytest','check.ps1')",
    "Write-Output @'\nnode tests/check.cjs\n'@",'# pytest\nGet-Content test/smoke.js',
    'git diff -- test/check.cjs','node scripts/report.mjs','node -e "console.log(\'tests/check.cjs\')"',
    'python -m json.tool out/test.json','pytest --version']) assert.equal(isVerification(command),false,command)
  const {ledger}=setup(); await run(ledger,execution('inventory',"if(Test-Path tests){Get-ChildItem tests}"))
  assert.equal(ledger.receipts.length,0); assert.equal(ledger.render(),'')
})

test('unchanged assemblies compact evidence while previews, regressions and repeated ids retain current facts',async()=>{
  const {values}=setup(),observer=createEvidenceObserver({session:{header:{cwd:process.cwd()}}})
  observer.ledger.snapshot=async files=>Object.fromEntries(files.map(file=>[file,values[file]??null]))
  observer.ledger.observeFile('src/service.js'); observer.ledger.observeFile('tests/check.js')
  const assemble=async()=> (await observer.assemble({contexts:[]})).contexts.find(c=>c.name==='flow:execution-evidence')?.text??''
  const exec=execution('reused-id')
  await observer.before(exec); observer.after(exec,zero)
  const full=await assemble(),compact=await assemble()
  assert.ok(compact.length<full.length); assert.match(compact,/Observation state unchanged/)
  assert.match(compact,/exited-zero; observed-inputs-unchanged/)
  assert.equal(await assemble(),compact,'A preview must not hide the state from a later request')
  values['src/service.js']='broken'; const stale=await assemble()
  assert.match(stale,/stale/); assert.match(stale,/src\/service.js/); assert.doesNotMatch(stale,/Observation state unchanged/)
  const shortStale=await assemble(); assert.match(shortStale,/stale/); assert.match(shortStale,/Assess relevance.*rerun affected checks/)
  values['src/service.js']='original'; await assemble()
  await observer.before(exec); observer.after(exec,{...zero,value:{kind:'foreground',exitCode:1}})
  const failed=await assemble(); assert.match(failed,/failed;/); assert.match(failed,/check #2/)
  assert.doesNotMatch(failed,/Observation state unchanged/)
  const shortFailed=await assemble(); assert.match(shortFailed,/failed;/); assert.match(shortFailed,/not a pass/)
})

test('inputs modified during a check cannot be certified unchanged by its zero exit', async () => {
  const { values, ledger } = setup(), exec = execution('format-and-test')
  await ledger.begin(exec); values['src/service.js'] = 'formatter changed input'
  await ledger.finish(exec, zero); await ledger.refresh()
  assert.equal(ledger.last[0].freshness, 'unknown')
  assert.equal(ledger.last[0].changedDuringExecution, true)
})

test('absent, unreadable and unobserved inputs remain unknown; denied writes do not become observations', async () => {
  const empty = new FlowEvidence({ root: process.cwd() })
  await run(empty)
  assert.equal(empty.last[0].freshness, 'unknown')
  const { ledger, values } = setup()
  await ledger.finish({ name: 'write', arguments: { file_path: 'blocked.js' } }, { isError: true })
  assert.equal(ledger.files.has('blocked.js'), false)
  await run(ledger); delete values['src/service.js']; await ledger.refresh()
  assert.equal(ledger.last[0].freshness, 'unknown')
})

test('observations and feedback stay bounded and pending checks are not exposed as completed', async () => {
  const { ledger } = setup()
  for (let i = 0; i < 40; i++) ledger.observeFile(`file-${i}.js`)
  assert.equal(ledger.files.size, EVIDENCE_LIMITS.files)
  for (let i = 0; i < 4; i++) await run(ledger, execution('check-'+i))
  assert.equal(ledger.receipts.length, EVIDENCE_LIMITS.receipts)
  assert.ok(ledger.render().length <= EVIDENCE_LIMITS.promptChars)
  await ledger.begin(execution('pending'))
  assert.equal(await ledger.refresh(), null)
  const freshSession = new FlowEvidence({ root: process.cwd() })
  assert.equal(freshSession.render(), '')
})

test('real byte fingerprints detect equal-size edits with preserved mtime and bound file reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-evidence-'))
  try {
    const file = path.join(root, 'service.js')
    await fs.writeFile(file, 'good'); const original = await fs.stat(file)
    const before = await fingerprintObserved(root, ['service.js'])
    await fs.writeFile(file, 'oops'); await fs.utimes(file, original.atime, original.mtime)
    const after = await fingerprintObserved(root, ['service.js'])
    assert.notEqual(before['service.js'], after['service.js'])
    assert.equal((await fingerprintObserved(root, ['service.js'], { files: 1, bytes: 1 }))['service.js'], null)
    assert.equal((await fingerprintObserved(root, ['../outside.js']))['../outside.js'], null)
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('flow-evidence-'))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('external native write/restore invalidates a running check without granting file observations',async()=>{
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async files=>Object.fromEntries(files.map(file=>[file,'a'.repeat(64)]))})
  ledger.observeFile('input.js');const exec=execution('concurrent','node --check input.js');await ledger.begin(exec)
  ledger.observeExternalEdit(path.join(process.cwd(),'input.js'))
  await ledger.finish(exec,zero);await ledger.refresh()
  assert.equal(ledger.last[0].changedDuringExecution,true);assert.equal(ledger.last[0].freshness,'unknown')
  ledger.observeExternalEdit(path.join(process.cwd(),'unobserved.js'));assert.equal(ledger.files.has('unobserved.js'),false)
})
test('active job receipt survives unrelated history-window eviction until its native collection',async()=>{
  const ledger=new FlowEvidence({root:process.cwd(),snapshot:async()=>({}),limits:{...EVIDENCE_LIMITS,outcomes:2}})
  await run(ledger,execution('active','node test/active-check.js'),{value:{kind:'background',jobId:'active-job'}})
  const id=ledger.last[0].checkId
  for(let i=0;i<5;i++)await run(ledger,execution('later-'+i))
  assert.ok(ledger.history.has(id));assert.ok(ledger.history.size<=3)
  await ledger.finish({name:'job_output',arguments:{job_id:'active-job'}},{value:{job:{id:'active-job',status:'completed',detail:'exit code: 0'},text:'ALL PASS'}})
  assert.equal(ledger.getRecord(id).state,'exited-zero')
})

test('Rust toolchain-prefixed checks are recognized while ordinary builds stay outside passive test observation',()=>{
  assert.equal(isVerification('cargo +stable test --no-run'),true)
  assert.equal(isVerification('cargo +nightly clippy'),true)
  assert.equal(isVerification('cargo fmt --check'),true)
  assert.equal(isVerification('cargo +stable build'),false)
  assert.equal(isVerification('cargo +stable --version'),false)
})
