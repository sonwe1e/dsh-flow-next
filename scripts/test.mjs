import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

// Explicit discovery keeps generated benchmark sandboxes out of unit tests,
// including on Windows and Node 20, where shell globs are not portable.
const files = fs.readdirSync('test').filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`)
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
