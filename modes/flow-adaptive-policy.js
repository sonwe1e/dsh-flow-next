import { defineTool, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { AdaptiveFlow, ADAPTIVE_SOURCE, LOCAL_CAPABILITIES } from '../lib/flow-adaptive.js'

export const name = 'flow-adaptive-policy'
export const inject = ['tools', 'systemPrompt', 'agents']

// Each disposer owns ONLY this controller's effects. Permissions remain in DSH.
export function presentationInstaller(ctx, agent) {
  const tools = ctx.get('tools')
  return target => {
    const disposers = []
    const release = () => {
      for (const dispose of disposers.splice(0).reverse()) {
        if (dispose()?.then) throw new Error('DSH asynchronous tool effects are unsupported by this controller')
      }
    }
    try {
      if (target.presentation === 'ptc') tools.requirePtcRuntime('ptc')
      disposers.push(tools.presentAs(target.presentation))
      if (target.capabilities === 'local') {
        const allow = tools.schemas(agent).map(tool => tool.name).filter(name => name !== 'run_code' && LOCAL_CAPABILITIES.has(name))
        disposers.push(tools.restrict({ allow }))
        // The registry deliberately exempts agent-owned late registrations
        // (e.g. subagent's structured tool) from inherited filters. Curate the
        // wire/SDK surface AND guard execution; never remove their owner.
        disposers.push(tools.guard(exec => exec.name === 'run_code' || LOCAL_CAPABILITIES.has(exec.name)
          ? undefined : 'Flow local range excludes this tool; request full for the next step'))
        disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const assembly = await next()
          if (context.scope !== agent) return assembly
          const mode = tools.modeFor(agent)
          const sections = assembly.sections.map(section => {
            if (section.name !== 'tools:sdk' || mode === 'native') return section
            const schemas = tools.sdkSchemas(agent).filter(schema => LOCAL_CAPABILITIES.has(schema.name))
            const runtime = tools.requirePtcRuntime(mode)
            return { ...section, text: (runtime.language === 'python' ? renderToolsSdkPy : renderToolsSdk)(schemas) }
          })
          return { ...assembly, sections, tools: assembly.tools.filter(tool => tool.name === 'run_code' || LOCAL_CAPABILITIES.has(tool.name)) }
        }))
      }
      tools.wireSchemas(agent) // fail before admitting an inconsistent state
      return release
    } catch (error) { release(); throw error }
  }
}
export function attachAdaptive(ctx, agent, config = {}) {
  const tools = ctx.get('tools')
  const pendingRecords = []
  const writeRecord = record => {
    let turn = 0, step = 0, open = false
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'turn/start') { turn = event.data.turn; step = 0 }
      if (event.type === 'step/start') { step = event.data.step; open = true }
      if (event.type === 'step/end') open = false
    }
    if (!open) { pendingRecords.push(record); return }
    agent.session.append('developer/message', { turn, step,
      message: createDeveloperMessage({ content: [{ type: 'text', text: JSON.stringify(record) }], source: { kind: ADAPTIVE_SOURCE } }),
    }, { surfaceOp: 'append' })
  }
  const controller = new AdaptiveFlow({ events: () => agent.session.snapshotEvents(), config,
    install: presentationInstaller(ctx, agent), available: target => {
      try { if (target.presentation === 'ptc') tools.requirePtcRuntime('ptc') } catch (error) { return error.message }
    }, record: writeRecord })
  ctx.effect(() => () => controller.dispose())
  ctx.get('systemPrompt').variable('flow_adaptive_state', () => controller.boundary())
  ctx.get('systemPrompt').context({ name: 'flow:adaptive-state', order: 50, text: () => controller.status() })
  // The v4 persistence format requires developer messages within an open
  // step. Effects change before assembly; their ledger commits at request
  // admission after step/start, always before provider dispatch.
  ctx.on('agent/request', async (_event, next) => {
    for (const record of pendingRecords.splice(0)) writeRecord(record)
    return next()
  })
  // Assembly inspection also evaluates variables, but openStep prevents a
  // switch while a batch is active. Validate the final waterfall output.
  ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    const actual = tools.modeFor(agent)
    if (actual !== controller.state.current.presentation) throw new Error('Flow interface drift detected')
    return decision
  })
  return controller
}
export function apply(ctx, config = {}) {
  const controllers = new WeakMap()
  ctx.get('tools').register(defineTool({ name: 'flow_select',
    description: 'Select the next request interface and capability range in this session. Current-batch tools keep their existing interface. Use only for a concrete useful next operation. The configured selection limit and cooldown apply; inspect the returned status. No model or permission change.',
    parameters: { presentation: { type: 'string', enum: ['native', 'ptc'], required: true },
      capabilities: { type: 'string', enum: ['full', 'local'], required: true },
      reason: { type: 'string', required: true, description: 'Concrete next operation that benefits; at most 240 characters.' } },
    isConcurrencySafe: () => false,
    execute: (args, exec) => ({ text: JSON.stringify(controllers.get(exec.agent)?.select({ presentation: args.presentation,
      capabilities: args.capabilities }, args.reason) ?? { accepted: false, reason: 'Controller is unavailable' }) }),
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
  }))
  // Serial, awaited factory announcement runs for fresh AND resumed agents,
  // after mounting and before they can make their first request.
  ctx.on('agent/created', ({ agent }) => { controllers.set(agent, attachAdaptive(agent.ctx, agent, config)) })
}
