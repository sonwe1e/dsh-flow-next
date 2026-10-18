import { stageReport,stageCheck } from '../lib/flow-stage.js'
import { FLOW_VALIDATION_INDEX_KEY,FLOW_VALIDATION_SOURCE,validationPayloadSchema } from '../lib/flow-validation.js'

export function createStageState(agent,{validation,evidence,task,subagents,query,agents}){
  async function childEvidence(id,signal){
    const observation=await query.observeSession(id,{signal})
    try{
      if(observation.header.parentSession!==agent.id)throw new Error('Native parent ownership mismatch')
      const index=observation.projections?.values[FLOW_VALIDATION_INDEX_KEY]
      if(!index)return {sessionId:id,checks:[],omittedChecks:0,error:'Native validation index unavailable; no child prose was promoted'}
      const ids=index.order.slice(-32),checks=[]
      for(const checkId of ids){
        const seq=index.locations[checkId].seq,event=observation.events[seq]
        if(event?.data?.message?.source?.kind!==FLOW_VALIDATION_SOURCE)throw new Error('Child checkpoint identity mismatch')
        const payload=validationPayloadSchema.parse(JSON.parse(event.data.message.content[0].text)),receipt=payload.runs.find(row=>row.id===checkId)
        if(!receipt)throw new Error('Child receipt identity mismatch')
        // Inherited parent facts are not child executions and must not be counted twice.
        if(receipt.originSessionId!==id)continue
        checks.push(stageCheck(receipt,{currentSessionId:agent.id,originSessionId:id,sourceEventSeq:seq}))
      }
      return {sessionId:id,activity:agents?.get(id)?.status??'not-resident',observedCursor:observation.cursor,checks,omittedChecks:Math.max(0,(index.total??index.order.length)-ids.length),acceptance:'not-certified'}
    }finally{observation[Symbol.dispose]()}
  }
  return {
    async report({children=[]}={},signal){
      if(!Array.isArray(children)||children.length>8||children.some(id=>typeof id!=='string')||new Set(children).size!==children.length)throw new Error('Select up to 8 distinct native direct-child ids')
      await evidence.settle();validation.flush(evidence.ledger)
      const childRows=[]
      if(children.length){
        if(!subagents?.listChildren||!query?.observeSession)throw new Error('Native child observation services unavailable')
        const catalog=await subagents.listChildren(agent.id,signal)
        if(children.some(id=>!catalog.some(row=>row.id===id)))throw new Error('Only exact children from this parent native catalog may be observed')
        for(const id of children){signal?.throwIfAborted();try{childRows.push(await childEvidence(id,signal))}catch(error){signal?.throwIfAborted();childRows.push({sessionId:id,checks:[],omittedChecks:0,error:error.message})}}
      }
      const all=validation.all(128)
      const runs=[]
      for(const row of all.runs){const live=await evidence.ledger.revalidate(row.id);runs.push({...row,freshness:live?.freshness??'historical-not-revalidated'})}
      return stageReport({sessionId:agent.id,...all,runs,task:await task.view(),children:childRows,observerAvailable:evidence.available})
    },
  }
}
