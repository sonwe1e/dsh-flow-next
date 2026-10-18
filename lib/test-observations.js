// Runner output is diagnostic evidence, never an independent grader. Only the
// native shell/job observation path calls this parser; file reads do not.
import { verificationInvocations } from './verification-command.js'
import { createHash } from 'node:crypto'

export const TEST_OBSERVATION_LIMITS = Object.freeze({ cases: 512, identities: 16384, name: 240, line: 4096, selectors: 24, jsonChars: 2097152 })
const tokens = text => text.match(/"(?:\\.|`.|[^"\\])*"|'(?:''|[^'])*'|[^\s]+/g) ?? []
const unquote = text => /^["']/.test(text) ? text.slice(1,-1) : text
// Intentionally small grammar: literal alternatives with an optional common
// prefix/suffix. No arbitrary regex execution, shell expansion or ReDoS surface.
function literal(text) {
  if (!/^(?:[\w:/-]|\\[.()/:-])*$/.test(text)) return null
  return text.replace(/\\([.()/:-])/g,'$1')
}
export function selectorExpectations(command) {
  const invocations=verificationInvocations(command)
  if(invocations.length!==1)return []
  const args=tokens(invocations[0]),positions=args.map((s,i)=>/^(?:-R|--tests-regex|-TestRegex)$/.test(s)?i:-1).filter(i=>i>=0)
  if(positions.length!==1)return []
  const raw=args[positions[0]+1]
  if(!raw||raw.length>1200||/^".*[$`]/.test(raw))return []
  const selector=unquote(raw),match=/^(\^?)([^()|]*)\(([^()]+)\)([^()|]*?)(\$?)$/.exec(selector)
  if(!match)return []
  const prefix=literal(match[2]),suffix=literal(match[4]),branches=match[3].split('|').map(literal)
  if(prefix===null||suffix===null||branches.length<2||branches.length>TEST_OBSERVATION_LIMITS.selectors||branches.some(b=>!b))return []
  return [...new Set(branches)].map(b=>({name:prefix+b+suffix,match:match[1]&&match[5]?'exact':match[1]?'prefix':match[5]?'suffix':'contains',origin:'selection-branch'}))
}
export const expectationMatches=(expectation,name)=>expectation.match==='exact'?name===expectation.name:
  expectation.match==='prefix'?name.startsWith(expectation.name):expectation.match==='suffix'?name.endsWith(expectation.name):name.includes(expectation.name)

export function createTestObservation(expectations=[],{command='',cwd=''}={}) {
  const rust=/\bcargo(?:\.exe)?\s+(?:\+[^\s]+\s+)?test\b/i.test(command)
  return {runner:rust?'rust':null,cases:[],registered:null,summary:null,summaryCount:0,truncated:false,ambiguous:false,
    expectations,tail:'',cwd,execution:{build:'unknown',tests:'not-observed',mode:rust&&/--no-run\b/.test(command)?'build-only':'tests'},
    rustRuns:[],rustCurrent:null,vitestJson:false,aggregateCounts:null,runnerFailed:false,
    json:null,jsonDepth:0,jsonString:false,jsonEscape:false,jsonChars:0,
    seen:new Set(),streamCounts:{passed:0,failed:0,skipped:0,disabled:0,ignored:0,todo:0},omittedCases:0,
    dataTruncated:false,expectedObserved:expectations.map(()=>0),expectedStates:expectations.map(()=>({passed:0,failed:0,skipped:0,disabled:0,ignored:0,todo:0})),caseHash:createHash('sha256').digest('hex')}
}
function useRunner(result,runner){
  if(result.runner&&result.runner!==runner)result.ambiguous=true
  else result.runner=runner
}
function addCase(result,name,state){
  const identity=createHash('sha256').update(name).digest('hex')
  if(result.seen.has(identity)){result.ambiguous=true;return}
  if(result.seen.size>=TEST_OBSERVATION_LIMITS.identities){result.truncated=true;result.dataTruncated=true;return}
  result.seen.add(identity);result.streamCounts[state]++
  const leaf=createHash('sha256').update(JSON.stringify([name,state])).digest(),accumulator=Buffer.from(result.caseHash,'hex')
  for(let i=0;i<accumulator.length;i++)accumulator[i]^=leaf[i]
  result.caseHash=accumulator.toString('hex')
  result.expectations.forEach((e,i)=>{if(expectationMatches(e,name)){result.expectedObserved[i]++;result.expectedStates[i][state]++}})
  if(name.length>TEST_OBSERVATION_LIMITS.name||result.cases.length>=TEST_OBSERVATION_LIMITS.cases){result.truncated=true;result.omittedCases++;return}
  result.cases.push({name,state})
}
function rustRun(result){
  if(!result.rustCurrent){result.rustCurrent={registered:null,observed:0,counts:{passed:0,failed:0,ignored:0},summary:null};if(result.rustRuns.length<TEST_OBSERVATION_LIMITS.cases)result.rustRuns.push(result.rustCurrent);else {result.truncated=true;result.dataTruncated=true}}
  return result.rustCurrent
}
function jsonReport(result,value){
  if(!value||!Array.isArray(value.testResults)||!Number.isSafeInteger(value.numTotalTests)||value.numTotalTests<0)return
  if(![value.numPassedTests,value.numFailedTests,value.numPendingTests,value.numTodoTests??0].every(n=>Number.isSafeInteger(n)&&n>=0))return
  useRunner(result,'vitest')
  if(result.vitestJson||result.cases.length||result.summaryCount)result.ambiguous=true
  result.vitestJson=true;result.execution.tests='finished';result.summaryCount++
  result.runnerFailed=value.success===false||Number(value.numFailedTestSuites)>0
  result.registered=value.numTotalTests;result.summary={total:value.numTotalTests,failed:value.numFailedTests}
  result.aggregateCounts={passed:value.numPassedTests,failed:value.numFailedTests,skipped:value.numPendingTests,todo:value.numTodoTests??0}
  const root=result.cwd.replaceAll('\\','/').replace(/\/$/,'')
  for(const suite of value.testResults){
    if(!suite||typeof suite.name!=='string'||!Array.isArray(suite.assertionResults)){result.ambiguous=true;continue}
    if(suite.status==='failed')result.runnerFailed=true
    const file=suite.name.replaceAll('\\','/'),relative=root&&file.startsWith(root+'/')?file.slice(root.length+1):file
    for(const assertion of suite.assertionResults){
      if(!assertion||typeof assertion.fullName!=='string'){result.ambiguous=true;continue}
      // Vitest's pending status can mean a still-running/queued assertion.
      // Compatible reporters also use it differently; never guess a terminal skip.
      if(assertion.status==='pending'){result.ambiguous=true;result.execution.tests='started';continue}
      const state={passed:'passed',failed:'failed',pending:'skipped',skipped:'skipped',todo:'todo',disabled:'disabled'}[assertion.status]
      if(!state){result.ambiguous=true;continue}
      addCase(result,relative+' > '+assertion.fullName,state)
    }
  }
}
// Parse only a bounded JSON object actually present in this native invocation's
// output. A report path or a later file read is never promoted to an execution.
function observeJson(result,line){
  if(result.json===null){if(!line.trimStart().startsWith('{'))return false;result.json=[];result.jsonChars=0;result.jsonDepth=0;result.jsonString=false;result.jsonEscape=false}
  result.jsonChars+=line.length+1
  if(result.jsonChars>TEST_OBSERVATION_LIMITS.jsonChars){result.json=null;result.truncated=true;result.dataTruncated=true;return true}
  result.json.push(line)
  for(const c of line){
    if(result.jsonString){if(result.jsonEscape)result.jsonEscape=false;else if(c==='\\')result.jsonEscape=true;else if(c==='"')result.jsonString=false}
    else if(c==='"')result.jsonString=true
    else if(c==='{'||c==='[')result.jsonDepth++
    else if(c==='}'||c===']')result.jsonDepth--
  }
  if(result.jsonDepth<=0&&!result.jsonString){const text=result.json.join('\n');result.json=null;try{jsonReport(result,JSON.parse(text))}catch{/* Not a supported runner report. */}}
  return true
}
function observeLine(result,line) {
  line=line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'')
  if(observeJson(result,line))return
  if(result.runner==='rust'){
    if(/^\s*(?:Compiling|Checking)\s/.test(line))result.execution.build='started'
    if(/^\s*Finished\s+.*(?:test|bench).*profile/.test(line))result.execution.build='passed'
    if(/^error(?:\[E\d+\])?:/.test(line)&&result.execution.tests==='not-observed')result.execution.build='failed'
  }
  const rustStart=/^running (\d+) tests?\s*$/.exec(line)
  if(rustStart){
    useRunner(result,'rust');result.execution.tests='started'
    if(result.rustCurrent&&!result.rustCurrent.summary)result.ambiguous=true
    result.rustCurrent={registered:Number(rustStart[1]),observed:0,counts:{passed:0,failed:0,ignored:0},summary:null}
    if(result.rustRuns.length<TEST_OBSERVATION_LIMITS.cases)result.rustRuns.push(result.rustCurrent);else {result.truncated=true;result.dataTruncated=true}
    return
  }
  const rustItem=/^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?\s*$/.exec(line)
  if(rustItem&&result.runner==='rust'){
    const state={ok:'passed',FAILED:'failed',ignored:'ignored'}[rustItem[2]]
    const run=rustRun(result);run.observed++;run.counts[state]++;addCase(result,rustItem[1],state);return
  }
  const rustSummary=/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/.exec(line)
  if(rustSummary){
    useRunner(result,'rust');const run=rustRun(result)
    if(run.summary)result.ambiguous=true
    run.summary={passed:Number(rustSummary[1]),failed:Number(rustSummary[2]),ignored:Number(rustSummary[3]),measured:Number(rustSummary[4])}
    result.execution.tests='finished';result.summaryCount++
    result.summary={total:result.rustRuns.reduce((n,r)=>n+(r.summary?Object.values(r.summary).reduce((a,b)=>a+b,0):0),0),failed:result.rustRuns.reduce((n,r)=>n+(r.summary?.failed??0),0)}
    result.aggregateCounts={passed:result.rustRuns.reduce((n,r)=>n+(r.summary?.passed??0),0),failed:result.summary.failed,
      ignored:result.rustRuns.reduce((n,r)=>n+(r.summary?.ignored??0),0),skipped:0,todo:0}
    result.registered=result.rustRuns.every(r=>r.registered!==null)?result.rustRuns.reduce((n,r)=>n+r.registered,0):null;return
  }
  if(/^\s*(?:RUN|DEV)\s+v\d+\./.test(line)){useRunner(result,'vitest');result.execution.tests='started';return}
  if(result.runner==='vitest'&&/^\s*Test Files\s+.*\d+ failed/.test(line))result.runnerFailed=true
  const vitestSummary=/^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/.exec(line)
  if(vitestSummary&&result.runner==='vitest'){
    const counts={passed:0,failed:0,skipped:0,todo:0};let matched=false
    for(const part of vitestSummary[1].split('|')){const m=/^\s*(\d+)\s+(passed|failed|skipped|todo)\s*$/.exec(part);if(!m){result.ambiguous=true;continue}counts[m[2]]=Number(m[1]);matched=true}
    if(matched){if(result.summaryCount)result.ambiguous=true;result.summaryCount++;result.aggregateCounts=counts;result.registered=Number(vitestSummary[2]);result.summary={total:result.registered,failed:counts.failed};result.execution.tests='finished'}
    return
  }
  const verbose=/^\s*([✓✔√×✗↓-])\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/.exec(line)
  if(verbose&&result.runner==='vitest'&&verbose[2].includes(' > ')&&!/\(\d+ tests?/.test(verbose[2])){
    addCase(result,verbose[2],/[×✗]/.test(verbose[1])?'failed':/[↓-]/.test(verbose[1])?'skipped':'passed');return
  }
  const item=/^\s*\d+\/(\d+)\s+Test\s+#\d+:\s+(.+?)\s+\.{2,}\s*(Passed|\*{3}[^\r\n]*)/.exec(line)
  if(item){
    useRunner(result,'ctest');const total=Number(item[1]);if(result.registered!==null&&result.registered!==total)result.ambiguous=true
    result.registered=total
    const name=item[2],status=item[3]
    const state=status==='Passed'?'passed':/Not Run\s*\(Disabled\)/i.test(status)?'disabled':/Skipped/i.test(status)?'skipped':'failed'
    addCase(result,name,state);return
  }
  const summary=/^\s*\d+(?:\.\d+)?% tests passed(?:,\s*(\d+) tests failed)? out of\s*(\d+)\s*$/.exec(line)
  if(summary){useRunner(result,'ctest');result.summaryCount++;result.summary={failed:Number(summary[1]??0),total:Number(summary[2])};if(result.summaryCount>1)result.ambiguous=true}
}
export function observeTestOutput(result,text,{terminal=false}={}) {
  const lines=(result.tail+String(text??'')).split(/\r?\n/);result.tail=lines.pop()??''
  for(const line of lines){if(line.length>(line.trimStart().startsWith('{')||result.json!==null?TEST_OBSERVATION_LIMITS.jsonChars:TEST_OBSERVATION_LIMITS.line)){result.truncated=true;result.dataTruncated=true}else observeLine(result,line)}
  if(result.tail.length>(result.tail.trimStart().startsWith('{')||result.json!==null?TEST_OBSERVATION_LIMITS.jsonChars:TEST_OBSERVATION_LIMITS.line)){result.tail='';result.truncated=true;result.dataTruncated=true}
  if(terminal&&result.tail){observeLine(result,result.tail);result.tail=''}
}
export function summarizeTestObservation(result,{terminal=false}={}) {
  // A promised set remains pending even when no supported runner format was
  // observed. Dropping it would turn empty/opaque output into an apparent zero.
  if(!result||!result.runner&&!result.expectations.length)return null
  const counts={passed:0,failed:0,skipped:0,disabled:0}
  if(result.runner==='rust')counts.ignored=0
  if(result.runner==='vitest')counts.todo=0
  for(const row of result.cases)counts[row.state]=(counts[row.state]??0)+1
  let consistent=result.summaryCount===1&&result.registered===result.cases.length&&result.summary?.failed===counts.failed
    &&[counts.passed+counts.failed,counts.passed+counts.failed+counts.skipped].includes(result.summary?.total)
  if(result.runner==='rust')consistent=result.rustRuns.length>0&&result.rustRuns.every(r=>r.summary&&r.registered===r.observed&&r.summary.measured===0
    &&['passed','failed','ignored'].every(key=>r.counts[key]===r.summary[key]))
  if(result.runner==='vitest')consistent=result.summaryCount===1&&result.registered===result.cases.length&&result.aggregateCounts
    &&['passed','failed','skipped','todo'].every(key=>(counts[key]??0)===result.aggregateCounts[key])
  const complete=Boolean(terminal&&!result.truncated&&!result.ambiguous&&result.json===null&&consistent)
  const streamed=result.streamCounts,streamTotal=Object.values(streamed).reduce((a,b)=>a+b,0)
  const streamConsistent=result.runner==='ctest'?result.summaryCount===1&&result.registered===streamTotal&&result.summary?.failed===streamed.failed
    &&[streamed.passed+streamed.failed,streamed.passed+streamed.failed+streamed.skipped].includes(result.summary?.total)
    :result.runner==='rust'?consistent:result.runner==='vitest'?result.summaryCount===1&&result.registered===streamTotal&&result.aggregateCounts
      &&['passed','failed','skipped','todo'].every(key=>streamed[key]===result.aggregateCounts[key]):false
  const streamComplete=Boolean(terminal&&!result.dataTruncated&&!result.ambiguous&&result.json===null&&streamConsistent)
  const aggregateConsistent=result.runner==='vitest'?result.summaryCount===1&&result.aggregateCounts&&Object.values(result.aggregateCounts).reduce((a,b)=>a+b,0)===result.registered
    :result.runner==='rust'?result.rustRuns.length>0&&result.rustRuns.every(r=>r.summary&&r.summary.measured===0&&r.registered===Object.values(r.summary).reduce((a,b)=>a+b,0)):streamConsistent
  const aggregateComplete=Boolean(terminal&&!result.dataTruncated&&!result.ambiguous&&result.json===null&&aggregateConsistent)
  const expectations=result.expectations.map((e,i)=>({...e,observed:result.expectedObserved[i],states:{...result.expectedStates[i]}}))
  return {runner:result.runner??'unknown',cases:result.cases.map(c=>({...c})),counts,registered:result.registered,summary:result.summary,
    complete,truncated:result.truncated,ambiguous:result.ambiguous,expectations,
    streamCounts:{...streamed},streamComplete,omittedCases:result.omittedCases,caseSetSha256:result.caseHash,
    ...(result.runner==='rust'||result.runner==='vitest'?{execution:{...result.execution},runnerFailed:result.runnerFailed}:{}),
    aggregateCounts:result.runner==='ctest'?{...streamed}:result.aggregateCounts,aggregateComplete,
    selection:!expectations.length?'not-declared':expectations.some(e=>!e.observed)?complete||streamComplete?'gap':'unknown':'observed',
    provenance:'runner-reported names and states from a native execution; not independent acceptance'}
}
