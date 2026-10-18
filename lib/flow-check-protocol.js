import { z } from 'zod'
import { boundedOutput } from './check-evidence.js'
import { declaredCheckDescriptor } from './flow-evidence.js'

export const FLOW_CHECK_SOURCE = 'flow-next-check-protocol'
export const FLOW_CHECK_MAX_CHARS = 12000
const text = z.string().trim().min(1).max(400)
const id = z.string().regex(/^[a-f0-9]{16}$/)
const count = z.number().int().min(0).max(1000000)
const shellName = z.enum(['pwsh','bash','shell'])
const scopeSchema = z.object({key:z.string().length(64),command:z.string().max(1200),cwd:z.string().max(512),
  binding:z.literal('exact-command').optional(),toolName:shellName.optional(),
  files:z.array(z.string().max(256)).min(1).max(24),reason:text,
  expectedTests:z.array(z.string().trim().min(1).max(240)).min(1).max(64).optional()}).strict()
const assessmentSchema = z.object({checkId:id,category:z.enum(['environment','expected-negative','superseded','unknown']),
  reason:text,evidence:text,replacementId:id.optional()}).strict()
const coverageSchema = z.object({group:z.string().trim().min(1).max(80),expected:count,executed:count,failed:count,skipped:count,
  evidence:text,normalControl:text.optional(),negativeControl:text.optional(),previousExpected:count.optional(),amendment:text.optional()}).strict()
export const checkProtocolSchema = z.object({version:z.literal(1),scopes:z.array(scopeSchema).max(8),
  assessments:z.array(assessmentSchema).max(8),coverage:z.array(coverageSchema).max(24)}).strict()
export const emptyCheckProtocol = () => ({version:1,scopes:[],assessments:[],coverage:[]})
export function readCheckProtocol(value) {
  if (value == null) return emptyCheckProtocol()
  if (typeof value !== 'string' || value.length > FLOW_CHECK_MAX_CHARS) throw new Error('Unbounded check protocol')
  return checkProtocolSchema.parse(JSON.parse(value))
}
export function serializeCheckProtocol(value) {
  const text = JSON.stringify(checkProtocolSchema.parse(value))
  if (text.length > FLOW_CHECK_MAX_CHARS) throw new Error('Check protocol exceeds its bounded state; narrow the record')
  return text
}
const requestSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('status')}).strict(),
  z.object({action:z.literal('scope'),command:z.string().min(1).max(1200),workdir:z.string().max(512).optional(),
    toolName:shellName.optional(),files:z.array(z.string().min(1).max(256)).min(1).max(24),reason:text,
    expectedTests:z.array(z.string().trim().min(1).max(240)).min(1).max(64).optional()}).strict(),
  assessmentSchema.extend({action:z.literal('classify')}).strict(),
  coverageSchema.omit({previousExpected:true,amendment:true}).extend({action:z.literal('coverage'),reason:text.optional()}).strict(),
])
const upsert = (rows, row, key, limit) => {
  const next = rows.filter(r => r[key] !== row[key])
  if (next.length >= limit) throw new Error('Record limit reached; do not silently drop earlier scope or gaps')
  return [...next,row]
}

// This changes declarations only. It launches no process, clears no failure,
// infers no dependencies, and never turns an agent assertion into acceptance.
export function updateCheckProtocol(state, request, ledger) {
  const args = requestSchema.parse(request), next = checkProtocolSchema.parse(state)
  if (args.action === 'status') return next
  if (args.action === 'scope') {
    const descriptor = declaredCheckDescriptor(ledger.root,args.command,args.workdir,args.toolName)
    if (!descriptor) throw new Error('Declare a nonempty native shell command with a working directory inside this workspace')
    const files = args.files.map(f => ledger.fileName(f))
    if (files.some(f => !f)) throw new Error('Declared files must be inside the observed workspace')
    if (files.some(f => !ledger.files.has(f))) throw new Error('Observe declared inputs with permitted native read/write tools first')
    next.scopes = upsert(next.scopes,{key:descriptor.key,command:args.command,cwd:descriptor.cwd,
      binding:descriptor.binding,toolName:descriptor.toolName,files:[...new Set(files)],reason:args.reason,
      ...(args.expectedTests?{expectedTests:[...new Set(args.expectedTests)]}:{})},'key',8)
  }
  if (args.action === 'classify') {
    const original = ledger.getRecord(args.checkId)
    if (!original || original.state === 'exited-zero' || original.state === 'unfinished') throw new Error('Classify an observed terminal failure or inconclusive check id')
    if (args.category === 'superseded' && !args.replacementId) throw new Error('Supersession needs an observed replacement check id and coverage evidence')
    if (args.replacementId) {
      const replacement = ledger.getRecord(args.replacementId)
      if (!replacement || replacement.state !== 'exited-zero' || replacement.aggregate || replacement.changedDuringExecution || replacement.scopeDeclarationPending
          || replacement.freshness !== 'observed-inputs-unchanged') throw new Error('Replacement must be an independent terminal zero with currently unchanged observed files')
    }
    const {action,...assessment} = args
    next.assessments = upsert(next.assessments,assessment,'checkId',8)
  }
  if (args.action === 'coverage') {
    if (args.failed > args.executed || args.executed + args.skipped > args.expected) throw new Error('Coverage counts are inconsistent')
    const previous = next.coverage.find(r => r.group === args.group)
    if (previous && previous.expected !== args.expected && !args.reason) throw new Error('Changing the expected count needs an explicit amendment reason')
    const {action,reason,...coverage} = args
    if(previous?.expected!==undefined && previous.expected!==args.expected){coverage.previousExpected=previous.expected;coverage.amendment=args.reason}
    else if(previous?.previousExpected!==undefined){coverage.previousExpected=previous.previousExpected;coverage.amendment=previous.amendment}
    next.coverage = upsert(next.coverage,coverage,'group',24)
  }
  serializeCheckProtocol(next) // Reject overflow transactionally, before recording.
  return next
}

export function renderCheckProtocol(state, ledger) {
  if (!state.scopes.length && !state.assessments.length && !state.coverage.length) return ''
  const lines = ['Flow check protocol (agent declarations, not independent acceptance):']
  if (state.scopes.length) lines.push(`${state.scopes.length} declared invocation scope(s); only bound files are fingerprinted. Dependency completeness is not inferred.`)
  if (state.coverage.length) {
    const sum = key => state.coverage.reduce((n,r) => n+r[key],0)
    const remaining = sum('expected')-sum('executed')-sum('skipped')
    lines.push(`Agent-reported coverage: expected=${sum('expected')} executed=${sum('executed')} failed=${sum('failed')} skipped=${sum('skipped')} unexecuted=${remaining}; counts do not certify behavior.`)
    for(const r of state.coverage.filter(r=>r.amendment).slice(-2))lines.push(`Agent plan amendment ${JSON.stringify(r.group)}: ${r.previousExpected}->${r.expected}; ${JSON.stringify(boundedOutput(r.amendment,90))}. Prior checkpoints remain in session history.`)
    const gaps=state.coverage.filter(r => r.failed || r.skipped || r.executed < r.expected)
    for (const r of gaps.slice(0,4))
      lines.push(`Gap ${JSON.stringify(r.group)}: expected=${r.expected} executed=${r.executed} failed=${r.failed} skipped=${r.skipped}; ${JSON.stringify(boundedOutput(r.evidence,80))}`)
    if(gaps.length>4)lines.push(`Showing 4/${gaps.length} groups with gaps; flow_check status retains the full declared records.`)
    const claimed = state.coverage.filter(r=>r.normalControl && r.negativeControl).length
    lines.push(`Normal/negative controls described for ${claimed}/${state.coverage.length} group(s); descriptions are claims, not measured sensitivity.`)
  }
  for (const a of state.assessments.slice(-3)) {
    const receipt = ledger.getRecord(a.checkId), current = receipt && ledger.assessmentFor(receipt)
    lines.push(`Assessment ${a.checkId}: ${a.category}; ${!receipt ? 'historical receipt not available in this process' : a.replacementId ? current?.applicableReplacement ? 'replacement currently observed unchanged' : 'replacement unknown/stale' : 'no replacement'}; original failure retained. ${JSON.stringify(boundedOutput(a.reason,90))}`)
  }
  if(state.assessments.length>3)lines.push(`Showing 3/${state.assessments.length} assessments; use flow_check status for full declared records.`)
  return boundedOutput(lines.join('\n'),1600)
}

export const FLOW_CHECK_PARAMETERS = {
  action:{type:'string',enum:['status','scope','classify','coverage','report','history'],required:true},
  command:{type:'string',description:'scope: exact full native shell command, declared before execution. Any name or wrapper is accepted as agent intent; no process is launched. Opaque or compound calls retain only the outer terminal status, not individual test results.'},
  toolName:{type:'string',enum:['pwsh','bash','shell'],description:'scope: native execution tool; defaults to pwsh on Windows, bash elsewhere. Must match the actual call.'},
  workdir:{type:'string',description:'scope: workspace-relative working directory; must match the actual invocation.'},
  files:{type:'array',items:{type:'string'},description:'scope: 1..24 relevant workspace files already observed by permitted native tools, including check definitions. Coverage is agent-declared.'},
  expectedTests:{type:'array',items:{type:'string'},description:'scope: optional 1..64 exact expected registered test names for this command. Actual runner observations are reconciled; declarations alone never certify execution.'},
  claims:{type:'array',items:{type:'object',additionalProperties:false,properties:{test:{type:'string',required:true},state:{type:'string',enum:['passed','failed','skipped','disabled','ignored','todo','not-observed'],required:true}}},description:'report: optionally check exact historical test-state claims against one checkId. Contradictions or incomplete absence evidence are rejected. This never certifies current-code acceptance.'},
  reason:{type:'string',description:'scope/classify: concise explanation. coverage: required when amending an existing expected count; max 400 characters.'},
  checkId:{type:'string',description:'classify/report: exact native check id. report can retrieve older same-session checkpoints beyond the recent window; classify still requires a current live receipt.'},
  cursor:{type:'string',description:'history: nextCursor from a previous page. Omit for newest checks.'},
  limit:{type:'integer',description:'history: page size 1..20, default 10; at most 100 native receipt locations are examined per page.'},
  query:{type:'string',description:'history: case-insensitive command substring, at most 240 characters.'},
  file:{type:'string',description:'history: exact workspace-relative artifact/input path recorded by that execution. No filesystem search is performed.'},
  fingerprint:{type:'string',description:'history: optional exact SHA-256 recorded for file. Requires file; old checkpoints without fingerprints do not match.'},
  category:{type:'string',enum:['environment','expected-negative','superseded','unknown'],description:'classify: assessment only; never clears the failure.'},
  replacementId:{type:'string',description:'classify: observed independent unchanged zero-exit receipt; required for superseded.'},
  group:{type:'string',description:'coverage: stable group id; use for multi-target checks, not simple tasks.'},
  expected:{type:'integer',description:'coverage: planned count; changing an existing count requires an explicit reason.'},
  executed:{type:'integer',description:'coverage: actually executed count including failed cases.'},
  failed:{type:'integer',description:'coverage: failures among executed cases.'},
  skipped:{type:'integer',description:'coverage: skipped cases; cannot be counted as executed.'},
  evidence:{type:'string',description:'classify/coverage: saved result reference and coverage/decision basis; max 400 characters. Agent claim, not certification.'},
  normalControl:{type:'string',description:'coverage: working clean-control evidence, if relevant.'},
  negativeControl:{type:'string',description:'coverage: known-wrong or reverted-fix control evidence, if relevant.'},
}
