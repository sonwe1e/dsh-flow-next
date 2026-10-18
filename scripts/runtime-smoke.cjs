// Installed-host mechanism check. Fixed responses; provider dispatch is forbidden.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { randomUUID, createHash } = require('node:crypto')

async function main() {
  if (!process.versions.electron) throw new Error('Run with the installed DSH Electron Node runtime')
  const root = path.resolve(__dirname, '..')
  const skillRoot = path.resolve(process.env.AMBITIOUS_PROMPT_SOURCE || path.join(root, '..', 'ambitious-prompt'))
  if (!fs.existsSync(path.join(skillRoot, 'cordis.patch.yml'))) throw new Error('Clone the companion ambitious-prompt repo beside this checkout or set AMBITIOUS_PROMPT_SOURCE')
  const record = path.join(root, 'artifacts', 'runtime-' + randomUUID())
  fs.mkdirSync(record, { recursive: true })
  // Native Windows PTC needs an owned directory where it can grant sandbox ACLs.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flow-next-workspace-'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flow-next-smoke-'))
  const packages = { '@sonwe1e/dsh-flow-next': root, '@sonwe1e/ambitious-prompt': skillRoot }
  const modules = path.join(profile, 'node_modules', '@sonwe1e')
  fs.mkdirSync(modules, { recursive: true })
  for (const [name, target] of Object.entries(packages)) {
    fs.symlinkSync(target, path.join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'flow-next-smoke', private: true,
    dependencies: Object.fromEntries(Object.entries(packages).map(([name, target]) => [name, 'link:' + target.replaceAll('\\', '/')])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(packages)] } } }))
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n- id: session-persistence-jsonl\n  config:\n    root: ' + JSON.stringify(path.join(record, 'sessions').replaceAll('\\', '/')) + '\n')
  const core = createRequire(path.join(path.dirname(process.execPath), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'))
  const load = name => import(pathToFileURL(core.resolve(name)).href)
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
  const { FLOW_NEXT_VERSION, FLOW_NEXT_GUIDANCE } = await import(pathToFileURL(path.join(root, 'lib/flow-next.js')).href)
  const text = value => ({ type: 'text', text: value })
  const tool = (name, args, id) => ({ type: 'tool-call', name, arguments: JSON.stringify(args), id })
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const targetContent = JSON.stringify('module.exports = { value: 3 }\n')
  const plans = [
    [tool('read', { file_path: 'module.cjs' }, 'read-input'), tool('flow_select', { presentation: 'ptc', capabilities: 'full', reason: 'Apply the determined edit and run the existing check' }, 'select-ptc')],
    [tool('run_code', { description: 'Controlled native edit, permission denial and check', code: `await tools.read({file_path:'module.cjs'}); await tools.write({file_path:'module.cjs',content:${targetContent}}); let denial=''; try { await tools.write({file_path:'blocked.txt',content:'forbidden'}); } catch(error) { denial=error.message; } return {denial,check:await tools.${shell}({command:'node check.cjs',description:'Run the existing check'})};` }, 'ptc-work')],
    [text('The controlled edit and existing check are complete.')]
  ]
  let app, requests = 0, dispatches = 0
  const captures = [], handles = []
  const deadline = setTimeout(() => { console.error('Installed-host smoke exceeded 60 seconds'); process.exit(1) }, 60000)
  try {
    const environment = boot.loadLayeredEnv('dsh')
    app = await runProfile({ environment, profile: 'desktop', resolvedProfile: {
      profile: boot.loadProfileDirectory('dsh', profile, core.resolve('@deepseek-ai/dsh/package.json')),
      installAnchor: core.resolve('@deepseek-ai/dsh/package.json')
    }, patchFiles: [], args: ['--no-open', '--port', '0'] })
    const { ctx } = app
    ctx.llm.adapterStream = () => { dispatches++; throw new Error('Provider dispatch is forbidden') }
    ctx.on('llm/stream', request => {
      if (request.purpose && request.purpose !== 'agent') throw new Error('Unexpected request purpose blocked')
      const blocks = plans[requests++]
      if (!blocks) throw new Error('Unexpected fixed request blocked')
      const system = (request.messages || []).filter(m => m.role === 'system').flatMap(m => m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      captures.push({ tools: (request.tools || []).map(t => t.name).sort(), guidance: system.includes(FLOW_NEXT_GUIDANCE) })
      return (async function* () {
        for (const [index, block] of blocks.entries()) yield { type: 'block-end', index, block }
        yield { type: 'finish', reason: { kind: 'completed' } }
      })()
    })
    const skill = await ctx.get('skills').get('ambitious-prompt', { cwd: fixture })
    assert.ok(skill && skill.content.includes('先确定本轮交付'))
    assert.equal(skill.provider, 'ambitious-prompt', 'The bundle provider, rather than an older user copy, must supply the tested skill')
    fs.writeFileSync(path.join(fixture, 'module.cjs'), 'module.exports = { value: 1 }\n')
    fs.writeFileSync(path.join(fixture, 'check.cjs'), "require('node:assert/strict').equal(require('./module.cjs').value,3); console.log('FLOW_NEXT_SMOKE_PASS')\n")
    const create = async preset => {
      const handle = await ctx.agents.create({ sessionId: 'flow-next-smoke-' + randomUUID(),
        meta: { cwd: fixture, agentPreset: preset }, agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
        setup: async child => {
          await child.get('agentPresets').mount(child, preset)
          child.tools.guard(exec => exec.name === 'write' && exec.arguments.file_path === 'blocked.txt' ? 'FLOW_NEXT_SMOKE_DENIAL' : undefined)
        } })
      handles.push(handle)
      return handle
    }
    const neighbor = await create('standard')
    const before = ctx.tools.wireSchemas(neighbor.agent).schemas.map(t => t.name).sort()
    const handle = await create('flow-next')
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [text('Change the exported value to 3 and run the existing check.')] }))
    await handle.agent.whenIdle()
    assert.equal(handle.agent.status, 'idle')
    fs.writeFileSync(path.join(record, 'tool-events.json'), JSON.stringify(handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/call' || event.type === 'tool/result'), null, 2))
    assert.equal(requests, 3)
    for (const name of ['read', 'write', shell, 'flow_select', 'flow_task', 'flow_run_check', 'flow_stage', 'flow_check']) assert.ok(captures[0].tools.includes(name), name)
    assert.deepEqual(captures[1].tools, ['run_code'])
    assert.ok(captures.every(c => c.guidance))
    assert.ok(fs.readFileSync(path.join(fixture, 'module.cjs'), 'utf8').includes('value: 3'))
    assert.ok(!fs.existsSync(path.join(fixture, 'blocked.txt')))
    const events = JSON.stringify(handle.agent.session.snapshotEvents())
    assert.ok(events.includes('FLOW_NEXT_SMOKE_PASS'), 'The real existing check must have executed successfully')
    assert.ok(events.includes('FLOW_NEXT_SMOKE_DENIAL'), 'The native guard must be observed')
    assert.deepEqual(ctx.tools.wireSchemas(neighbor.agent).schemas.map(t => t.name).sort(), before)
    assert.ok(!before.includes('flow_check'))
    const status = await ctx.get('commands').execute(handle.agent, '/flow-next status', [], new AbortController().signal)
    assert.equal(status.result.kind, 'success')
    assert.ok(status.result.text.includes('Flow Next ' + FLOW_NEXT_VERSION))
    assert.equal(dispatches, 0)
    const report = { runtime: core('@deepseek-ai/dsh/package.json').version, modeVersion: FLOW_NEXT_VERSION,
      fixedRequests: requests, providerDispatches: dispatches, skillProvider: skill.provider,
      checks: { bundleMount: true, companionSkillLoad: true, nativeToPtc: true, realFileEdit: true, existingCheck: true, permissionGuard: true, neighborScope: true, actualGuidance: true, versionCommand: true },
      guidanceSha256: createHash('sha256').update(FLOW_NEXT_GUIDANCE).digest('hex'),
      limitation: 'Fixed responses verify native mechanisms, not model task quality or performance.' }
    fs.writeFileSync(path.join(record, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ...report, record }))
  } finally {
    clearTimeout(deadline)
    for (const handle of handles.reverse()) await handle.dispose()
    await app?.shutdown.shutdown(0)
    // Remove only known files/links from the verified temporary profile. Never recurse across a dependency junction.
    const native = require('node:original-fs')
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()))
    assert.ok(path.basename(profile).startsWith('dsh-flow-next-smoke-'))
    for (const [name, target] of Object.entries(packages)) {
      const link = path.join(profile, 'node_modules', name)
      assert.ok(native.lstatSync(link).isSymbolicLink())
      assert.equal(native.realpathSync(link), native.realpathSync(target))
      if (process.platform === 'win32') native.rmdirSync(link)
      else native.unlinkSync(link)
    }
    for (const file of ['cordis.patch.yml', 'cordis.yml', 'package.json']) {
      const target = path.join(profile, file)
      if (native.existsSync(target)) native.unlinkSync(target)
    }
    for (const dir of [modules, path.dirname(modules), profile]) native.rmdirSync(dir)
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(String(error.stack)); process.exit(1) })
