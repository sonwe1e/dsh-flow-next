import { z } from 'zod'
import { redact } from './daily-feedback.js'

export const FLOW_CONTEXT_KEY = 'flow_compacted_human_context'
export const CONTEXT_LIMITS = Object.freeze({ entries: 32, excerptPoints: 600, promptChars: 2200, checkpointChars: 16000 })
const entrySchema = z.object({ seq: z.number().int().nonnegative(), kind: z.enum(['message','goal-command']),
  text: z.string().max(CONTEXT_LIMITS.excerptPoints * 2), truncated: z.boolean(), hidden: z.boolean() }).strict()
export const contextStateSchema = z.object({ enabled: z.boolean(), resetBeforeSeq: z.number().int().min(-1),
  entries: z.array(entrySchema).max(CONTEXT_LIMITS.entries), omitted: z.number().int().nonnegative(),
  checkpoint: z.string().max(CONTEXT_LIMITS.checkpointChars),
  pending: z.object({ id: z.string().max(100), seqs: z.array(z.number().int().nonnegative()).max(CONTEXT_LIMITS.entries),
    text: z.string().max(CONTEXT_LIMITS.checkpointChars) }).strict().nullable() }).strict()
export const initialContextState = () => ({ enabled: true, resetBeforeSeq: -1, entries: [], omitted: 0, checkpoint: '', pending: null })
const texts = blocks => (blocks ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
function excerpt(text) {
  const points = Array.from(redact(text)), limit = CONTEXT_LIMITS.excerptPoints
  if (points.length <= limit) return { text: points.join(''), truncated: false }
  const marker='\n[excerpt truncated]\n', head=400, tail=limit-head-marker.length
  return { text: points.slice(0,head).join('')+marker+points.slice(-tail).join(''), truncated: true }
}
// Pure native session-projection fold. Never inspect reasoning, tool payloads or assistant claims.
export function foldContext(state, event) {
  const d=event.data ?? {}, seq=event.seq
  if (!Number.isSafeInteger(seq) || seq < 0) return state
  if (seq <= state.resetBeforeSeq) return state
  // Reuse the host's durable human command lifecycle, including on runtimes
  // whose append API cannot mark external plugin events ignorable.
  if (event.type === 'command/run' && d.source?.kind === 'user' && d.name === 'flow-context') {
    const action=typeof d.args==='string'?d.args.trim():''
    if (action==='clear') return {...initialContextState(),enabled:state.enabled,resetBeforeSeq:seq}
    if (action==='on'||action==='off') return {...state,enabled:action==='on'}
    return state
  }
  const human = event.type === 'user/message' && d.source?.kind === 'user' ? { kind:'message',text:texts(d.content) }
    : event.type === 'command/run' && d.source?.kind === 'user' && d.name === 'goal' && typeof d.args === 'string'
      ? { kind:'goal-command',text:d.args } : null
  if (human?.text.trim()) {
    const entries=[...state.entries,{seq,kind:human.kind,...excerpt(human.text),hidden:false}]
    if (entries.length <= CONTEXT_LIMITS.entries) return {...state,entries}
    return {...state,entries:[entries[0],...entries.slice(-(CONTEXT_LIMITS.entries-1))],omitted:state.omitted+1}
  }
  if (event.type === 'compaction/summary' && typeof d.compactionId === 'string' && Array.isArray(d.shadowedSeqs)) {
    const selected=new Set(d.shadowedSeqs)
    return {...state,pending:{id:d.compactionId,seqs:state.entries.filter(e=>selected.has(e.seq)).map(e=>e.seq),
      text:texts(d.summary).slice(0,CONTEXT_LIMITS.checkpointChars)}}
  }
  if (event.type === 'user/message' && d.source?.kind === 'compact-checkpoint' && d.source.compactionId === state.pending?.id
    && event.surfaceOp?.op === 'replace') {
    const hidden=new Set(state.pending.seqs)
    return {...state,entries:state.entries.map(e=>hidden.has(e.seq)?{...e,hidden:true}:e),checkpoint:state.pending.text,pending:null}
  }
  if (event.type === 'compaction/end' && state.pending?.id === d.compactionId) return {...state,pending:null}
  return state
}
export function renderContext(state, surfaceNodes = []) {
  if (!state?.enabled) return ''
  const visible=new Set(surfaceNodes)
  const eligible=state.entries.filter(e=>e.hidden&&!visible.has(e.seq)&&(!state.checkpoint.includes(e.text)||e.truncated))
  if (!eligible.length) return ''
  const selected=eligible.length<=3?eligible:[eligible[0],...eligible.slice(-2)]
  const header='Earlier human inputs hidden by compaction (redacted historical excerpts, not task status or verification). Newer user instructions take precedence; old requests may be superseded. This is bounded recall, not the full requirements.\n'
  let result=header, included=0
  for (const entry of selected) {
    const line=`seq ${entry.seq} (${entry.kind}${entry.truncated?'; truncated':''}): ${JSON.stringify(entry.text)}\n`
    if (result.length+line.length+100>CONTEXT_LIMITS.promptChars) continue
    result+=line; included++
  }
  if (!included) return ''
  return result+`Omitted from this window: ${eligible.length-included}; older index entries omitted: ${state.omitted}.`
}
