import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { FLOW_VALIDATION_KEY,FLOW_VALIDATION_SOURCE,FLOW_VALIDATION_SUMMARY_SOURCE,
  FLOW_VALIDATION_INDEX_KEY,validationPayloadSchema,recordValidation,validationReport,renderValidationReport } from '../lib/flow-validation.js'

// The host owns persistence, replay and the model surface. Full facts remain in
// immutable native developer checkpoints; positional replacement presents only
// a compact derived view. No second file store, hidden runner or model call.
export function createValidationState(agent,projections,progress){
  const state=()=>projections.stateOf(agent.session,FLOW_VALIDATION_KEY)
  const pending=new Map()
  const archived=id=>{
    const location=projections.stateOf(agent.session,FLOW_VALIDATION_INDEX_KEY)?.locations[id]
    if(!location)return null
    const event=agent.session.snapshotEvents(location.seq)[0],message=event?.data?.message
    if(event?.seq!==location.seq||message?.source?.kind!==FLOW_VALIDATION_SOURCE)throw new Error('Historical check location is unavailable')
    const payload=validationPayloadSchema.parse(JSON.parse(message.content[0].text))
    const receipt=payload.runs.find(r=>r.id===id)
    if(!receipt)throw new Error('Historical check identity mismatch')
    return receipt
  }
  const find=id=>{
    const queued=pending.get(id)
    if(queued)return recordValidation({version:1,runs:[],omitted:0},queued,{originSessionId:agent.session.id}).runs[0]
    return state().runs.find(r=>r.id===id)??archived(id)
  }
  let disposed=false
  const append=(source,text,replaceSeq)=>{
    const p=progress(),visible=Number.isInteger(replaceSeq)&&agent.session.surface.nodes.includes(replaceSeq)
    return agent.session.append('developer/message',{turn:p.turn,step:p.step,
      message:createDeveloperMessage({source:{kind:source},content:[{type:'text',text}]})},visible
        ?{surfaceOp:{op:'replace',startSeq:replaceSeq,endSeq:replaceSeq},sourceEventSeqs:[replaceSeq]}:{surfaceOp:'append'})
  }
  const compact=ledger=>{
    const current=state()
    if(current.surfaceSeq===null)return
    const message=agent.session.snapshotEvents(current.surfaceSeq)[0]?.data?.message,source=message?.source?.kind
    if(![FLOW_VALIDATION_SOURCE,FLOW_VALIDATION_SUMMARY_SOURCE].includes(source))return
    const text=renderValidationReport(validationReport(current,ledger,{currentSessionId:agent.session.id}),{compact:true})
    // Forked surfaces carry the parent's text. Re-derive its provenance before
    // the child's first request; unchanged views never add another checkpoint.
    if(source===FLOW_VALIDATION_SUMMARY_SOURCE&&agent.session.surface.nodes.includes(current.surfaceSeq)&&message.content?.[0]?.text===text)return
    append(FLOW_VALIDATION_SUMMARY_SOURCE,text,current.surfaceSeq)
  }
  const flush=ledger=>{
      // Native developer checkpoints require an open step. Idle commands and
      // turn-stopping are read-only; they must never manufacture a new step.
      if(disposed||!progress().openStep)return
      // Also repairs a process interruption between full checkpoint and summary.
      compact(ledger)
      if(!pending.size)return
      let next=state()
      for(const receipt of pending.values())next={...recordValidation(next,receipt,{originSessionId:agent.session.id}),surfaceSeq:next.surfaceSeq}
      const {surfaceSeq,...payload}=next
      append(FLOW_VALIDATION_SOURCE,JSON.stringify(payload),surfaceSeq)
      pending.clear()
      compact(ledger)
  }
  return {
    record:receipt=>{if(!disposed){const {testObservation,...durable}=receipt;pending.set(receipt.checkId,structuredClone(durable));flush()}},
    flush,
    report:(ledger,args)=>{
      let current=state()
      for(const receipt of pending.values())current={...recordValidation(current,receipt,{originSessionId:agent.session.id}),surfaceSeq:current.surfaceSeq}
      if(args?.checkId&&!current.runs.some(r=>r.id===args.checkId)){
        const receipt=find(args.checkId)
        if(receipt)current={...current,runs:[receipt]}
      }
      return {...validationReport(current,ledger,{...args,currentSessionId:agent.session.id}),pendingPersistence:pending.size}
    },
    find,
    all:(limit=128)=>{
      const index=projections.stateOf(agent.session,FLOW_VALIDATION_INDEX_KEY),ids=index.order.slice(-limit)
      const runs=ids.map(id=>{const receipt=find(id);return receipt?{...receipt,sourceEventSeq:index.locations[id].seq}:null}).filter(Boolean)
      return {runs,omitted:Math.max(0,index.order.length-ids.length)}
    },
    previous:label=>{
      const index=projections.stateOf(agent.session,FLOW_VALIDATION_INDEX_KEY)
      for(const id of index.order.slice(-128).reverse()){const receipt=find(id);if(receipt?.binding?.label===label&&receipt.originSessionId===agent.id)return receipt}
      return null
    },
    history:({cursor,limit=10,query='',file,fingerprint}={})=>{
      if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('History limit must be 1..20')
      const index=projections.stateOf(agent.session,FLOW_VALIDATION_INDEX_KEY),order=index.order
      const before=cursor===undefined?order.length:order.indexOf(cursor)
      if(before<0)throw new Error('Unknown same-session history cursor')
      if(typeof query!=='string'||query.length>240||file!==undefined&&(typeof file!=='string'||file.length>4096))throw new Error('Invalid history filter')
      if(fingerprint!==undefined&&(!file||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)))throw new Error('A fingerprint filter requires a file and an exact SHA-256')
      const rows=[];let offset=before,scanned=0
      while(offset>0&&rows.length<limit&&scanned<100){
        const id=order[--offset],receipt=find(id);scanned++
        if(!receipt||query&&!receipt.command.toLowerCase().includes(query.toLowerCase())||file&&!Object.hasOwn(receipt.files??{},file)||fingerprint&&receipt.files[file]!==fingerprint)continue
        const report=validationReport({version:1,runs:[receipt],omitted:0},null,{currentSessionId:agent.session.id})
        const row=report.runs[0];rows.push({id:row.id,command:row.command,state:row.state,origin:row.origin,freshness:row.freshness,
          runner:row.tests?.runner??null,completeObservedSet:row.tests?.complete??false,files:Object.keys(row.files??{}),
          ...(file?{matchedFingerprint:receipt.files[file]}:{}),sourceEventSeq:index.locations[id].seq})
      }
      return {provenance:'Same-session native execution checkpoints; no file scan or revalidation',total:order.length,rows,scanned,
        nextCursor:offset>0?order[offset]:null,pendingPersistence:pending.size,acceptance:'not-certified'}
    },
    dispose:()=>{disposed=true;pending.clear()},
  }
}
