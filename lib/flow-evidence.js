import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { boundedOutput, zeroTestSummary, testFailureSummary, diagnosticFailureSummary } from './check-evidence.js'
import { isVerification, verificationInvocations } from './verification-command.js'
import { createTestObservation,selectorExpectations,observeTestOutput,summarizeTestObservation } from './test-observations.js'
export { isVerification } from './verification-command.js'

export const EVIDENCE_LIMITS = Object.freeze({ files: 24, bytes: 524288, receipts: 2, jobs: 16, outcomes: 16, promptChars: 1200 })
const shellNames = new Set(['pwsh', 'bash', 'shell'])
const inside = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function verificationDescriptor(root, command, workdir = '.') {
  const cwd = path.resolve(root, workdir), invocations = verificationInvocations(command)
  if (!inside(path.resolve(root), cwd) || !invocations.length) return null
  return { cwd, checkKeys: [...new Set(invocations.map(call => hash(cwd + '\0' + call)))], aggregate: invocations.length > 1 }
}

// Explicit intent does not need a command-name guess. Bind the complete native
// call; never alias a wrapper, pipeline or variable launch to a guessed child.
export function declaredCheckDescriptor(root, command, workdir = '.', toolName = process.platform === 'win32' ? 'pwsh' : 'bash') {
  if (!shellNames.has(toolName) || typeof command !== 'string' || !command.trim() || command.includes('\0')) return null
  const cwd = path.resolve(root, workdir)
  if (!inside(path.resolve(root), cwd)) return null
  const invocations = verificationInvocations(command)
  const single = invocations.length === 1 && invocations[0] === command.trim()
  const key = hash('declared-shell-v1\0' + toolName + '\0' + cwd + '\0' + command)
  return { cwd, toolName, binding: 'exact-command', key,
    checkKeys: [single ? hash(cwd + '\0' + invocations[0]) : key],
    aggregate: !single, statusGranularity: single ? 'invocation' : 'shell-call' }
}

const outputSignals = output => ({ testFailure: testFailureSummary(output), diagnosticFailure: diagnosticFailureSummary(output), zeroTests: zeroTestSummary(output) })
const mergeSignals = (receipt, output) => {
  for (const [key, value] of Object.entries(outputSignals(output))) receipt[key] ||= value
}
const completedState = (receipt, exitCode) => exitCode !== 0 ? 'failed' : receipt.testFailure ? 'reported-test-failure'
  : receipt.diagnosticFailure ? 'reported-diagnostic-failure' : receipt.zeroTests ? 'zero-tests' : 'exited-zero'
// DSH job controls return a structured job with producer-owned detail, rather
// than an exitCode field. Never extract a status from arbitrary command stdout.
const jobExitCode = job => {
  const value = /^exit code:\s*(-?\d+)(?:$|[;\s])/.exec(job.detail ?? '')?.[1]
  return value === undefined ? null : Number(value)
}

// Only already observed local files; no directory scan, process launch, or writes.
// Incomplete observations stay unknown. A digest never proves whole-repo coverage.
export async function fingerprintObserved(root, files, limits = EVIDENCE_LIMITS) {
  const result = {}
  let canonicalRoot
  try { root = path.resolve(root); canonicalRoot = await fs.realpath(root) } catch { return Object.fromEntries(files.map(file => [file, null])) }
  for (const relative of files.slice(0, limits.files)) {
    let handle
    try {
      const target = path.resolve(root, relative)
      if (!inside(root, target) || !inside(canonicalRoot, await fs.realpath(target))) throw new Error('Outside observed workspace')
      handle = await fs.open(target, 'r')
      const info = await handle.stat()
      if (!info.isFile() || info.size > limits.bytes) throw new Error('Unbounded observation')
      const buffer = Buffer.alloc(info.size + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Observation changed')
      result[relative] = hash(buffer.subarray(0, bytesRead))
    } catch { result[relative] = null } finally { await handle?.close() }
  }
  return result
}

export class FlowEvidence {
  constructor({ root, snapshot, limits = EVIDENCE_LIMITS, collectTests = false, onRecord }) {
    this.root = path.resolve(root); this.limits = limits
    this.snapshot = snapshot ?? (files => fingerprintObserved(this.root, files, this.limits))
    this.files = new Set(); this.receipts = []; this.pending = new Map(); this.jobs = new Map(); this.last = null; this.unobserved = false; this.sequence = 0
    this.edited = new Set(); this.scopeRevision = 0; this.outstanding = new Map(); this.outcomesTruncated = false
    this.successfulChecks = new Map()
    this.epoch = randomUUID(); this.history = new Map(); this.scopes = []; this.assessments = []
    this.collectTests=collectTests;this.onRecord=onRecord;this.boundExecutions=new Map();this.auxiliaryReads=new Set()
  }
  fileName(file) {
    if (typeof file !== 'string' || !file || file.includes('\0')) return null
    const target = path.resolve(this.root, file)
    return inside(this.root, target) && target !== this.root ? path.relative(this.root, target).replaceAll('\\', '/') : null
  }
  observeFile(file, { edited = false } = {}) {
    const name = this.fileName(file)
    if (!name) { this.unobserved = true; return }
    if (this.files.size >= this.limits.files && !this.files.has(name)) {
      this.unobserved = true
      const victim = [...this.files].find(file => !this.edited.has(file)) ?? (edited ? this.files.values().next().value : null)
      if (!victim) return
      this.files.delete(victim); this.edited.delete(victim); this.scopeRevision++
    }
    this.files.delete(name) // Refresh recency; native writes outrank inventory.
    this.files.add(name)
    if (edited) this.edited.add(name)
  }
  // Revalidate a referenced current-process receipt, independently of the two
  // entries displayed in the compact prompt. Cold/inherited facts stay history.
  async revalidate(id) {
    const receipt=this.getRecord(id)
    if(!receipt)return null
    const names=Object.keys(receipt.files),allowed=names.filter(file=>this.files.has(file))
    const current=await this.snapshot(allowed)
    const changed=allowed.filter(file=>receipt.files[file]&&current[file]&&receipt.files[file]!==current[file])
    const omittedInputs=names.filter(file=>!this.files.has(file))
    Object.assign(receipt,{changed,omittedInputs,
      freshness:changed.length?'stale':!names.length||omittedInputs.length||names.some(file=>!receipt.files[file]||!current[file])||receipt.changedDuringExecution?'unknown':'observed-inputs-unchanged',
      laterEditedFiles:[...this.edited].filter(file=>!Object.hasOwn(receipt.files,file))})
    return receipt
  }
  observeExternalEdit(file) {
    const name=this.fileName(file)
    if(!name)return
    // A native write/restore during execution invalidates the run even when
    // before/after hashes happen to match. It grants no new read observation.
    for(const planned of this.pending.values())if(planned.files.includes(name))planned.changedDuringExecution=true
    for(const receipt of this.jobs.values())if(Object.hasOwn(receipt.files,name))receipt.changedDuringExecution=true
  }
  replaceNativeOutput(receipt,text,sources) {
    if(!receipt.testObservation||receipt.exitCode===null||receipt.state==='unfinished')return
    const prior=receipt.testObservation,expected=prior?.expectations??[]
    receipt.testObservation=createTestObservation(expected,{command:receipt.command,cwd:receipt.cwd})
    if(prior?.runner)receipt.testObservation.runner=prior.runner
    if(prior?.execution?.mode==='build-only')receipt.testObservation.execution.mode='build-only'
    observeTestOutput(receipt.testObservation,text,{terminal:true})
    mergeSignals(receipt,text)
    receipt.state=completedState(receipt,receipt.exitCode)
    receipt.outputSources=sources
    this.updateTests(receipt);this.remember(receipt);this.onRecord?.(receipt)
  }
  remember(receipt) {
    if (receipt.state === 'exited-zero' && !receipt.aggregate && !receipt.changedDuringExecution) {
      // A successful OTHER command cannot clear this failure. Filters and
      // printed status strings are excluded from invocation identity.
      for (const [id, issue] of this.outstanding) {
        if (issue.sequence > receipt.sequence) continue
        for (const key of receipt.checkKeys) issue.remainingKeys.delete(key)
        if (!issue.remainingKeys.size) this.outstanding.delete(id)
      }
      for (const key of receipt.checkKeys) {
        if ((this.successfulChecks.get(key) ?? -1) > receipt.sequence) continue
        this.successfulChecks.delete(key); this.successfulChecks.set(key, receipt.sequence)
      }
      while (this.successfulChecks.size > (this.limits.outcomes ?? 16)) this.successfulChecks.delete(this.successfulChecks.keys().next().value)
      return
    }
    if (receipt.state === 'exited-zero') return // Compound outer zero proves no individual status.
    const id = hash(receipt.checkKeys.join('\0'))
    if ((this.outstanding.get(id)?.sequence ?? -1) > receipt.sequence) return
    this.outstanding.delete(id)
    const remainingKeys = new Set(receipt.checkKeys.filter(key => (this.successfulChecks.get(key) ?? -1) < receipt.sequence))
    if (!remainingKeys.size) return // Late old-job results cannot revive a resolved failure.
    this.outstanding.set(id, { ...receipt, remainingKeys })
    if (this.outstanding.size > (this.limits.outcomes ?? 16)) {
      this.outstanding.delete(this.outstanding.keys().next().value); this.outcomesTruncated = true
    }
  }
  get unresolved() { return [...this.outstanding.values()].map(issue => ({ ...issue, remainingKeys: [...issue.remainingKeys] })) }
  getRecord(id) { return this.history.get(id) ?? [...this.outstanding.values()].find(r => r.checkId === id) }
  assessmentFor(receipt) {
    const assessment = this.assessments.find(a => a.checkId === receipt.checkId)
    if (!assessment) return null
    const replacement = assessment.replacementId && this.getRecord(assessment.replacementId)
    const applicableReplacement = replacement?.state === 'exited-zero' && !replacement.aggregate && !replacement.changedDuringExecution && !replacement.scopeDeclarationPending
      && replacement.freshness === 'observed-inputs-unchanged'
    return { ...assessment, applicableReplacement: Boolean(applicableReplacement) }
  }
  async begin(exec) {
    if (!shellNames.has(exec.name) || typeof exec.arguments?.command !== 'string') return
    const { command, workdir } = exec.arguments
    const exact = declaredCheckDescriptor(this.root, command, workdir, exec.name)
    const binding=this.boundExecutions.get(exec.callId)
    const declaredExact = binding&&exact?{...exact,command,files:Object.keys(binding.inputBefore),expectedTests:binding.expectedTests,reason:'native execution-bound inputs'}:exact && this.scopes.find(s => s.binding === 'exact-command' && s.key === exact.key
      && s.command === command && s.cwd === exact.cwd && s.toolName === exec.name)
    const automatic = verificationDescriptor(this.root, command, workdir)
    if (!declaredExact && !isVerification(command)) return
    // Legacy checkpoints retain their original invocation identity. New scopes
    // bind exact bytes and shell name, so changed setup/filters cannot inherit one.
    const declared = declaredExact ?? (automatic && !automatic.aggregate
      ? this.scopes.find(s => !s.binding && s.key === automatic.checkKeys[0]) : undefined)
    const cwd = path.resolve(this.root, workdir ?? '.')
    const invocations = verificationInvocations(command)
    const descriptor = declaredExact ? exact : { checkKeys: [...new Set(invocations.map(call => hash(cwd + '\0' + call)))],
      aggregate: invocations.length > 1, statusGranularity: invocations.length > 1 ? 'shell-call' : 'invocation' }
    // Restored declarations are intent, not a grant to fingerprint files. This
    // process must have observed them through successful native tool results.
    const scope = binding?declared:declared?.files.every(file => this.files.has(file)) ? declared : null
    const files = inside(this.root, cwd) ? scope ? scope.files : [...this.files] : []
    this.pending.set(exec.callId, { command: boundedOutput(command, 220), commandSha256:hash(command),cwd,
      checkKeys: descriptor.checkKeys, aggregate: descriptor.aggregate, statusGranularity: descriptor.statusGranularity,
      toolName: exec.name, rootCallId: exec.rootCallId ?? exec.callId,
      scopeKind: scope ? 'agent-declared' : 'observed', scopeReason: scope?.reason,
      scopeDeclarationPending: Boolean(declared && !scope),
      ...(this.collectTests?{testObservation:createTestObservation(declared?.expectedTests?.length
        ?declared.expectedTests.map(name=>({name,match:'exact',origin:'agent-declared'})):selectorExpectations(command),{command,cwd})}:{}),
      ...(binding?{binding}:{}),scopeRevision: this.scopeRevision, before: await this.snapshot(files), files })
  }
  async finish(exec, result) {
    if (['read', 'write', 'edit'].includes(exec.name) && !result.isError&&!this.auxiliaryReads.has(exec.callId)) this.observeFile(exec.arguments?.file_path, { edited: ['write','edit'].includes(exec.name) })
    if (['write', 'edit'].includes(exec.name) && !result.isError) {
      const file = this.fileName(exec.arguments?.file_path)
      for (const receipt of this.jobs.values()) if (Object.hasOwn(receipt.files, file)) receipt.changedDuringExecution = true
      for (const planned of this.pending.values()) if (planned.files.includes(file)) planned.changedDuringExecution = true
    }
    if (exec.name === 'job_output') { await this.finishJob(exec, result); return }
    const planned = this.pending.get(exec.callId)
    if (!planned) return
    this.pending.delete(exec.callId)
    const value = result.value ?? {}, output = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    // Capture the final native outcome synchronously. DSH does not await result
    // observers; filesystem hashing must not delay durable per-test facts until
    // after the native step closes (especially on cancellation).
    const changedDuringExecution = planned.changedDuringExecution || planned.scopeKind !== 'agent-declared' && planned.scopeRevision !== this.scopeRevision
    const receipt = { command: planned.command,commandSha256:planned.commandSha256,inputBefore:planned.before,cwd: planned.cwd, exitCode: value.exitCode ?? null, state: 'unfinished',
      checkKeys: planned.checkKeys, aggregate: planned.aggregate, statusGranularity: planned.statusGranularity,
      toolName: planned.toolName, rootCallId: planned.rootCallId, scopeRevision: planned.scopeRevision,
      scopeKind: planned.scopeKind, scopeReason: planned.scopeReason,
      scopeDeclarationPending: planned.scopeDeclarationPending,...(planned.binding?{binding:planned.binding}:{}),
      files: planned.before, before: planned.before, changedDuringExecution, callId: exec.callId, sequence: ++this.sequence, ...outputSignals(output) }
    receipt.checkId = hash(this.epoch + '\0' + exec.callId + '\0' + receipt.sequence).slice(0, 16)
    if(planned.testObservation){receipt.testObservation=planned.testObservation;
      // Background launch notices are metadata, not the producer's stdout.
      if(value.kind==='foreground'||result.isError)observeTestOutput(receipt.testObservation,output,{terminal:true})
      if(value.stdout?.truncated||value.stderr?.truncated){receipt.testObservation.truncated=true;receipt.testObservation.dataTruncated=true}}
    if (result.isError) receipt.state = 'failed'
    else if (value.kind === 'foreground' && !value.timedOut && !value.aborted && Number.isInteger(value.exitCode)) receipt.state = completedState(receipt, value.exitCode)
    else if (['background', 'promoted'].includes(value.kind) && typeof value.jobId === 'string' && value.jobId) {
      receipt.jobId = value.jobId; receipt.jobStatus = 'running'
      // Ambiguous/reused ids cannot certify either invocation. Keep observation
      // bounded; dropped jobs retain an unfinished receipt if still displayed.
      if (this.jobs.has(value.jobId) || this.receipts.some(previous => previous.jobId === value.jobId)) this.jobs.delete(value.jobId)
      else {
        this.jobs.set(value.jobId, receipt)
        if (this.jobs.size > (this.limits.jobs ?? 16)) this.jobs.delete(this.jobs.keys().next().value)
      }
    }
    this.updateTests(receipt)
    this.onRecord?.(receipt)
    const after = await this.snapshot(planned.files)
    receipt.files=after
    receipt.changedDuringExecution ||= planned.files.some(file => planned.before[file] !== after[file])
    this.onRecord?.(receipt)
    this.receipts.unshift(receipt)
    this.receipts.sort((a,b)=>b.sequence-a.sequence)
    this.receipts.length = Math.min(this.receipts.length, this.limits.receipts)
    this.history.set(receipt.checkId, receipt)
    const pinned=new Set([...this.jobs.values()].map(row=>row.checkId))
    while (this.history.size > (this.limits.outcomes ?? 16)+pinned.size) {
      const oldest=[...this.history.values()].filter(row=>!pinned.has(row.checkId)).reduce((a,b)=>a.sequence<b.sequence?a:b)
      this.history.delete(oldest.checkId)
    }
    this.remember(receipt)
    this.last = null
  }
  updateTests(receipt){
    if(!receipt.testObservation)return
    const terminal=receipt.state!=='unfinished'
    receipt.tests=summarizeTestObservation(receipt.testObservation,{terminal})
    if(receipt.state==='exited-zero'&&receipt.tests){
      if(receipt.tests.counts.failed||receipt.tests.streamCounts?.failed||receipt.tests.aggregateCounts?.failed||receipt.tests.runnerFailed)receipt.state='reported-test-failure'
      else if(receipt.tests.execution?.build==='failed')receipt.state='reported-diagnostic-failure'
      else if(receipt.tests.execution?.mode==='build-only')return
      else if(receipt.tests.complete&&receipt.tests.summary?.total===0)receipt.state='zero-tests'
      else if((receipt.tests.complete||receipt.tests.aggregateComplete)&&(receipt.tests.aggregateCounts??receipt.tests.counts).passed===0
        &&((receipt.tests.aggregateCounts??receipt.tests.counts).ignored||(receipt.tests.aggregateCounts??receipt.tests.counts).skipped||(receipt.tests.aggregateCounts??receipt.tests.counts).disabled||(receipt.tests.aggregateCounts??receipt.tests.counts).todo))receipt.state='all-tests-skipped'
      else if(!receipt.tests.complete&&!receipt.tests.streamComplete&&!(receipt.tests.aggregateComplete&&!receipt.tests.expectations.length))receipt.state='test-results-incomplete'
      else if(receipt.tests.selection==='gap')receipt.state='test-selection-gap'
    }
  }
  async finishJob(exec, result) {
    const id = exec.arguments?.job_id, receipt = this.jobs.get(id), value = result.value ?? {}, job = value.job
    if (!receipt || result.isError || job?.id !== id) return
    if(receipt.testObservation&&(value.lossy||value.text?.includes('[some output was dropped'))){receipt.testObservation.truncated=true;receipt.testObservation.dataTruncated=true}
    mergeSignals(receipt, typeof value.text === 'string' ? value.text : '')
    if(receipt.testObservation)observeTestOutput(receipt.testObservation,value.text,{terminal:['completed','failed','killed'].includes(job.status)})
    receipt.jobStatus = job.status
    if (['completed', 'failed', 'killed'].includes(job.status)) {
      const exitCode = jobExitCode(job)
      receipt.exitCode = exitCode
      receipt.state = job.status === 'failed' ? 'failed' : job.status === 'completed' && exitCode !== null
        ? completedState(receipt, exitCode) : 'unfinished'
      // A job completion refreshes that invocation, not the most recent one.
      // Changes between launch and collection remain unknown even with exit 0.
      this.jobs.delete(id)
    }
    this.updateTests(receipt)
    this.onRecord?.(receipt)
    const current = await this.snapshot(Object.keys(receipt.files))
    receipt.changedDuringExecution ||= Object.keys(receipt.before).some(file => receipt.before[file] !== current[file])
    if(['completed','failed','killed'].includes(job.status)){
      receipt.files=current
      this.remember(receipt)
    }
    this.onRecord?.(receipt)
    this.last = null
  }
  async refresh() {
    if (this.pending.size || !this.receipts.length) { this.last = null; return null }
    const observedCurrent = await this.snapshot([...this.files])
    const currentFor = async receipt => receipt.scopeKind === 'agent-declared' ? this.snapshot(Object.keys(receipt.files)) : observedCurrent
    for (const receipt of this.jobs.values()) {
      const current = await currentFor(receipt)
      receipt.changedDuringExecution ||= Object.keys(receipt.before).some(file => receipt.before[file] !== current[file])
    }
    const refreshRecord = async receipt => {
      const current = await currentFor(receipt)
      const observed = Object.keys(receipt.files)
      const changed = observed.filter(file => receipt.files[file] != null && current[file] != null && receipt.files[file] !== current[file])
      const unknown = !observed.length || observed.some(file => receipt.files[file] === null || current[file] == null)
      const result = { ...receipt, changed, freshness: changed.length ? 'stale' : unknown || receipt.changedDuringExecution ? 'unknown' : 'observed-inputs-unchanged',
        laterObservedFiles: [...this.files].filter(file => !Object.hasOwn(receipt.files, file)),
        laterEditedFiles: [...this.edited].filter(file => !Object.hasOwn(receipt.files, file)),
        omittedInputs: receipt.scopeKind === 'agent-declared' ? [] : observed.filter(file => !this.files.has(file)) }
      Object.assign(receipt, result)
      return result
    }
    this.last = await Promise.all(this.receipts.map(refreshRecord))
    const displayed = new Set(this.receipts.map(r => r.checkId))
    for (const id of new Set(this.assessments.map(a => a.replacementId).filter(Boolean))) {
      const receipt = this.getRecord(id)
      if (receipt && !displayed.has(id)) await refreshRecord(receipt)
    }
    return this.last
  }
  signature() { return this.last?.length ? hash(JSON.stringify({ receipts: this.last, unresolved: this.unresolved,
    unobserved: this.unobserved, outcomesTruncated: this.outcomesTruncated, assessments: this.assessments })) : null }
  render({ compact = false } = {}) {
    if (!this.last?.length) return ''
    const lines = ['Flow execution evidence (observed files only):']
    // Unresolved failures survive successful unrelated checks and receipt
    // display eviction. Put them first so bounded rendering retains the warning.
    const unresolved = this.unresolved
    if (unresolved.length) lines.push('Unresolved checks (not task grading): ' + unresolved.slice(-4).map(r => {
      const assessment = this.assessmentFor(r)
      return `#${r.sequence} id=${r.checkId} ${r.state}; ${r.remainingKeys.length} invocation(s); ${boundedOutput(r.command, 70)}`
        + (assessment ? `; agent assessment=${assessment.category}${assessment.replacementId ? assessment.applicableReplacement ? ', replacement currently observed unchanged' : ', replacement unknown/stale' : ''} (not resolved)` : '')
    }).join(' | '))
    if (this.outcomesTruncated) lines.push('Earlier unresolved checks exceeded the retained limit; check saved logs. Their status is unknown.')
    for (const receipt of this.last) {
      lines.push(`${receipt.state}; ${receipt.freshness}; check #${receipt.sequence} id=${receipt.checkId}; ${receipt.jobId ? `job ${receipt.jobId}: ${receipt.jobStatus}; ` : ''}${Object.keys(receipt.files).length} ${receipt.scopeKind === 'agent-declared' ? 'agent-declared files (coverage not certified)' : 'observed files (dependencies not inferred)'}; ${boundedOutput(receipt.command, compact ? 80 : 170)}`)
      if (receipt.changed.length) lines.push('Changed since execution: ' + receipt.changed.slice(0, 3).join(', ') + '. Assess relevance to this check; rerun affected checks before applying it. Unrelated notes alone need no rerun.')
      if (receipt.laterObservedFiles.length) lines.push('Additional observed files are outside that receipt: ' + receipt.laterObservedFiles.slice(0, 3).join(', '))
      if (receipt.laterEditedFiles.length) lines.push('Later edits are outside that check: ' + receipt.laterEditedFiles.slice(0, 3).join(', '))
      if (receipt.omittedInputs.length) lines.push('Receipt inputs left the current observation set; unchanged status is unknown.')
      if (receipt.scopeDeclarationPending) lines.push('Declared inputs lack current permitted native observations; declaration was not applied. Scope remains partial.')
      if (receipt.aggregate) lines.push('Opaque or multiple check invocations: only outer exit is observed, not individual statuses. Use per-check results.')
    }
    lines.push(compact ? 'Observation state unchanged; not a pass or coverage certificate. Unobserved scope remains unverified.'
      : 'Zero exit does not prove tests ran or requirement coverage. Other files, environment and external dependencies are unverified. Reuse unchanged evidence when applicable; follow repository-required checks, verify remaining requirements, then deliver.')
    if (this.unobserved) lines.push('Some files were outside the bounded observation scope.')
    return boundedOutput(lines.join('\n'), this.limits.promptChars)
  }
}
