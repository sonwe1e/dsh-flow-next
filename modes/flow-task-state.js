import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { FLOW_TASK_KEY,FLOW_TASK_SOURCE,TASK_LIMITS,taskLink,taskView,renderTaskView } from '../lib/flow-task.js'

export function createTaskState(agent,projections,progress,{ledger,findCheck}){
  const state=()=>projections.stateOf(agent.session,FLOW_TASK_KEY)
  const native=()=>{
    try{return {goal:agent.ctx.get('goals').get(agent)??null,goalAvailable:true}}
    catch{return {goal:null,goalAvailable:false}}
  }
  const view=()=>taskView(state(),{...native(),ledger,findCheck})
  return {
    view,
    context:async()=>{try{return renderTaskView(await view())}catch{return 'Flow task links are unavailable; use the native goal, todos and actual execution results.'}},
    execute:async args=>{
      if(args.action==='status'){
        if(Object.keys(args).some(key=>!['action','offset','limit'].includes(key)))throw new Error('Unexpected task status parameter')
        const offset=args.offset??0,limit=args.limit??10
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Invalid task page')
        const current=await view();return {...current,items:current.items.slice(offset,offset+limit),total:current.items.length,
          nextOffset:offset+limit<current.items.length?offset+limit:null}
      }
      const p=progress()
      if(!p.openStep)throw new Error('Task links require an open native tool step')
      const current=state(),before=native(),annotation=await taskLink(current,args,{...before,ledger,findCheck}),text=JSON.stringify(annotation)
      if(text.length>TASK_LIMITS.eventChars)throw new Error('Task annotation exceeds its bounded checkpoint')
      // Fingerprinting awaits native observations. A concurrent todo or goal
      // change must not bind the old annotation to a different plan.
      const latest=state(),goal=native().goal
      const active=progress()
      if(!active.openStep||active.turn!==p.turn||active.step!==p.step)throw new Error('Task link execution no longer belongs to an open native step')
      if(latest.planSeq!==current.planSeq||before.goal?.id!==goal?.id||before.goal?.revision!==goal?.revision)throw new Error('Native plan or goal changed; read status before linking')
      const visible=Number.isInteger(current.surfaceSeq)&&agent.session.surface.nodes.includes(current.surfaceSeq)
      agent.session.append('developer/message',{turn:p.turn,step:p.step,
        message:createDeveloperMessage({source:{kind:FLOW_TASK_SOURCE},content:[{type:'text',text}]})},visible
        ?{surfaceOp:{op:'replace',startSeq:current.surfaceSeq,endSeq:current.surfaceSeq},sourceEventSeqs:[current.surfaceSeq]}:{surfaceOp:'append'})
      const currentView=await view()
      return {recorded:true,planSeq:currentView.planSeq,item:currentView.items.find(item=>item.key===annotation.key),next:currentView.next,acceptance:'not-certified'}
    },
  }
}
