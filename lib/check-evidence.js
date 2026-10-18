/** Narrow summary detection, not a requirement-coverage or test-integrity checker. */
const outputLines = output => String(output ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
export function zeroTestSummary(output) {
  return outputLines(output).some(line =>
    // TEST=0 is commonly a shell exit-status variable; it is not a test count.
    /^\s*(?:ALL PASS\s*\(0 (?:groups?|tests?|assertions?)\)|(?:tests|groups?|assertions?)\s*[:=]\s*0|test\s*:\s*0|0 tests?|collected 0 items)\s*(?:[.!]|$)/i.test(line)
    || /^\s*(?:(?:#|ℹ)\s*)?tests\s+0\s*$/i.test(line)
    || /^\s*\[={10}\]\s+(?:Running\s+)?0 tests? from 0 test suites?(?:\.| ran\.(?:\s*\(.*\))?)\s*$/i.test(line)
    // GoogleTest's PASSED count is not its executed count: all tests can fail.
    || /^\s*No tests were found!+\s*$/i.test(line))
}
// Explicit result lines only. Diagnostic text, never independent task grading.
export function testFailureLines(output, limit = 5) {
  return outputLines(output).filter(line =>
    /^\s*(?:(?:#|ℹ)\s*)?fail\s+[1-9]\d*\s*$/i.test(line)
    || /^\s*FAIL\s+(?:[\w@./\\-]+(?::[\w./\\-]+)?)\s*$/i.test(line)
    || /^\s*FAILED\s*\((?:failures|errors)=[1-9]\d*/.test(line)
    || /^\s*(?:Test (?:Suites|Files|Cases)|Tests):?\s+.*\b[1-9]\d* failed\b/i.test(line)
    || /^\s*=+\s*.*\b[1-9]\d* failed\b.*=+\s*$/i.test(line)
    || /^\s*(?:[─━-]+\s*)?(?:结果|测试结果)\s*[：:]\s*通过\s*\d+\s*项\s*[,，]\s*失败\s*[1-9]\d*\s*项/.test(line)
    || /^\s*\[\s*FAILED\s*\]\s+(?:[1-9]\d* tests?, listed below:|[\w/]+\.[\w/]+(?:\s+\(\d+(?:\.\d+)? ms\))?)\s*$/i.test(line)
    || /^\s*\d+(?:\.\d+)?% tests passed,\s*[1-9]\d* tests failed out of\s*\d+\s*$/i.test(line)
  ).slice(0, limit)
}
export const testFailureSummary = output => testFailureLines(output, 1).length > 0
// Native shells can report non-terminating errors with exit 0. Only explicit
// diagnostic lines; quoted examples and ordinary prose are not matched.
export function diagnosticFailureLines(output, limit = 5) {
  return outputLines(output).filter(line =>
    /^\s*ConvertFrom-Json\s*:\s*\S/i.test(line)
    || /^\s*parse failed(?:[.!]|:\s*\S.*)?\s*$/i.test(line)
    || /^\s*(?:(?:[^"'<>]+\.(?:[cm]?[jt]sx?|json)\(\d+,\d+\):|[^"'<>]+:\d+:\d+\s+-)\s*)?error TS\d+:\s+\S/i.test(line)
    || errorLine(line)
  ).slice(0, limit)
}
export const diagnosticFailureSummary = output => diagnosticFailureLines(output, 1).length > 0
// Whole diagnostic lines only; a property such as contextError: in a diff is
// source text, even when the enclosing tool is a shell. These are observations,
// not proof that an intended negative check failed its specification.
const errorLine = line => /^\s*(?:Error|AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|NameError|ImportError|ModuleNotFoundError|RuntimeError|PermissionError|FileNotFoundError|ParserError):\s*\S/.test(line)
export const errorOutputSummary = output => outputLines(output).some(line => errorLine(line)
  || /^\s*\[(?:exit code:|status:\s*[^\],]+,\s*exit code:)\s*[1-9]\d*\]\s*$/i.test(line))
export function boundedOutput(output, limit = 1800) {
  const text = String(output ?? '')
  if (text.length <= limit) return text
  const half = Math.floor((limit - 40) / 2)
  return `${text.slice(0, half)}\n[output truncated; head and tail kept]\n${text.slice(-half)}`
}
export function formatCheckEvidence(checks) {
  return checks.map((check, index) => {
    const warning = zeroTestSummary(check.output) ? 'WARNING: The output explicitly reports zero tests/groups. A zero exit alone is not evidence that tests ran.' : ''
    return [`Check ${index + 1} (${check.name}; exit=${check.exitCode ?? 'unknown'}${check.timedOut ? '; timed out' : ''}${check.aborted ? '; aborted' : ''})`,
      warning, `Command: ${boundedOutput(check.command, 600)}`, 'Actual output:', boundedOutput(check.output) || '[no output]'].filter(Boolean).join('\n')
  }).join('\n\n')
}
