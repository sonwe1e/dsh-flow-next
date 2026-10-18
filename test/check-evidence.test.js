import test from 'node:test'
import assert from 'node:assert/strict'
import { zeroTestSummary, testFailureLines, testFailureSummary, diagnosticFailureSummary, errorOutputSummary } from '../lib/check-evidence.js'

test('zero-test summaries distinguish counts from shell exit-status assignments', () => {
  for (const output of ['TEST=0', 'FORMAT=0\nLINT=0\nTEST=0\n100% tests passed, 0 tests failed out of 390',
    '[==========] Running 3 tests from 1 test suite.', '[  PASSED  ] 3 tests.', '[  PASSED  ] 0 tests.',
    '[==========] 1 test from 1 test suite ran. (13 ms total)\n[  PASSED  ] 0 tests.\n[  FAILED  ] 1 test, listed below:',
    'The example says tests: 0', 'CTest selected 0 failed tests', 'TEST=1']) {
    assert.equal(zeroTestSummary(output), false, output)
  }
  for (const output of ['tests: 0', 'tests=0', '# tests 0', 'ℹ tests 0', 'ALL PASS (0 groups)',
    'collected 0 items', '[==========] Running 0 tests from 0 test suites.',
    '[==========] 0 tests from 0 test suites ran. (0 ms total)',
    'No tests were found!!!', '\u001b[32m[==========] Running 0 tests from 0 test suites.\u001b[0m',
    'TEST=0\n[==========] Running 0 tests from 0 test suites.\n100% tests passed, 0 tests failed out of 390']) {
    assert.equal(zeroTestSummary(output), true, output)
  }
})

test('TypeScript and colonless Vitest results survive outer success while source examples stay inert', () => {
  for (const output of ['src/service.ts(10,4): error TS2322: Type string is not assignable to number.',
    'src/service.ts:10:4 - error TS2322: Type mismatch.', 'error TS18003: No inputs were found.',
    '\u001b[31msrc/service.ts(10,4): error TS2304: Cannot find name missing.\u001b[0m']) {
    assert.equal(diagnosticFailureSummary(output), true, output)
  }
  for (const output of ['Test Files  1 failed | 2 passed (3)', 'Tests  3 failed | 9 passed (12)',
    'Test Files: 1 failed | 2 passed (3)', '\u001b[31m Tests  1 failed (1)\u001b[0m']) {
    assert.equal(testFailureSummary(output), true, output)
  }
  for (const output of ['Test Files  3 passed (3)', 'Tests  0 failed | 12 passed (12)',
    'The previous run said Tests 1 failed', '> Tests 1 failed (1)', '+Tests 1 failed (1)',
    'const example = "src/service.ts(10,4): error TS2322: example";',
    'TSC-EXIT=1', '+  contextError: string | null;', '  contextError: null,',
    '+  throw new Error("example");', '> Error: a documentation example']) {
    assert.equal(testFailureSummary(output), false, output)
    assert.equal(diagnosticFailureSummary(output), false, output)
    assert.equal(errorOutputSummary(output), false, output)
  }
  for (const output of ['Error: actual execution error', 'AssertionError: wrong value', '[exit code: 2]']) {
    assert.equal(errorOutputSummary(output), true, output)
  }
})

test('zero passed GoogleTest cases do not imply zero executed cases', () => {
  const output='[==========] Running 1 test from 1 test suite.\n[  FAILED  ] PersistenceTests.UpdateThenReload (13 ms)\n[==========] 1 test from 1 test suite ran. (13 ms total)\n[  PASSED  ] 0 tests.\n[  FAILED  ] 1 test, listed below:'
  assert.equal(zeroTestSummary(output),false)
  assert.equal(testFailureSummary(output),true)
})

test('native GoogleTest and CTest failure summaries survive outer zero exits without matching prose', () => {
  const failed = ['[  FAILED  ] PersistenceTests.UpdateThenReload (13 ms)',
    '[  FAILED  ] PersistenceTests.UpdateThenReload', '[  FAILED  ] 1 test, listed below:',
    '[  FAILED  ] 2 tests, listed below:', '99% tests passed, 1 tests failed out of 386',
    '\u001b[31m[  FAILED  ] Parameterized/Suite.Case/0 (0 ms)\u001b[0m']
  for (const output of failed) assert.equal(testFailureSummary(output), true, output)
  for (const output of ['100% tests passed, 0 tests failed out of 390', '[  PASSED  ] 3 tests.',
    'TEST=1', 'A log could contain [  FAILED  ] Suite.Case', '[ FAILED ] diagnostic example',
    'No tests were found!!!', '[==========] Running 0 tests from 0 test suites.']) {
    assert.equal(testFailureSummary(output), false, output)
  }
  assert.equal(testFailureLines(failed.join('\n'), 2).length, 2)
})
