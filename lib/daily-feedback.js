import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { extract } from './telemetry.js'
import { attributeTrajectory, argumentsOf, textOf, evidenceMarkers, exitCodeOf, resultOrigin } from './trajectory.js'
import { flowEvidenceText, flowModeBinding, flowContextText, flowTaskSupportText, flowCheckProtocolText } from './request-binding.js'
import { FLOW_NEXT_SOURCE } from './flow-next.js'
import { boundedOutput, testFailureLines, diagnosticFailureLines } from './check-evidence.js'

export const DEFAULT_FEEDBACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../feedback')
const hash = value => createHash('sha256').update(value).digest('hex')
const labels = { success: '成功', partial: '部分完成', failed: '失败', unrated: '未评分' }
const outcomes = new Map([['ok','success'],['success','success'],['成功','success'],['partial','partial'],['部分完成','partial'],['failed','failed'],['失败','failed'],['note','unrated'],['备注','unrated']])

export function parseFeedback(input = '') {
  const text = String(input).trim(), first = /^\S+/.exec(text)?.[0]
  return outcomes.has(first) ? { outcome: outcomes.get(first), note: text.slice(first.length).trim() } : { outcome: 'unrated', note: text }
}

// Bounded local excerpts, never adapter defaults/headers or file-tool payloads.
// This is best-effort redaction; the user can inspect the package before sharing.
export function redact(text) {
  return String(text ?? '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(["']?\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password)=)[^&#\s]+/gi, '$1[REDACTED]')
}
const clip = (text, limit) => { const safe = redact(text); return safe.length > limit ? safe.slice(0, limit) + '\n[截断]' : safe }
const messageOf = event => event.data?.message ?? event.data ?? {}
const shell = new Set(['pwsh','bash','shell'])
const positiveTime = value => Number.isFinite(value) && value > 0 ? value : null
const firstAndRecent = (items, limit, first = 1) => items.length <= limit ? items : [...items.slice(0,first), ...items.slice(-(limit-first))]

function workflowSummary(events, requests) {
  const contexts = requests.filter(r => Number.isFinite(r.inputTokens) && Number.isFinite(r.cacheReadTokens))
    .map(r => r.inputTokens + r.cacheReadTokens)
  return { requestsWithoutTools: requests.filter(r=>r.calls.length===0).length,
    singleToolRequests: requests.filter(r=>r.calls.length===1).length,
    multipleToolRequests: requests.filter(r=>r.calls.length>1).length,
    inputContext: { knownResponses: contexts.length, unknownResponses: requests.length-contexts.length,
      meanKnownTokens: contexts.length ? contexts.reduce((sum,n)=>sum+n,0)/contexts.length : null,
      maxKnownTokens: contexts.length ? contexts.reduce((max,n)=>Math.max(max,n),0) : null },
    compactionSummaries: events.filter(e=>e.type==='compaction/summary').length }
}

function waitingTime(turn, questions, endedAt) {
  const intervals = []
  let complete = turn.startedAt !== null && endedAt !== null
  for (const question of questions.filter(q => q.turn === turn.number)) {
    if (question.startedAt === null || question.endedAt === null) complete = false
    if (question.startedAt === null || turn.startedAt === null || endedAt === null) continue
    const start = Math.max(turn.startedAt, question.startedAt), end = Math.min(endedAt, question.endedAt ?? endedAt)
    if (end < start) { complete = false; continue }
    intervals.push([start, end])
  }
  intervals.sort((a,b) => a[0]-b[0])
  const merged = []
  for (const interval of intervals) {
    if (merged.length && interval[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], interval[1])
    else merged.push([...interval])
  }
  const knownMs = merged.reduce((sum,[start,end]) => sum+end-start,0)
  return { knownHumanWaitMs: knownMs, humanWaitMs: complete ? knownMs : null, humanWaitComplete: complete }
}

function questionExcerpt(question) {
  let answers = null
  try { answers = JSON.parse(question.output).answers } catch {}
  return { turn: question.turn, step: question.step, status: question.endedAt === null ? 'unresolved' : 'returned',
    durationMs: question.startedAt !== null && question.endedAt !== null ? Math.max(0,question.endedAt-question.startedAt) : null,
    questions: (Array.isArray(question.arguments.questions) ? question.arguments.questions : []).slice(0,6).map(q => ({
      id: clip(q.id,120), question: clip(q.question,1200),
      options: (Array.isArray(q.options) ? q.options : []).slice(0,12).map(option => ({ label: clip(option.label,160), description: clip(option.description,240) })) })),
    answers: Array.isArray(answers) ? answers.slice(0,6).map(a => ({ id: clip(a.id,120),
      selected: Array.isArray(a.selected) ? a.selected.slice(0,12).map(value=>clip(value,400)) : [], text: clip(a.text ?? a.answer,1200) })) : null,
    response: clip(question.output,4000) }
}

export function recordedCompactionUsage(events) {
  const summaries=events.filter(e=>e.type==='compaction/summary'), calls=summaries.filter(e=>e.data?.llmStreamCall===true)
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0
  let known=0, missing=0
  for(const event of calls) {
    const usage=event.data?.usage
    if(valid(usage?.totalTokens))known+=usage.totalTokens
    else if(valid(usage?.inputTokens)&&valid(usage?.outputTokens)&&valid(usage?.cacheReadTokens))known+=usage.inputTokens+usage.outputTokens+usage.cacheReadTokens
    else missing++
  }
  return { recordedSummaries:summaries.length, recordedLlmSummaries:calls.length,
    unknownSummaryOrigin:summaries.filter(e=>typeof e.data?.llmStreamCall!=='boolean').length,
    knownSummaryRawTokens:known, recordedSummaryRawTokens:missing?null:known, missingSummaryUsage:missing,
    totalCompactionCost:null, limitation:'Successful recorded LLM summaries only. Failed/retried calls may have unrecorded cost; not added to historical main-response totals.' }
}

export function createDailyFeedback({ events, header = {}, sessionId, note = '', outcome = 'unrated', now = Date.now(), exporter = {} }) {
  if (!Array.isArray(events)) throw new Error('无法读取当前会话事件')
  const metrics = extract(events), turns = [], configs = [], messages = [], exposure = [], issues = [], operations = [], questions = [], bindings = []
  const openCalls = []
  let active = null, latestPreset = header.agentPreset ?? null, flowResponses = 0, boundFlowResponses = 0, recallResponses=0, recallCharacters=0
  const flowNext={responses:0,supportResponses:0,cumulativeSupportCharacters:0,checkProtocolResponses:0,cumulativeCheckProtocolCharacters:0,queuedSelections:0,appliedSelections:0,rollbacks:0,unknownInterfaceRecords:0,charactersAreNotTokens:true}
  const writtenFiles = new Set()
  for (const event of events) {
    const data = event.data ?? {}, message = messageOf(event)
    if (event.type === 'agent-preset/selected') latestPreset = data.agentPreset ?? latestPreset
    if(event.type==='developer/message'&&message.source?.kind===FLOW_NEXT_SOURCE) {
      try {
        const record=JSON.parse(textOf(message)),field={queued:'queuedSelections',applied:'appliedSelections',rollback:'rollbacks'}[record.event]
        if(record.flowAdaptive===1&&field)flowNext[field]++;else flowNext.unknownInterfaceRecords++
      }catch{flowNext.unknownInterfaceRecords++}
    }
    if (event.type === 'request/header') {
      const config = data.header?.config ?? {}
      const item = { provider: config.provider ?? null, model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null }
      if (configs.at(-1) && JSON.stringify(configs.at(-1)) === JSON.stringify(item)) continue
      configs.push(item)
    }
    if (event.type === 'turn/start') {
      active = { number: data.turn ?? turns.length + 1, startedAt: positiveTime(event.time), endedAt: null, status: 'in-progress', events: [event] }
      turns.push(active)
    } else if (active) active.events.push(event)
    if (event.type === 'turn/end' && active) {
      active.endedAt = positiveTime(event.time); active.status = data.reason?.kind ?? 'unknown'; active = null
    }
    if (event.type === 'user/message') messages.push(message)
    if (event.type === 'assistant/message' && message.source?.kind === 'model') {
      const recalled=flowContextText(messages)
      if(recalled) { recallResponses++; recallCharacters+=recalled.length }
      const evidence = flowEvidenceText(messages)
      if (evidence) exposure.push({ turn: data.turn ?? null, step: data.step ?? null, text: clip(evidence, 1200) })
      const binding = flowModeBinding(messages)
      if (['flow','flow-next'].includes(latestPreset)) { flowResponses++; if (binding?.mode===latestPreset) boundFlowResponses++ }
      if(binding?.mode==='flow-next') {
        flowNext.responses++
        const support=flowTaskSupportText(messages)
        if(support){flowNext.supportResponses++;flowNext.cumulativeSupportCharacters+=support.length}
        const checks=flowCheckProtocolText(messages)
        if(checks){flowNext.checkProtocolResponses++;flowNext.cumulativeCheckProtocolCharacters+=checks.length}
      }
      if (binding && (!bindings.length || JSON.stringify(bindings.at(-1).binding) !== JSON.stringify(binding))) {
        bindings.push({ turn: data.turn ?? null, step: data.step ?? null, binding })
      }
    }
    if (event.type === 'tool/call') {
      const args = argumentsOf(event), item = { turn: data.turn ?? null, step: data.step ?? null, name: data.name,
        file: typeof args.file_path === 'string' ? clip(args.file_path, 400) : null,
        command: shell.has(data.name) ? clip(args.command ?? args.cmd ?? '', 600) : null }
      operations.push(item)
      if (['write','edit'].includes(data.name) && typeof args.file_path === 'string') writtenFiles.add(args.file_path)
      const call = { id: data.callId, turn: data.turn ?? active?.number ?? null, step: data.step ?? null, name: data.name, command: item.command }
      if (data.name === 'ask_user_question') {
        call.question = { turn: call.turn, step: call.step, arguments: args, startedAt: positiveTime(event.time), endedAt: null, output: '' }
        questions.push(call.question)
      }
      openCalls.push(call)
    }
    if (event.type === 'tool/result') {
      const output = textOf(message)
      const id = message.source?.callId ?? message.toolCallId
      const index = id === undefined ? -1 : openCalls.findIndex(call => call.id === id
        && call.turn === (data.turn ?? active?.number ?? null) && call.step === (data.step ?? null))
      const call = index < 0 ? null : openCalls.splice(index,1)[0]
      const origin = resultOrigin(call?.name, message.isError), execution = origin !== 'source-text'
      const diagnostics = !call || shell.has(call.name) || call.name === 'job_output'
      const markers = evidenceMarkers(output, { diagnostics, execution })
      if (call?.question) { call.question.endedAt = positiveTime(event.time); call.question.output = output }
      const exitCode = execution ? exitCodeOf(event) : null
      if (message.isError || (exitCode !== null && exitCode !== 0) || markers.some(marker => marker !== 'all-pass')) {
        issues.push({ turn: data.turn ?? null, step: data.step ?? null, toolCallId: message.toolCallId ?? message.source?.callId ?? null,
          name: call?.name ?? null, command: call?.command ?? null, origin,
          isToolError: message.isError === true, exitCode, markers, failureSummaryLines: execution ? testFailureLines(output).map(line=>clip(line,400)) : [],
          diagnosticSummaryLines: diagnostics ? diagnosticFailureLines(output).map(line=>clip(line,400)) : [],
          excerpt: boundedOutput(redact(output), 1200), outputSha256: hash(output) })
      }
    }
  }
  const turnRows = turns.map(turn => {
    const m = extract(turn.events), endedAt = turn.endedAt ?? (turn.status === 'in-progress' ? now : null)
    const complete = turn.status !== 'in-progress' && m.incompleteAttempts === 0 && m.usageReported
    const activeMs = turn.startedAt !== null && endedAt !== null ? Math.max(0, endedAt-turn.startedAt) : null
    const timing = waitingTime(turn,questions,endedAt)
    return { number: turn.number, status: turn.status, activeMs, ...timing,
      executionMs: activeMs !== null && timing.humanWaitComplete ? Math.max(0,activeMs-timing.humanWaitMs) : null,
      modelCalls: m.modelCalls, recordedRawTokens: complete ? m.totalTokens : null, knownRecordedRawTokens: m.knownTotalTokens,
      recordedUsageComplete: complete, incompleteAttempts: m.incompleteAttempts }
  })
  const activeMs = turnRows.length && turnRows.every(t => t.activeMs !== null) ? turnRows.reduce((sum,t)=>sum+t.activeMs,0) : null
  const humanWaitComplete = turnRows.every(t=>t.humanWaitComplete) && questions.every(q=>turnRows.some(t=>t.number===q.turn))
  const knownHumanWaitMs = turnRows.reduce((sum,t)=>sum+t.knownHumanWaitMs,0)
  const humanWaitMs = humanWaitComplete ? knownHumanWaitMs : null
  const executionMs = activeMs !== null && humanWaitComplete ? Math.max(0,activeMs-humanWaitMs) : null
  const incomplete = turnRows.some(t=>t.status==='in-progress') || metrics.incompleteAttempts > 0 || !metrics.usageReported
  const attribution = attributeTrajectory(events, { products: [...writtenFiles] })
  const human = events.filter(e => e.type === 'user/message' && messageOf(e).source?.kind === 'user')
  const selectedPrompts = human.length > 12 ? [human[0], ...human.slice(-11)] : human
  // Native /goal records intent in command/run, not in a human user/message.
  // Only this task command's args are selected; other commands may hold credentials.
  const humanCommands = events.filter(e=>e.type==='command/run' && e.data?.source?.kind==='user' && e.data?.name==='goal')
  const selectedCommands = firstAndRecent(humanCommands,12)
  const answers = events.filter(e => e.type === 'assistant/message' && messageOf(e).source?.kind === 'model' && textOf(messageOf(e)).trim())
  const nativeFeedback = events.filter(e => e.type === 'feedback/record').slice(-20).map(e => ({ category: e.data?.category ?? null, text: clip(e.data?.text, 2000) }))
  const modeVersions = [...new Set(bindings.map(row=>row.binding.modeVersion))]
  const modeVersion = ['flow','flow-next'].includes(latestPreset) && modeVersions.length === 1 && boundFlowResponses === flowResponses
    && bindings.every(row=>row.binding.mode===latestPreset) ? modeVersions[0] : null
  return { schemaVersion: 3, kind: 'daily-session-feedback', exportedAt: new Date(now).toISOString(), exporter,
    session: { id: sessionId ?? header.sessionId ?? null, cwd: header.cwd ? redact(header.cwd) : null, preset: latestPreset,
      modeVersion, modeVersionNote: modeVersion ? '版本来自模型请求前的实际 Flow runtime-context；不是导出器版本。'
        : bindings.length ? '会话版本绑定不完整、包含多个版本或当前模式不同；逐项绑定见 modeBindings。' : '原会话未记录模式源码版本；exporter 版本不等于执行时的模式版本。' },
    userFeedback: { outcome, label: labels[outcome] ?? labels.unrated, note: clip(note, 4000), independentVerification: 'not-performed' },
    nativeFeedback, configurations: configs, modeBindings: bindings.slice(-20),
    contextRecall: { responses:recallResponses, cumulativeCharacters:recallCharacters, charactersAreNotTokens:true },
    flowNext,
    compactionUsage: recordedCompactionUsage(events),
    metrics: { lastAgentStatus: active ? 'in-progress' : metrics.status, turns: turnRows.length, activeMs,
      humanWaitMs, knownHumanWaitMs, humanWaitComplete, executionMs,
      recordedRawTokens: incomplete ? null : metrics.totalTokens, knownRecordedRawTokens: metrics.knownTotalTokens, recordedUsageComplete: !incomplete,
      freshInputTokens: metrics.freshInputTokens, cacheReadTokens: metrics.cacheReadTokens, outputTokens: metrics.outputTokens,
      tokenBreakdownComplete: metrics.tokenBreakdownReported, cacheInputRatio: metrics.cacheHitRatio, flowResponses, boundFlowResponses,
      modelCalls: metrics.modelCalls, missingUsageCalls: metrics.missingUsageCalls, incompleteAttempts: metrics.incompleteAttempts,
      auxiliaryTitleRequests: metrics.auxiliaryTitleRequests, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors, toolBreakdown: metrics.toolBreakdown,
      nonzeroExitResults: issues.filter(issue=>issue.origin !== 'unmatched-result' && issue.exitCode !== null && issue.exitCode !== 0).length,
      diagnosticIssueResults: issues.filter(issue=>issue.origin !== 'unmatched-result').length,
      unattributedIssueResults: issues.filter(issue=>issue.origin === 'unmatched-result').length,
      delegatedToolCalls: operations.filter(o => ['subagent','subagent_fork','workflow'].includes(o.name)).length,
      allProviderCost: null },
    turns: turnRows, prompts: selectedPrompts.map(e => ({ turn: e.data?.turn ?? null, time: positiveTime(e.time), text: clip(textOf(messageOf(e)), 2500) })),
    humanCommands: selectedCommands.map(e=>({ time: positiveTime(e.time), name: 'goal',
      argumentsRecorded: typeof e.data.args==='string', text: clip('/goal'+(typeof e.data.args==='string' ? ' '+e.data.args.trim() : ' [参数未记录]'),2500) })),
    userQuestions: questions.slice(-12).map(questionExcerpt),
    deliveries: answers.slice(-6).map(e => ({ turn: e.data?.turn ?? null, step: e.data?.step ?? null, text: clip(textOf(messageOf(e)), 2500) })),
    attemptedWriteFiles: [...writtenFiles].slice(-40).map(f=>clip(f,400)), operations: operations.slice(-100), issues: firstAndRecent(issues,20,5), evidence: exposure.slice(-20),
    workflow: workflowSummary(events,attribution.requests),
    trajectory: { phases: attribution.phases, requests: attribution.requests.slice(-100), totalRequests: attribution.modelCalls },
    bounds: { prompts: 12, promptChars: 2500, humanCommands: 12, humanCommandChars: 2500,
      userQuestions: 12, modeBindings: 20, deliveries: 6, deliveryChars: 2500, operations: 100, issues: 20, issueSelection: 'first-5-and-last-15', evidence: 20,
      omittedHumanCommands: Math.max(0,humanCommands.length-12),
      omittedModeBindings: Math.max(0,bindings.length-20),
      omittedUserQuestions: Math.max(0,questions.length-12),
      omittedPrompts: Math.max(0,human.length-12), omittedDeliveries: Math.max(0,answers.length-6), omittedOperations: Math.max(0,operations.length-100),
      omittedIssues: Math.max(0,issues.length-20), omittedEvidence: Math.max(0,exposure.length-20), omittedRequests: Math.max(0,attribution.modelCalls-100) },
    limitations: ['用户评价不是独立验收；正常结束不代表任务做好。', '用量仅来自当前会话已保存响应；未完成响应、子代理和辅助调用的完整费用未汇总。',
      'activeMs 累加轮内耗时，含 ask_user_question 等待；humanWaitMs 合并实际问答时间区间，executionMs 扣除此等待但仍含模型、工具、复制及网络时间。未结束问答的完整扣除量保持未知。',
      'toolErrors 仅统计工具 isError；非零退出和诊断问题另列。成功的文件/搜索输出不作执行诊断；未匹配原始调用的结果单列 unattributedIssueResults，不推断是哪次执行。诊断标记不是独立失败验收。',
      'humanCommands 仅摘录 source.kind=user 的原生 /goal；其他命令参数不导出。工具问答和真人消息另列，不从系统目标通知推断真人授权。',
      'workflow 覆盖全部已记录主请求；单工具比例不等于浪费率，已知上下文均值不补齐缺失 usage，压缩次数不证明需求丢失。',
      '保留有限文本片段和工具命令，不导出读文件全文、写入内容、reasoning 原文、适配器配置或请求头。',
      '常见凭据尽力遮盖，任务文本仍可能含私人资料；文件仅本地保存，分享前可检查。',
      '会话反馈不是随机配对 benchmark，不能单独证明相对创造的提升。'] }
}

const quote = text => String(text ?? '').split('\n').map(line=>'> '+line).join('\n')
export function dailyFeedbackMarkdown(report) {
  const m = report.metrics, raw = m.recordedRawTokens === null ? '未知' : m.recordedRawTokens.toLocaleString('en-US')
  const seconds = value => value == null ? '未知' : (value/1000).toFixed(2)+' 秒'
  const tokens = value => value == null ? '未知' : value.toLocaleString('en-US')
  return ['# Flow 日常反馈', '', `导出时间：${new Date(report.exportedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）`,
    `会话：${report.session.id}；模式：${report.session.preset ?? '未知'}；项目：${report.session.cwd ?? '未知'}`, '',
    `实际模式版本：${report.session.modeVersion ?? '未知'}。${report.session.modeVersionNote}`, '',
    `用户评价：**${report.userFeedback.label}**。独立验收：未执行。`, quote(report.userFeedback.note || '未补充评价'), '',
    `Agent 最后状态：${m.lastAgentStatus}；记录的 raw tokens：${raw}；记录完整：${m.recordedUsageComplete?'是':'否'}。`,
    `已记录非缓存输入：${tokens(m.freshInputTokens)}；缓存读取：${tokens(m.cacheReadTokens)}；输出：${tokens(m.outputTokens)}。输入缓存占比：${m.cacheInputRatio==null?'未知':(m.cacheInputRatio*100).toFixed(2)+'%'}。raw 包含重复计入的缓存上下文，完整费用未知。`, '',
    `累计轮内耗时（含确认等待）：${seconds(m.activeMs)}；确认等待：${seconds(m.humanWaitMs)}；扣除确认等待：${seconds(m.executionMs)}。扣除后仍含模型、工具、复制和网络时间。`,
    `模型响应：${m.modelCalls}；工具调用：${m.toolCalls}；工具 isError：${m.toolErrors}；观察到的非零退出结果：${m.nonzeroExitResults ?? '未知'}；诊断问题结果：${m.diagnosticIssueResults ?? '未知'}；未关联调用的问题线索：${m.unattributedIssueResults ?? '未知'}。`, '',
    ...(report.contextRecall ? [`压缩后原话补充：${report.contextRecall.responses} 次主响应；累计 ${report.contextRecall.cumulativeCharacters} 字符。字符不是tokens，也不是节省量。`, ''] : []),
    ...(report.compactionUsage ? [`已记录成功压缩摘要的模型调用：${report.compactionUsage.recordedLlmSummaries}；已知 raw：${tokens(report.compactionUsage.knownSummaryRawTokens)}；缺用量摘要：${report.compactionUsage.missingSummaryUsage}；来源未知摘要：${report.compactionUsage.unknownSummaryOrigin}。失败/重试成本可能缺失，完整压缩费用未知，未并入历史主响应统计。`, ''] : []),
    ...(report.flowNext?.responses ? [`Flow Next实际绑定响应：${report.flowNext.responses}；条件支持进入${report.flowNext.supportResponses}次响应，累计${report.flowNext.cumulativeSupportCharacters}字符；接口选择排队/应用/回退：${report.flowNext.queuedSelections}/${report.flowNext.appliedSelections}/${report.flowNext.rollbacks}。这些是运行观察，不是性能或质量评分。`, ''] : []),
    ...(report.flowNext?.checkProtocolResponses ? [`检查协议进入${report.flowNext.checkProtocolResponses}次响应，累计${report.flowNext.cumulativeCheckProtocolCharacters}字符。协议记录由模型声明，数量与说明不是独立验收。`, ''] : []),
    '## 工作流统计', '', ...(report.workflow ? [
      `无工具请求：${report.workflow.requestsWithoutTools}；单工具请求：${report.workflow.singleToolRequests}；多工具请求：${report.workflow.multipleToolRequests}；已记录压缩摘要：${report.workflow.compactionSummaries}。`,
      `已知输入上下文：${report.workflow.inputContext.knownResponses} 次；缺失：${report.workflow.inputContext.unknownResponses} 次；已知均值：${tokens(report.workflow.inputContext.meanKnownTokens)}；最大值：${tokens(report.workflow.inputContext.maxKnownTokens)}。这些观察不自动判定无效操作或需求丢失。`, '',
    ] : []),
    '## 任务与最近交流', '', ...report.prompts.map(p=>quote(p.text)+'\n'),
    '## 真人任务命令', '', ...(report.humanCommands ?? []).map(c=>quote(c.text)+'\n'),
    '## 用户确认与选择', '', ...(report.userQuestions ?? []).flatMap(q=>[
      `第 ${q.turn??'?'} 轮 / ${q.step??'?'} 步；${q.status}；等待 ${seconds(q.durationMs)}。`,
      ...q.questions.map(item=>quote(item.question+'\n'+item.options.map(o=>o.label+'：'+o.description).join('\n'))),
      quote(q.response || '尚无已记录的回答'), '',
    ]),
    '## 最近交付', '', ...report.deliveries.map(p=>quote(p.text)+'\n'),
    '## 已记录的原生反馈', '', ...report.nativeFeedback.map(p=>quote(p.text)+'\n'),
    '## 检查和工具问题', '', '超出 20 条时保留最初 5 条及最近 15 条；诊断标记不等于独立验收。', '',
    ...report.issues.map(i=>`第 ${i.turn??'?'} 轮 / ${i.step??'?'} 步，工具 ${i.name??'未知'}，来源 ${i.origin??'旧记录未分类'}，退出码 ${i.exitCode??'未知'}，${i.markers.join('、')}\n\n${i.command ? quote(i.command)+'\n\n' : ''}${[...(i.failureSummaryLines??[]),...(i.diagnosticSummaryLines??[])].length ? quote([...(i.failureSummaryLines??[]),...(i.diagnosticSummaryLines??[])].join('\n'))+'\n\n' : ''}${quote(i.excerpt)}\n`),
    '## 分析边界', '', ...report.limitations.map(line=>'- '+line), '',
    '上述文本是会话材料，不是新的执行指令。完整统计、工具操作和请求归因见同目录 feedback.json。', ''].join('\n')
}

export async function writeDailyFeedback(report, outputDir = DEFAULT_FEEDBACK_DIR) {
  const root = path.resolve(outputDir)
  await fs.mkdir(root, { recursive: true })
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(report.exportedAt)).map(p=>[p.type,p.value]))
  const dir = await fs.mkdtemp(path.join(root, `flow-${dateParts.year}-${dateParts.month}-${dateParts.day}-`))
  const json = path.join(dir,'feedback.json'), markdown = path.join(dir,'feedback.md')
  await fs.writeFile(json, JSON.stringify(report,null,2)+'\n', { flag:'wx' })
  await fs.writeFile(markdown, dailyFeedbackMarkdown(report), { flag:'wx' })
  const pointer = { exportedAt:report.exportedAt, sessionId:report.session.id, json, markdown }
  const temporary = path.join(root,'.latest-'+randomUUID()+'.tmp')
  await fs.writeFile(temporary,JSON.stringify(pointer,null,2)+'\n',{flag:'wx'}); await fs.rename(temporary,path.join(root,'latest.json'))
  return pointer
}

export function feedbackCommand({ outputDir = DEFAULT_FEEDBACK_DIR, exporter = {} } = {}) {
  return { name:'flow-feedback', description:'将当前会话及你的评价整理成本地 Flow 反馈，不调用模型', recordInput:false,
    input:{hint:'[ok|partial|failed|note] [哪里满意或不满意]'}, handler:async ({agent,rawInput}) => {
      if (/^(?:help|帮助)$/.test(String(rawInput??'').trim())) return {kind:'success',text:'/flow-feedback ok 已完成且实际验证通过\n/flow-feedback partial 能用，但反复验证或遗漏要求\n/flow-feedback failed 未解决，具体问题是…\n不带参数可导出当前记录。随后在 Codex 说“分析最新 Flow 反馈”。'}
      try {
        if (!agent?.session || typeof agent.session.snapshotEvents !== 'function') throw new Error('找不到当前会话，请在要反馈的 DSH 会话内执行')
        const report = createDailyFeedback({events:agent.session.snapshotEvents(0),header:agent.session.header,sessionId:agent.session.id,...parseFeedback(rawInput),exporter})
        const files = await writeDailyFeedback(report,outputDir)
        return {kind:'success',text:`反馈已本地保存，没有追加模型调用。\n评价：${report.userFeedback.label}\n报告：${files.markdown}\n数据：${files.json}\n在 Codex 说“分析最新 Flow 反馈”，并提供此报告路径。`}
      } catch(error) { return {kind:'error',text:`反馈导出失败：${error.message}`} }
    } }
}
