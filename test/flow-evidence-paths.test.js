import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FlowEvidence, fingerprintObserved, EVIDENCE_LIMITS } from '../lib/flow-evidence.js'

let root, sibling, expected
before(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), '.flow-evidence-paths-'))
  sibling = root + '-sibling'
  await fs.mkdir(sibling)
  const bytes = 'state=1\n'
  expected = createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(path.join(root, 'observed.js'), bytes)
  await fs.writeFile(path.join(sibling, 'outside.js'), bytes)
})
after(async () => {
  for (const directory of [root, sibling]) {
    assert.equal(path.dirname(path.resolve(directory)), process.cwd())
    assert.ok(path.basename(directory).startsWith('.flow-evidence-paths-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

for (const [name, variant] of [
  ['native absolute', () => root],
  ['relative', () => path.relative(process.cwd(), root)],
  ['forward separators', () => root.replaceAll('\\', '/')],
  ['native trailing separator', () => root + path.sep],
  ['forward trailing separator', () => root.replaceAll('\\', '/') + '/'],
]) {
  test(`observed fingerprints normalize ${name} roots`, async () => {
    assert.equal((await fingerprintObserved(variant(), ['observed.js']))['observed.js'], expected)
    const ledger = new FlowEvidence({ root: variant() })
    assert.equal((await ledger.snapshot(['observed.js']))['observed.js'], expected)
  })
}

test('filesystem root admits only the explicitly observed descendant', async () => {
  const driveRoot = path.parse(root).root
  const file = path.relative(driveRoot, path.join(root, 'observed.js'))
  assert.equal((await fingerprintObserved(driveRoot, [file]))[file], expected)
})

test('normalized roots retain sibling-prefix, traversal and canonical escape rejection', async () => {
  const outside = '../' + path.basename(sibling) + '/outside.js'
  const link = path.join(root, 'escape')
  await fs.symlink(sibling, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const result = await fingerprintObserved(root.replaceAll('\\', '/') + '/',
      [outside, path.join(sibling, 'outside.js'), 'escape/outside.js', 'missing.js', '.'])
    assert.deepEqual(Object.values(result), [null, null, null, null, null])
  } finally { await fs.unlink(link) }
})

test('default constructor snapshot applies its actual byte and file limits', async () => {
  const ledger = new FlowEvidence({ root, limits: { ...EVIDENCE_LIMITS, bytes: 1, files: 1 } })
  assert.deepEqual(await ledger.snapshot(['observed.js', 'missing.js']), { 'observed.js': null })
})

test('custom snapshots retain their existing injection contract', async () => {
  const snapshot = async files => Object.fromEntries(files.map(file => [file, 'custom']))
  const ledger = new FlowEvidence({ root, snapshot })
  assert.equal(ledger.snapshot, snapshot)
  assert.deepEqual(await ledger.snapshot(['observed.js']), { 'observed.js': 'custom' })
})
