import { createHash } from 'node:crypto'

// Bump when sampling, isolation, measurement or grading semantics change.
export const PROTOCOL_VERSION = 2

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function hashOf(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24)
}

export function isSuccessful(run) {
  return run?.verification?.verdict === 'passed' && run.metrics?.status === 'completed' && run.configurationValid !== false
}

export function hasUsage(run) {
  return run?.metrics?.usageReported === true && Number.isFinite(run.metrics.totalTokens)
}

export function positiveLimit(...values) {
  const limits = values.filter((value) => Number.isFinite(value) && value > 0)
  return limits.length ? Math.min(...limits) : 0
}
