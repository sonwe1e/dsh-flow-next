import { FLOW_CONTEXT_KEY, contextStateSchema, initialContextState, foldContext, renderContext } from '../lib/flow-context.js'

export const name='flow-context-policy'
export const inject=['systemPrompt','sessionProjections','commands']
export function apply(ctx) {
  const projections=ctx.get('sessionProjections')
  projections.register({key:FLOW_CONTEXT_KEY,stateSchema:contextStateSchema,init:initialContextState,apply:foldContext,stateVersion:1})
  // Scoped registration is removed with the preset; the host owns replay, caching and durability.
  ctx.get('systemPrompt').context({name:'flow:compacted-human-context',order:91,text:({scope})=>{
    if (!scope?.session) return ''
    try { return renderContext(projections.stateOf(scope.session,FLOW_CONTEXT_KEY),scope.session.surface.nodes) }
    catch { return 'Flow compacted-human recall is unavailable. Use current conversation and original project records.' }
  }})
  ctx.get('commands').register({name:'flow-context',description:'Inspect or control same-session compacted human recall: status, off, on, clear',
    handler: async invocation=>{
      const session=invocation.agent?.session, action=String(invocation.rawInput??'').trim()||'status'
      if (!session || !['status','off','on','clear'].includes(action)) return {kind:'error',text:'Usage: /flow-context [status|off|on|clear]'}
      const state=projections.stateOf(session,FLOW_CONTEXT_KEY)
      if (!state) return {kind:'error',text:'Flow context projection is unavailable.'}
      // The native command/run was committed before invoking this handler.
      // Its projection owns controls; no custom event or second storage.
      const current=projections.stateOf(session,FLOW_CONTEXT_KEY)
      return {kind:'success',text:`Same-session recall: ${current.enabled?'on':'off'}; indexed human inputs: ${current.entries.length}; compacted: ${current.entries.filter(e=>e.hidden).length}.\n`+
        'Historical excerpts may be superseded or truncated. No independent verification or cross-session knowledge is inferred.'}
    }})
}
