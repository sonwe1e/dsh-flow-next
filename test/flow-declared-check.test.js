import test from 'node:test'
import assert from 'node:assert/strict'
import { FlowEvidence, isVerification } from '../lib/flow-evidence.js'
import { emptyCheckProtocol, updateCheckProtocol, readCheckProtocol, serializeCheckProtocol } from '../lib/flow-check-protocol.js'

const setup = () => {
  const ledger = new FlowEvidence({ root: process.cwd(), snapshot: async files => Object.fromEntries(files.map(f => [f, 'v1'])) })
  ledger.observeFile('src/input.js')
  let protocol = emptyCheckProtocol(), sequence = 0
  const declare = (command, extra = {}) => {
    protocol = updateCheckProtocol(protocol, { action: 'scope', toolName: 'pwsh', command, files: ['src/input.js'], reason: 'Explicit check intent; execution remains native', ...extra }, ledger)
    ledger.scopes = protocol.scopes
    return protocol
  }
  const run = async (command, { name = 'pwsh', workdir, result = { value: { kind: 'foreground', exitCode: 1 } } } = {}) => {
    const exec = { name, callId: `declared-${++sequence}`, rootCallId: 'native-parent', arguments: { command, workdir } }
    await ledger.begin(exec); await ledger.finish(exec, result); await ledger.refresh()
    return ledger.getRecord(ledger.receipts[0]?.checkId)
  }
  return { ledger, declare, run }
}

test('declaring inputs does not orphan a recognized invocation failure', async () => {
  const s = setup(), command = 'node tools/check.cjs'
  await s.run(command); assert.equal(s.ledger.unresolved.length, 1)
  s.declare(command)
  await s.run(command, { result: { value: { kind: 'foreground', exitCode: 0 } } })
  assert.equal(s.ledger.unresolved.length, 0)
})

test('legacy scope checkpoints still bind without becoming a file read grant', async () => {
  const s = setup(), command = 'node tools/check.cjs', old = await s.run(command)
  s.ledger.scopes = [{ key: old.checkKeys[0], command, cwd: process.cwd(), files: ['src/input.js'], reason: 'Legacy checkpoint' }]
  assert.equal(readCheckProtocol(serializeCheckProtocol({ ...emptyCheckProtocol(), scopes: s.ledger.scopes })).scopes.length, 1)
  assert.equal((await s.run(command)).scopeKind, 'agent-declared')
})

test('restored arbitrary declaration keeps inputs unobserved until native reads succeed', async () => {
  const s = setup(), command = './tools/project.ps1 -Target compile'; s.declare(command)
  s.ledger.files.clear()
  const receipt = await s.run(command)
  assert.equal(receipt.scopeDeclarationPending, true); assert.deepEqual(receipt.files, {})
  assert.equal(receipt.freshness, 'unknown')
})

test('outer wrapper success cannot supersede a behavioral failure', async () => {
  const s = setup(), bad = await s.run('node tools/check.cjs'), command = './tools/project.ps1 -Target compile'
  s.declare(command)
  const good = await s.run(command, { result: { value: { kind: 'foreground', exitCode: 0 } } })
  assert.throws(() => updateCheckProtocol(emptyCheckProtocol(), { action: 'classify', checkId: bad.checkId,
    category: 'superseded', replacementId: good.checkId, reason: 'Only outer status exists', evidence: 'Not individual behavioral results' }, s.ledger), /Replacement/)
})

const commands = [
  './tools/project.ps1 -Target compile',
  '$exe = "./out/program.exe"; & $exe --case origin',
  'pwsh -File tools/probe.ps1',
  'node tools/mutate.cjs',
  'node tools/a.cjs; node tools/b.cjs',
]
for (const command of commands) test(`explicit scope captures arbitrary native check: ${command}`, async () => {
  const s = setup()
  assert.equal(isVerification(command), false)
  await s.run(command); assert.equal(s.ledger.receipts.length, 0)
  const state = s.declare(command)
  assert.equal(state.scopes[0].binding, 'exact-command')
  assert.deepEqual(readCheckProtocol(serializeCheckProtocol(state)), state)
  const receipt = await s.run(command)
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.scopeKind, 'agent-declared')
  assert.equal(receipt.statusGranularity, 'shell-call'); assert.equal(receipt.aggregate, true)
  assert.equal(receipt.toolName, 'pwsh'); assert.equal(receipt.rootCallId, 'native-parent')
  assert.ok(receipt.callId); assert.ok(receipt.checkId)
})

test('exact declarations bind the whole command, working directory and native shell', async () => {
  const s = setup(), command = commands[1]; s.declare(command)
  for (const [other, options] of [
    [command + ' --other', {}], [command.replace('origin', 'duration'), {}],
    [command, { name: 'bash' }], [command, { workdir: 'other' }],
    ['Write-Output ' + JSON.stringify(command), {}],
  ]) { await s.run(other, options); assert.equal(s.ledger.receipts.length, 0) }
  assert.equal((await s.run(command)).scopeKind, 'agent-declared')
})

test('ordinary queries and printed check names remain unrecorded without a declaration', async () => {
  for (const command of ['Get-Content tools/probe.ps1', 'Write-Output "node tools/mutate.cjs"', 'git status --short']) {
    const s = setup(); await s.run(command); assert.equal(s.ledger.receipts.length, 0)
  }
})

test('opaque outer zero and printed exit markers cannot certify individual checks', async () => {
  const s = setup(), command = commands[0]; s.declare(command)
  const receipt = await s.run(command, { result: { value: { kind: 'foreground', exitCode: 0 } } })
  assert.equal(receipt.state, 'exited-zero'); assert.equal(receipt.aggregate, true)
  assert.match(s.ledger.render(), /outer exit|individual status/)
  const unknown = await s.run(command, { result: { content: [{ type: 'text', text: '[exit code: 0] ALL PASS' }] } })
  assert.equal(unknown.state, 'unfinished')
})

test('background checks link only the matching producer-owned job terminal', async () => {
  const s = setup(), command = commands[1]; s.declare(command)
  const receipt = await s.run(command, { result: { value: { kind: 'background', jobId: 'job-explicit' } } })
  assert.equal(receipt.state, 'unfinished')
  await s.ledger.finish({ name: 'job_output', arguments: { job_id: 'job-explicit' } }, { value: { job: { id: 'other', status: 'completed', detail: 'exit code: 0' } } })
  assert.equal(receipt.state, 'unfinished')
  await s.ledger.finish({ name: 'job_output', arguments: { job_id: 'job-explicit' } }, { value: { job: { id: 'job-explicit', status: 'completed', detail: 'exit code: 2' } } })
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.exitCode, 2)
})

test('explicit intent is not a file-observation or workspace-escape grant', () => {
  const s = setup()
  assert.throws(() => s.declare(commands[0], { files: ['never-read.js'] }), /permitted native/)
  assert.throws(() => s.declare(commands[0], { workdir: '../outside' }), /workspace/)
  assert.throws(() => s.declare(commands[0], { files: ['../outside.js'] }), /inside/)
  assert.equal(s.ledger.scopes.length, 0)
})
