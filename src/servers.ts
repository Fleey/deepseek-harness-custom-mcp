/**
 * One MCP server as the settings page edits it, and the translation into the
 * config row `@deepseek-ai/dsh-mcp-client` accepts.
 *
 * The page writes the whole `servers` list in one settings mutation; the Host
 * validates it against {@link ServerEntry} before anything is persisted, so an
 * entry that reaches {@link toClientConfig} is already shape-checked. What the
 * schema cannot say (a stdio entry without a command, an HTTP entry with a bad
 * URL) is reported by {@link problemOf} as the server's status instead of
 * failing the whole plugin.
 */

import Schema from '@deepseek-ai/schemastery'

export type Transport = 'stdio' | 'streamable-http'

export interface ServerEntry {
  /** Tool namespace: tools appear as `mcp__<name>__<tool>`. Unique in the list. */
  name: string
  enabled: boolean
  description: string
  transport: Transport
  command: string
  args: string[]
  /** Extra child environment; values may hold `${secret:REF}` / `${env:VAR}`. */
  env: Record<string, string>
  cwd: string
  url: string
  /** Extra request headers; values may hold `${secret:REF}` / `${env:VAR}`. */
  headers: Record<string, string>
  toolCallTimeoutMs: number
}

/** Same rule as dsh-mcp-client's `serverName`. */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export const ServerEntry: Schema<ServerEntry> = Schema.object({
  name: Schema.string().pattern(SERVER_NAME).required()
    .description('工具命名空间，1–32 位字母、数字、_ 或 -'),
  enabled: Schema.boolean().default(true),
  description: Schema.string().default(''),
  transport: Schema.union(['stdio', 'streamable-http']).default('stdio'),
  command: Schema.string().default(''),
  args: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  cwd: Schema.string().default(''),
  url: Schema.string().default(''),
  headers: Schema.dict(Schema.string()).default({}),
  toolCallTimeoutMs: Schema.natural().min(1000).default(60_000),
}) as unknown as Schema<ServerEntry>

/** Fill every field, tolerating values written by hand into cordis.patch.yml. */
export function normalizeEntry(raw: { readonly [K in keyof ServerEntry]?: unknown } & { readonly name: string }): ServerEntry {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const dict = (value: unknown): Record<string, string> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  }
  return {
    name: String(raw.name),
    enabled: raw.enabled !== false,
    description: typeof raw.description === 'string' ? raw.description : '',
    transport: raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command.trim() : '',
    args: strings(raw.args),
    env: dict(raw.env),
    cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '',
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
    headers: dict(raw.headers),
    toolCallTimeoutMs: typeof raw.toolCallTimeoutMs === 'number' && raw.toolCallTimeoutMs >= 1000
      ? raw.toolCallTimeoutMs
      : 60_000,
  }
}

/** Why an entry cannot be started as written, or undefined when it can. */
export function problemOf(entry: ServerEntry): string | undefined {
  if (!SERVER_NAME.test(entry.name)) return `名称 "${entry.name}" 无效：只能用 1–32 位字母、数字、_ 或 -`
  if (entry.transport === 'stdio') {
    if (entry.command === '') return '未填写启动命令'
    return undefined
  }
  if (entry.url === '') return '未填写 URL'
  // Placeholders may sit anywhere in the URL; check the shape with them blanked.
  try {
    const url = new URL(entry.url.replace(/\$\{[^}]*\}/g, 'x'))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `URL 必须是 http(s)：${entry.url}`
  } catch {
    return `URL 无效：${entry.url}`
  }
  return undefined
}

/**
 * Identity of a running connection: a server restarts when, and only when,
 * something that reaches the MCP client changed. `enabled` and `description`
 * are deliberately left out.
 */
export function connectionKey(entry: ServerEntry): string {
  const { enabled: _enabled, description: _description, ...rest } = entry
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify({ ...rest, env: sorted(rest.env), headers: sorted(rest.headers) })
}

/** Config row for `@deepseek-ai/dsh-mcp-client`, built from a resolved entry. */
export type ClientConfig =
  | {
    transport: 'stdio'
    serverName: string
    command: string
    args: string[]
    env: Record<string, string>
    cwd: string
    toolCallTimeoutMs: number
    failOnStartupError: false
  }
  | {
    transport: 'streamable-http'
    serverName: string
    url: string
    headers: Record<string, string>
    toolCallTimeoutMs: number
    failOnStartupError: false
  }

export function toClientConfig(entry: ServerEntry): ClientConfig {
  if (entry.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: entry.name,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      toolCallTimeoutMs: entry.toolCallTimeoutMs,
      failOnStartupError: false,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: entry.name,
    url: entry.url,
    headers: entry.headers,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    failOnStartupError: false,
  }
}
