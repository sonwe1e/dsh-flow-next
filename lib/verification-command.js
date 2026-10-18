// Conservative invocation recognition, not a shell parser or a permission gate.
// Inspect executable/runner positions, never a keyword in a path or output string.
const basename = token => token.replaceAll('\\', '/').split('/').at(-1).toLowerCase()
const scriptName = token => /(?:^|[-_.:])(?:tests?|check|verify|verification|smoke|lint|typecheck|format-check|audit)(?:$|[-_.:])/i
  .test(basename(token).replace(/\.(?:[cm]?js|py|ps1|sh|cmd|bat|exe)$/, ''))
const runners = new Set(['pytest', 'ctest', 'eslint', 'tsc', 'vitest', 'jest', 'mocha', 'invoke-pester'])
function invocation(tokens) {
  let called = false
  if (tokens[0] === '&' || tokens[0] === '.') { called = true; tokens = tokens.slice(1) }
  while (/^[A-Za-z_][\w]*=/.test(tokens[0] ?? '')) tokens = tokens.slice(1)
  if (!tokens.length || (!called && /^["']/.test(tokens[0]))) return false
  const unquote = token => /^["']/.test(token) ? token.slice(1, -1) : token
  const [first, ...args] = tokens.map(unquote), program = basename(first).replace(/\.(?:exe|cmd|bat)$/, '')
  if (args.includes('--version') || args.includes('--help')) return false
  if (runners.has(program)) return true
  if (program === 'ruff') return ['check', 'format'].includes(args[0])
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    return scriptName(args[0] ?? '') || ['run', 'run-script'].includes(args[0]) && scriptName(args[1] ?? '')
  }
  if (program === 'npx') return invocation(args)
  if (program === 'uv' && args[0] === 'run') return invocation(args.slice(1))
  if (program === 'node') {
    if (args.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))) return false
    if (args[0] === '--check' || args[0] === '-c') return /\.[cm]?js$/i.test(args[1] ?? '')
    return args[0]?.startsWith('-') && args.includes('--test') || /\.[cm]?js$/i.test(args[0] ?? '') && scriptName(args[0])
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(program) || program === 'py') {
    const module = args.indexOf('-m')
    return module >= 0 ? ['pytest', 'unittest'].includes(args[module + 1])
      : /\.py$/i.test(args[0] ?? '') && scriptName(args[0])
  }
  if (['pwsh', 'powershell', 'bash', 'sh'].includes(program)) {
    if (args.some(arg => ['-command', '-c', '-encodedcommand'].includes(arg.toLowerCase()))) return false
    const fileFlag = args.findIndex(arg => arg.toLowerCase() === '-file')
    const file = fileFlag >= 0 ? args[fileFlag + 1] : args[0]
    return scriptName(file ?? '') || /\.(?:ps1|sh)$/i.test(file ?? '') && args.some(arg => /^-(?:test|check|verify|lint)$/i.test(arg))
  }
  if(program==='cargo')return ['test','clippy'].includes(args[0]?.startsWith('+')?args[1]:args[0])||args[0]==='fmt'&&args.includes('--check')
  if (['go', 'dotnet'].includes(program)) return ['test', 'clippy'].includes(args[0])
  if (program === 'cmake' && args.includes('--build')) {
    const target = args.indexOf('--target')
    return target >= 0 && scriptName(args[target + 1] ?? '')
  }
  // PowerShell Test-Path/Test-Json inspect data; shell `test` checks predicates.
  if (program === 'test' || /^test-/.test(program) && !/\.(?:ps1|sh)$/.test(first.toLowerCase())) return false
  return /\.(?:ps1|sh|cmd|bat|exe)$/i.test(first) && (scriptName(first) || args.some(arg => /^-(?:test|check|verify|lint)$/i.test(arg)))
}

export function verificationInvocations(command) {
  // Keep quoted arguments, here-strings and comments opaque. Separators expose
  // common chained/piped/block invocations without examining string contents.
  const tokens = String(command ?? '').match(/@'[\s\S]*?\r?\n'@|@"[\s\S]*?\r?\n"@|"(?:\\.|`.|[^"\\])*"|'(?:''|[^'])*'|#[^\r\n]*|&&|\|\||[;|\r\n{}()]|&|[^\s;|&{}()]+/g) ?? []
  let segment = [], invocations = []
  for (const token of [...tokens, ';']) {
    if (/^(?:&&|\|\||[;|\r\n{}()])$/.test(token)) {
      if (invocation(segment)) invocations.push((['&','.'].includes(segment[0]) ? segment.slice(1) : segment).join(' '))
      segment = []
    } else if (!token.startsWith('#')) segment.push(token)
  }
  return invocations
}
export const isVerification = command => verificationInvocations(command).length > 0
