/**
 * Per-server status the settings page polls.
 *
 * dsh-mcp-client publishes no status API; its supervisor narrates every
 * transition through `ctx.logger` under the label `mcp-client(<serverName>)`.
 * {@link interpret} maps those lines onto a phase, so the page can say
 * "connected", "retrying 3/10" or "gave up" without patching the client.
 */

import type { ToolInfo } from './gate.ts'

export type Phase =
  | 'disabled' // switched off in settings
  | 'invalid' // cannot start as written (missing command, duplicate name…)
  | 'starting' // fiber forked, first connection in flight
  | 'connected'
  | 'retrying' // never connected yet, backing off
  | 'reconnecting' // was connected, connection lost, backing off
  | 'failed' // reconnect budget spent or reconnect impossible; tools removed

export type LogLevel = 'error' | 'warn' | 'info'

export interface LogLine {
  ts: number
  level: LogLevel
  text: string
}

export interface ServerStatus {
  name: string
  phase: Phase
  /** Human detail for the phase, e.g. the retry attempt. */
  detail?: string
  lastError?: string
  since: number
  /** Resolved executable for stdio servers. */
  command?: string
  /** Tools the model can call now. */
  tools: string[]
  /** Every tool the server offers, switched on or off, with what the page shows on hover. */
  catalog: ToolInfo[]
  logs: LogLine[]
}

export interface Interpretation {
  phase?: Phase
  detail?: string
  error?: string
  clearError?: boolean
}

/** Read one mcp-client log line (label already stripped). */
export function interpret(level: LogLevel, text: string): Interpretation {
  let match: RegExpMatchArray | null
  if ((match = text.match(/^connection attempt failed: ([\s\S]*)$/))) return { error: match[1] }
  if ((match = text.match(/^connection failed; retrying in (\d+)ms \(attempt (\d+)\/(\d+)\)/))) {
    return { phase: 'retrying', detail: `第 ${match[2]}/${match[3]} 次重试，${match[1]}ms 后` }
  }
  if ((match = text.match(/^connection lost; reconnecting in (\d+)ms \(attempt (\d+)\/(\d+)\)/))) {
    return { phase: 'reconnecting', detail: `连接断开，第 ${match[2]}/${match[3]} 次重连，${match[1]}ms 后` }
  }
  if (/^reconnected and re-synced tools/.test(text)) return { phase: 'connected', detail: '', clearError: true }
  if (/^giving up after/.test(text)) return { phase: 'failed', detail: '重连次数用尽，工具已移除。点「重连」重试', error: text }
  if (/reconnect is disabled/.test(text)) return { phase: 'failed', detail: '', error: text }
  if (/could not confirm transport closure/.test(text)) return { phase: 'failed', detail: '', error: text }
  if (level === 'error') return { error: text }
  return {}
}

const LABEL = /^mcp-client\(([A-Za-z0-9_-]{1,32})\): ([\s\S]*)$/

/** Split `mcp-client(<name>): <text>` into its server name and text. */
export function parseLabel(line: string): { name: string; text: string } | undefined {
  const match = line.match(LABEL)
  return match ? { name: match[1]!, text: match[2]! } : undefined
}

export class StatusBoard {
  private readonly servers = new Map<string, ServerStatus>()
  private readonly secrets = new Map<string, string[]>()

  constructor(private readonly maxLogLines: number) {}

  /** Values that must never appear in what the page receives. */
  setSecrets(name: string, values: string[]): void {
    const kept = values.filter(value => value.length >= 4)
    if (kept.length) this.secrets.set(name, kept)
    else this.secrets.delete(name)
  }

  private redact(name: string, text: string): string {
    let out = text
    for (const secret of this.secrets.get(name) ?? []) out = out.split(secret).join('***')
    return out
  }

  /** Redact every string inside a JSON value. */
  private scrub(name: string, value: unknown): unknown {
    if (typeof value === 'string') return this.redact(name, value)
    if (Array.isArray(value)) return value.map(item => this.scrub(name, item))
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(name, key), this.scrub(name, item)]))
  }

  private ensure(name: string): ServerStatus {
    let status = this.servers.get(name)
    if (!status) {
      status = { name, phase: 'disabled', since: Date.now(), tools: [], catalog: [], logs: [] }
      this.servers.set(name, status)
    }
    return status
  }

  /** Enter a phase; the error and detail reset unless given. */
  enter(name: string, phase: Phase, extra: { detail?: string; lastError?: string; command?: string } = {}): void {
    const status = this.ensure(name)
    if (status.phase !== phase) status.since = Date.now()
    status.phase = phase
    status.detail = extra.detail
    status.lastError = extra.lastError === undefined ? undefined : this.redact(name, extra.lastError)
    if ('command' in extra) status.command = extra.command
  }

  phaseOf(name: string): Phase | undefined {
    return this.servers.get(name)?.phase
  }

  log(name: string, level: LogLevel, text: string): void {
    const status = this.ensure(name)
    status.logs.push({ ts: Date.now(), level, text: this.redact(name, text) })
    if (status.logs.length > this.maxLogLines) status.logs.splice(0, status.logs.length - this.maxLogLines)
  }

  /** Fold one mcp-client line into the server's status. */
  apply(name: string, level: LogLevel, text: string): void {
    this.log(name, level, text)
    const status = this.ensure(name)
    // A disabled or removed server may still flush lines while it shuts down.
    if (status.phase === 'disabled' || status.phase === 'invalid') return
    const seen = interpret(level, text)
    if (seen.phase !== undefined && seen.phase !== status.phase) {
      status.phase = seen.phase
      status.since = Date.now()
    }
    if (seen.detail !== undefined) status.detail = seen.detail || undefined
    if (seen.clearError) status.lastError = undefined
    if (seen.error !== undefined) status.lastError = this.redact(name, seen.error)
  }

  /** Forget servers no longer in the configuration. */
  retain(names: Iterable<string>): void {
    const keep = new Set(names)
    for (const name of [...this.servers.keys()]) {
      if (!keep.has(name)) {
        this.servers.delete(name)
        this.secrets.delete(name)
      }
    }
  }

  snapshot(catalogOf: (name: string) => ToolInfo[]): ServerStatus[] {
    return [...this.servers.values()].map((status) => {
      const offered = status.phase === 'disabled' || status.phase === 'invalid' ? [] : catalogOf(status.name)
      // Tool text comes from the server; a server may echo what it was started with.
      const catalog = this.secrets.has(status.name)
        ? offered.map(tool => this.scrub(status.name, tool) as ToolInfo)
        : offered
      return {
        ...status,
        tools: catalog.filter(tool => tool.enabled).map(tool => tool.name),
        catalog,
        logs: status.logs.slice(),
      }
    })
  }
}
