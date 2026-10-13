/**
 * Turn a saved entry into what a process can actually start with.
 *
 * - `${secret:REF}` reads the dsh credential store, `${env:VAR}` the Host
 *   environment, so tokens never have to sit in cordis.patch.yml.
 * - A Desktop Host launched from the Dock inherits `/usr/bin:/bin:/usr/sbin:/sbin`;
 *   `npx`, `uvx`, `docker`… live elsewhere. The user's login-shell PATH is read
 *   once and handed to stdio servers, and bare commands are resolved against it
 *   so a missing binary is reported plainly instead of as ten failed retries.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ServerEntry } from './servers.ts'

const PLACEHOLDER = /\$\{(secret|env):([A-Za-z_][A-Za-z0-9_]*)\}/g

export type ReadSecret = (ref: string) => Promise<string | undefined>

/** Credential and environment references an entry's values mention. */
export function referencesOf(entry: ServerEntry): { secrets: string[]; env: string[] } {
  const secrets = new Set<string>()
  const env = new Set<string>()
  const values = [entry.command, entry.cwd, entry.url, ...entry.args, ...Object.values(entry.env), ...Object.values(entry.headers)]
  for (const value of values) {
    for (const match of value.matchAll(PLACEHOLDER)) (match[1] === 'secret' ? secrets : env).add(match[2]!)
  }
  return { secrets: [...secrets], env: [...env] }
}

/** Replace every placeholder in every string field; missing references are collected, not thrown. */
export async function substitute(
  entry: ServerEntry,
  readSecret: ReadSecret,
  readEnv: (name: string) => string | undefined,
): Promise<{ entry: ServerEntry; missing: string[]; secretValues: string[] }> {
  const { secrets } = referencesOf(entry)
  const secretValues = new Map<string, string | undefined>()
  await Promise.all(secrets.map(async (ref) => {
    let value: string | undefined
    try { value = await readSecret(ref) } catch { value = undefined }
    secretValues.set(ref, value)
  }))
  const missing = new Set<string>()
  const fill = (text: string) => text.replace(PLACEHOLDER, (_match, kind: string, name: string) => {
    const value = kind === 'secret' ? secretValues.get(name) : readEnv(name)
    if (value === undefined || value === '') {
      missing.add(kind === 'secret' ? `凭据 ${name}` : `环境变量 ${name}`)
      return ''
    }
    return value
  })
  const mapValues = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]))
  return {
    entry: {
      ...entry,
      command: fill(entry.command),
      cwd: fill(entry.cwd),
      url: fill(entry.url),
      args: entry.args.map(fill),
      env: mapValues(entry.env),
      headers: mapValues(entry.headers),
    },
    missing: [...missing],
    secretValues: [...secretValues.values()].filter((value): value is string => typeof value === 'string' && value !== ''),
  }
}

/** `~` and `~/x` relative to the home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

const MARK = '__DSH_CUSTOM_MCP_PATH__'

/**
 * PATH as the user's interactive login shell sets it, or undefined when it
 * cannot be read in time (no SHELL, Windows, a shell that hangs on startup).
 */
export function readLoginShellPath(timeoutMs: number): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (_error, stdout) => {
        // Interactive startup files may print banners; take only the marked span.
        const start = stdout?.indexOf(MARK) ?? -1
        const end = start < 0 ? -1 : stdout.indexOf(MARK, start + MARK.length)
        resolve(start >= 0 && end > start ? stdout.slice(start + MARK.length, end) || undefined : undefined)
      },
    )
  })
}

/** Join PATH lists in priority order, dropping empties and repeats. */
export function mergePath(...lists: Array<string | undefined>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const dir of (list ?? '').split(delimiter)) {
      if (dir === '' || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
  }
  return out.join(delimiter)
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path of `command` on `path`, the command itself when it is a path, or undefined. */
export function resolveCommand(command: string, path: string): string | undefined {
  const expanded = expandHome(command)
  if (expanded.includes('/') || (process.platform === 'win32' && expanded.includes('\\'))) {
    return isAbsolute(expanded) && !isExecutable(expanded) ? undefined : expanded
  }
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : ['']
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = join(dir, expanded + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}
