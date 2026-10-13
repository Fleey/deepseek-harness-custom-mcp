/**
 * dsh-custom-mcp — manage MCP servers from the Settings dialog.
 *
 * Host half. The settings page (browser half: lib/client.js) edits one
 * volatile field, `servers`, through the settings service, which persists it
 * into the profile's cordis.patch.yml. On every change this plugin reconciles:
 * each enabled server runs as its own child instance of the official
 * `@deepseek-ai/dsh-mcp-client` plugin, so naming, reconnects, resources and
 * image results behave exactly as for an MCP row written by hand. Switching a
 * server off disposes its child; editing it restarts only that child.
 *
 * Status — connected / retrying / gave up, the last error, the tool list — is
 * read from the client's own log narration and served to the page at
 * `GET /dsh-custom-mcp/status`, behind the Host's request gate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { connectionKey, normalizeEntry, problemOf, ServerEntry, toClientConfig } from './servers.ts'
import { expandHome, mergePath, readLoginShellPath, referencesOf, resolveCommand, substitute } from './resolve.ts'
import { parseLabel, StatusBoard, type LogLevel } from './status.ts'

export const name = 'dsh-custom-mcp'
export const inject = ['tools']

/** Route prefix shared with lib/client.js: a wire constant between this plugin's two halves. */
export const ROUTE_PREFIX = '/dsh-custom-mcp'

export interface Config {
  servers: Volatile<ServerEntry[]>
  loginShellPath: boolean
  loginShellTimeoutMs: number
  logLines: number
}

export const Config: Schema<Config> = Schema.object({
  servers: Schema.array(ServerEntry).default([]).volatile()
    .description('MCP 服务器列表，由「设置 → MCP 服务器」页面编辑'),
  loginShellPath: Schema.boolean().default(true)
    .description('为 stdio 服务器补上登录 shell 的 PATH（桌面版从 Dock 启动时 PATH 只有系统目录）'),
  loginShellTimeoutMs: Schema.natural().default(8000)
    .description('读取登录 shell PATH 的超时'),
  logLines: Schema.natural().min(1).default(40)
    .description('每个服务器保留的最近日志行数'),
}) as unknown as Schema<Config>

interface ChildFiber {
  ctx: Context
  await(): Promise<unknown>
  dispose(): Promise<void>
}

interface Running {
  key: string
  fiber: ChildFiber
  secretRefs: string[]
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
interface WebServerLike { register(route: { kind: 'exact' | 'prefix'; path: string; handler: Handler }): () => void }
interface ToolsLike { view?(scope?: unknown): { visible: Map<string, unknown> } }
interface CredentialsLike { resolve(ref: string): Promise<{ value?: string } | undefined> }
interface ConnectionLike { requestRejection?(request: IncomingMessage): number | undefined }
interface LooseContext {
  get(name: string): unknown
  inject(deps: string[], callback: (child: any) => void): void
  on(event: string, listener: (...args: any[]) => unknown): () => void
  plugin(plugin: unknown, config?: unknown): ChildFiber
  fiber: unknown
  tools: ToolsLike
  logger: Context['logger']
  effect(execute: () => () => unknown, label?: string): unknown
}

export function apply(ctx: Context, config: Config): void {
  const host = ctx as unknown as LooseContext
  const board = new StatusBoard(config.logLines)
  const running = new Map<string, Running>()
  /** Servers to restart on the next pass even though their config is unchanged. */
  const forced = new Set<string>()
  /** Servers waiting for a credential that was missing when they last tried to start. */
  const blocked = new Map<string, string[]>()
  const loginPath = config.loginShellPath
    ? readLoginShellPath(config.loginShellTimeoutMs)
    : Promise.resolve(undefined)
  let disposed = false

  // This plugin renders its own settings page; turn off the generated form.
  try {
    host.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, host.fiber))
    })
  } catch (error) {
    ctx.logger.warn('settings integration unavailable: %s', error)
  }

  const readSecret = async (ref: string): Promise<string | undefined> => {
    const credentials = host.get('credentials') as CredentialsLike | undefined
    const hit = await credentials?.resolve(ref)
    return hit?.value || process.env[ref] || undefined
  }

  const toolsOf = (server: string): string[] => {
    try {
      const prefix = `mcp__${server}__`
      const visible = host.tools.view?.()?.visible
      if (!visible) return []
      return [...visible.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort()
    } catch {
      return []
    }
  }

  // ---- status from the MCP client's own narration -------------------------

  ctx.logger.exporter({
    // WARN carries the retry/reconnect lines; the default threshold is INFO.
    levels: { default: 2 },
    export(message) {
      try {
        const level = message.type
        if (level === 'debug') return
        const first = message.args[0]
        if (typeof first === 'string') {
          const parsed = parseLabel(first)
          if (parsed && running.has(parsed.name)) board.apply(parsed.name, level as LogLevel, parsed.text)
          return
        }
        // A child whose startup threw is reported by Cordis against its fiber.
        const fiber = message.fiber?.deref()
        if (fiber === undefined) return
        for (const [server, run] of running) {
          if (fiber.ctx === run.fiber.ctx) board.apply(server, 'error', first instanceof Error ? first.message : String(first))
        }
      } catch {
        // A status exporter must never break logging.
      }
    },
  })

  // ---- reconcile the configured list with the running children -------------

  async function start(entry: ServerEntry): Promise<void> {
    const server = entry.name
    const refs = referencesOf(entry)
    board.enter(server, 'starting')
    const { entry: resolved, missing, secretValues } = await substitute(entry, readSecret, key => process.env[key])
    board.setSecrets(server, secretValues)
    if (missing.length > 0) {
      blocked.set(server, refs.secrets)
      board.enter(server, 'invalid', { lastError: `缺少 ${missing.join('、')}` })
      return
    }
    blocked.delete(server)

    let launch = resolved
    let command: string | undefined
    if (resolved.transport === 'stdio') {
      const path = mergePath(resolved.env.PATH, await loginPath, process.env.PATH)
      command = resolveCommand(resolved.command, path)
      if (command === undefined) {
        board.enter(server, 'invalid', {
          lastError: `找不到命令 "${resolved.command}"。请填写绝对路径，或确认它在登录 shell 的 PATH 中`,
        })
        return
      }
      launch = { ...resolved, command, cwd: resolved.cwd ? expandHome(resolved.cwd) : '', env: { ...resolved.env, PATH: path } }
    }
    if (disposed) return

    let fiber: ChildFiber
    try {
      fiber = host.plugin(mcpClient, toClientConfig(launch))
    } catch (error) {
      board.enter(server, 'failed', { lastError: error instanceof Error ? error.message : String(error), command })
      return
    }
    const run: Running = { key: connectionKey(entry), fiber, secretRefs: refs.secrets }
    running.set(server, run)
    board.enter(server, 'starting', { command })
    fiber.await().then(
      () => {
        if (running.get(server) === run && board.phaseOf(server) === 'starting') board.enter(server, 'connected', { command })
      },
      (error: unknown) => {
        if (running.get(server) !== run) return
        board.enter(server, 'failed', { lastError: error instanceof Error ? error.message : String(error), command })
      },
    )
  }

  async function reconcile(): Promise<void> {
    if (disposed) return
    const seen = new Set<string>()
    const entries: ServerEntry[] = []
    for (const raw of config.servers.get() ?? []) {
      const entry = normalizeEntry(raw)
      if (seen.has(entry.name)) {
        ctx.logger.warn('duplicate MCP server name "%s" ignored', entry.name)
        continue
      }
      seen.add(entry.name)
      entries.push(entry)
    }
    const wanted = new Map(entries.filter(entry => entry.enabled && !problemOf(entry)).map(entry => [entry.name, entry]))

    // Stop first: a restarted server must release its name before it is forked again.
    for (const [server, run] of [...running]) {
      const next = wanted.get(server)
      if (next && connectionKey(next) === run.key && !forced.has(server)) continue
      running.delete(server)
      try {
        await run.fiber.dispose()
      } catch (error) {
        ctx.logger.warn('stopping MCP server "%s" failed: %s', server, error)
      }
    }

    board.retain(seen)
    for (const server of blocked.keys()) if (!seen.has(server)) blocked.delete(server)

    for (const entry of entries) {
      if (disposed) return
      if (!entry.enabled) {
        board.enter(entry.name, 'disabled')
        continue
      }
      const problem = problemOf(entry)
      if (problem) {
        board.enter(entry.name, 'invalid', { lastError: problem })
        continue
      }
      if (running.has(entry.name)) continue
      await start(entry)
    }
    forced.clear()
  }

  let chain: Promise<void> = Promise.resolve()
  let queued = false
  /** Run one reconcile pass after the current one; bursts of triggers collapse into one pass. */
  const schedule = (): Promise<void> => {
    if (disposed) return chain
    if (queued) return chain
    queued = true
    chain = chain
      .then(() => {
        queued = false
        return reconcile()
      })
      .catch((error: unknown) => {
        ctx.logger.warn('MCP reconcile failed: %s', error)
      })
    return chain
  }

  host.on('loader/volatile-update', () => { void schedule() })
  host.on('credentials/reference-updated', (ref: string) => {
    let hit = false
    for (const [server, run] of running) {
      if (run.secretRefs.includes(ref)) {
        forced.add(server)
        hit = true
      }
    }
    for (const refs of blocked.values()) if (refs.includes(ref)) hit = true
    if (hit) void schedule()
  })

  host.effect(() => () => {
    disposed = true
    const stopping = [...running.values()].map(run => run.fiber.dispose().catch(() => {}))
    running.clear()
    return Promise.all(stopping)
  }, 'dsh-custom-mcp: servers')

  void schedule()

  // ---- routes for the settings page ---------------------------------------

  const refuse = (request: IncomingMessage, response: ServerResponse): boolean => {
    const connection = host.get('connection') as ConnectionLike | undefined
    let status: number | undefined
    try {
      status = connection?.requestRejection?.call(connection, request)
    } catch {
      status = 403
    }
    if (status === undefined) return false
    sendJson(response, status, { error: status === 401 ? 'login required' : 'forbidden' })
    return true
  }

  host.inject(['webServer'], (child) => {
    const webServer = child.webServer as WebServerLike
    child.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
        sendJson(response, 200, { version: 1, servers: board.snapshot(toolsOf) })
      },
    }), 'dsh-custom-mcp: status route')

    child.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restart`,
      handler: async (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
        if (!sameOrigin(request) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
          return sendJson(response, 403, { error: 'forbidden' })
        }
        let body: unknown
        try {
          body = JSON.parse(await readBody(request, 4096))
        } catch {
          return sendJson(response, 400, { error: 'invalid body' })
        }
        const server = (body as { name?: unknown } | null)?.name
        if (typeof server !== 'string') return sendJson(response, 400, { error: 'name required' })
        forced.add(server)
        await schedule()
        sendJson(response, 200, { ok: true, servers: board.snapshot(toolsOf) })
      },
    }), 'dsh-custom-mcp: restart route')
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Refuse cross-site writes: the browser's own verdict, then Origin against Host.
 * (The JSON content type already forces a CORS preflight this route never
 * answers; this is the second fence.) No Origin means no page sent it — the
 * Desktop proxy strips it — and an app-scheme origin is the Desktop window,
 * which a web page cannot impersonate.
 */
function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    return url.host === request.headers.host
  } catch {
    return false
  }
}
