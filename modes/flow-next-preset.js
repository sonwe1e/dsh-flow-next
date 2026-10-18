import { createRequire } from 'node:module'
import { FLOW_NEXT_GUIDANCE } from '../lib/flow-next.js'
const base=createRequire(import.meta.url)('./native-coding.json')
export const name='flow-next-preset'
export const inject=['agentPresets']
export function nextDefinition() {
  const plugins=structuredClone(base.plugins)
  plugins.find(p=>p.id==='persona').config.prefix=`You are an agent powered by the {{model}} model.\n\n${FLOW_NEXT_GUIDANCE}`
  plugins.push({id:'flow-context-policy',name:'@sonwe1e/dsh-flow-next/flow-context-policy'},
    {id:'flow-next-policy',name:'@sonwe1e/dsh-flow-next/flow-next-policy'})
  return {id:'flow-next',name:'Flow Next（试用）',order:6.5,
    description:'Task-state support with full native/PTC capability selection, execution evidence and compacted human recall. Trial; no confirmed performance advantage.',plugins}
}
export function apply(ctx){return ctx.get('agentPresets').register(nextDefinition())}
