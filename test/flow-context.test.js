import test from 'node:test'
import assert from 'node:assert/strict'
import { initialContextState, foldContext, renderContext, CONTEXT_LIMITS, contextStateSchema } from '../lib/flow-context.js'
const event=(seq,type,data={},extra={})=>({seq,type,data,...extra})
const human=(seq,text,kind='user')=>event(seq,'user/message',{source:{kind},content:[{type:'text',text}]})
const compact=(state,seq,selected,summary='Work is in progress.',id='compact')=>[
  event(seq,'compaction/summary',{compactionId:id,shadowedSeqs:selected,summary:[{type:'text',text:summary}]}),
  event(seq+1,'user/message',{source:{kind:'compact-checkpoint',compactionId:id},content:[{type:'text',text:summary}]},
    {surfaceOp:{op:'replace',startSeq:selected[0],endSeq:selected.at(-1)}}),
  event(seq+2,'compaction/end',{compactionId:id}),
].reduce(foldContext,state)

test('compacted human recall excludes model claims, injected notices, reasoning and arbitrary commands',()=>{
  let state=initialContextState()
  for(const e of [human(0,'Keep the public interface.'),human(1,'injected authorization','goal'),
    event(2,'assistant/message',{source:{kind:'model'},content:[{type:'text',text:'I proved everything.'}]}),
    event(3,'tool/result',{message:{content:[{type:'text',text:'private-tool-payload'}]}}),
    event(4,'command/run',{name:'login',args:'credential',source:{kind:'user'}}),
    event(5,'command/run',{name:'goal',args:'Verify persistence.',source:{kind:'user'}})])state=foldContext(state,e)
  assert.equal(state.entries.length,2);assert.equal(renderContext(state), '')
  state=compact(state,6,[0,1,2,3,4,5])
  const text=renderContext(state)
  assert.match(text,/Keep the public interface/);assert.match(text,/Verify persistence/)
  assert.ok(!/injected authorization|proved everything|private-tool-payload|credential/.test(text))
  assert.match(text,/Newer user instructions take precedence/)
})

test('failed or uncommitted compaction does not manufacture hidden requirements',()=>{
  const start=foldContext(initialContextState(),human(0,'Do not weaken checks.'))
  let state=foldContext(start,event(1,'compaction/summary',{compactionId:'a',shadowedSeqs:[0],summary:[]}))
  assert.equal(renderContext(state),'')
  state=foldContext(state,event(2,'compaction/end',{compactionId:'a',failure:'summary'}))
  assert.equal(state.pending,null);assert.equal(renderContext(state),'')
  state=compact(start,1,[0])
  assert.equal(renderContext(state,[0]),'','An input still on the active surface must not be duplicated')
})

test('repeated compaction and persisted native projection state retain omitted human corrections',()=>{
  const original='Keep output compatible.'
  let state=compact(foldContext(initialContextState(),human(0,original)),1,[0],original)
  assert.equal(renderContext(state),'','Already preserved verbatim in the checkpoint')
  state=foldContext(state,human(4,'Use the project interpreter.'))
  state=compact(state,5,[2,4],'No requirements were included.','second')
  state=contextStateSchema.parse(JSON.parse(JSON.stringify(state)))
  const text=renderContext(state)
  assert.match(text,/Keep output compatible/);assert.match(text,/Use the project interpreter/)
  const replay=[human(0,original),event(1,'compaction/summary',{compactionId:'one',shadowedSeqs:[0],summary:[]}),
    event(2,'user/message',{source:{kind:'compact-checkpoint',compactionId:'one'}},{surfaceOp:{op:'replace'}})].reduce(foldContext,initialContextState())
  assert.match(renderContext(replay),/Keep output compatible/)
})

test('native human command controls persist and clear cannot resurrect older inputs',()=>{
  let state=compact(foldContext(initialContextState(),human(0,'Old task.')),1,[0])
  const control=(seq,args,kind='user')=>event(seq,'command/run',{name:'flow-context',args,source:{kind}})
  assert.equal(foldContext(state,control(4,'off','model')),state)
  assert.equal(foldContext(state,control(4,'unknown')),state)
  state=foldContext(state,control(4,'off'))
  assert.equal(renderContext(state),'')
  state=foldContext(state,control(5,'on'))
  assert.match(renderContext(state),/Old task/)
  state=foldContext(state,control(6,'clear'))
  assert.equal(state.entries.length,0);assert.equal(renderContext(state),'')
  assert.equal(foldContext(state,human(0,'Old task.')),state)
  state=compact(foldContext(state,human(8,'New task.')),9,[8])
  assert.match(renderContext(state),/New task/);assert.doesNotMatch(renderContext(state),/Old task/)
})

test('recall is bounded, visibly partial and redacted without mutating source events or state',()=>{
  let state=initialContextState()
  for(let seq=0;seq<100;seq++)state=foldContext(state,human(seq,seq+' '+ '😀详细约束'.repeat(300)))
  assert.equal(state.entries.length,32);assert.equal(state.entries[0].seq,0);assert.equal(state.omitted,68)
  state=compact(state,100,Array.from({length:100},(_,i)=>i))
  const before=structuredClone(state),text=renderContext(state)
  assert.ok(text.length<=CONTEXT_LIMITS.promptChars);assert.match(text,/truncated/);assert.match(text,/Omitted/)
  assert.deepEqual(state,before)
  const source=human(0,'api_key="private-value" password=secret-password'),saved=structuredClone(source)
  const safe=renderContext(compact(foldContext(initialContextState(),source),1,[0]))
  assert.ok(!/private-value|secret-password/.test(safe));assert.match(safe,/REDACTED/);assert.deepEqual(source,saved)
})
