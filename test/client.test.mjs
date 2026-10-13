// Pure helpers of the browser half (client/client.js), loaded without a DOM.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/client.js'), 'utf8')
let factory
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } } })
const mod = factory(() => ({}))
// Values come from another realm; compare them as plain JSON.
const plain = fn => (...args) => JSON.parse(JSON.stringify(fn(...args)))
const { makeRef } = mod.internals
const splitCommandLine = plain(mod.internals.splitCommandLine)
const parseImport = plain(mod.internals.parseImport)
const fromDraft = plain(mod.internals.fromDraft)
const toDraft = plain(mod.internals.toDraft)
const compact = plain(mod.internals.compact)
const t = key => key

test('module shape', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.inject.includes('configForms'))
})

test('splitCommandLine honours quotes and escapes', () => {
  assert.deepEqual(splitCommandLine('npx -y "@a/b c" x\\ y \'q r\''), ['npx', '-y', '@a/b c', 'x y', 'q r'])
  assert.deepEqual(splitCommandLine('  uvx   mcp-server-git  '), ['uvx', 'mcp-server-git'])
})

test('makeRef yields a POSIX identifier', () => {
  assert.equal(makeRef('remote-demo', 'HDR', 'Authorization'), 'MCP_REMOTE_DEMO_HDR_AUTHORIZATION')
  assert.match(makeRef('a.b', 'ENV', 'x-y'), /^[A-Za-z_][A-Za-z0-9_]*$/)
})

test('parseImport: Claude Desktop shape, secrets, interpolation, renames, skips', () => {
  const json = JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x', LOG: 'debug', HOME_DIR: '${HOME}' } },
      'remote demo': { type: 'sse', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer abc' } },
      existing: { command: 'foo' },
      'one-line': { command: 'uvx mcp-server-time --local-timezone Asia/Shanghai' },
      broken: { foo: 1 },
      off: { command: 'bar', disabled: true },
    },
  })
  const result = parseImport(json, ['existing'], t)
  assert.equal(result.error, undefined)
  const byName = Object.fromEntries(result.entries.map(e => [e.name, e]))
  assert.deepEqual(Object.keys(byName).sort(), ['github', 'off', 'one-line', 'remote-demo'])
  assert.equal(byName.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, '${secret:MCP_GITHUB_ENV_GITHUB_PERSONAL_ACCESS_TOKEN}')
  assert.equal(byName.github.env.LOG, 'debug')
  assert.equal(byName.github.env.HOME_DIR, '${env:HOME}')
  assert.equal(byName['remote-demo'].transport, 'streamable-http')
  assert.equal(byName['remote-demo'].headers.Authorization, '${secret:MCP_REMOTE_DEMO_HDR_AUTHORIZATION}')
  assert.equal(byName['one-line'].command, 'uvx')
  assert.deepEqual(byName['one-line'].args, ['mcp-server-time', '--local-timezone', 'Asia/Shanghai'])
  assert.equal(byName.off.enabled, false)
  assert.deepEqual(result.secrets.map(s => s.value).sort(), ['Bearer abc', 'ghp_x'])
  // `t` echoes keys, so each note is its message key.
  assert.deepEqual([...result.notes].sort(), ['noteBad', 'noteRenamed', 'noteSkipExisting', 'noteSse'])
})

test('parseImport rejects bad input', () => {
  assert.ok(parseImport('{nope', [], t).error)
  assert.ok(parseImport('[1,2]', [], t).error)
})

test('fromDraft validates and moves secrets out of the entry', () => {
  const draft = toDraft(undefined)
  Object.assign(draft, {
    name: 'gh',
    command: 'npx -y @modelcontextprotocol/server-github',
    env: [
      { id: 'a', key: 'GITHUB_TOKEN', value: 'tok', secret: true, ref: '', stored: false, touched: true },
      { id: 'b', key: 'PLAIN', value: 'v', secret: false, ref: '', stored: false, touched: true },
      { id: 'c', key: 'KEPT', value: '', secret: true, ref: 'MCP_OLD', stored: true, touched: true },
    ],
  })
  const ok = fromDraft(draft, new Set(['other']), t)
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.entry.command, 'npx')
  assert.deepEqual(ok.entry.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.equal(ok.entry.env.GITHUB_TOKEN, '${secret:MCP_GH_ENV_GITHUB_TOKEN}')
  assert.equal(ok.entry.env.PLAIN, 'v')
  assert.equal(ok.entry.env.KEPT, '${secret:MCP_OLD}')
  assert.deepEqual(ok.secrets, [{ ref: 'MCP_GH_ENV_GITHUB_TOKEN', value: 'tok' }])

  const bad = fromDraft({ ...draft, name: 'other' }, new Set(['other']), t)
  assert.equal(bad.errors.name, 'eNameTaken')
  assert.equal(fromDraft({ ...draft, name: 'a b' }, new Set(), t).errors.name, 'eNamePattern')
  assert.equal(fromDraft({ ...draft, command: '' }, new Set(), t).errors.command, 'eCommand')
  const http = fromDraft({ ...draft, transport: 'streamable-http', url: 'ftp://x' }, new Set(), t)
  assert.equal(http.errors.url, 'eUrl')
  const missingSecret = fromDraft({ ...draft, env: [{ id: 'z', key: 'K', value: '', secret: true, ref: '', stored: false }] }, new Set(), t)
  assert.equal(missingSecret.errors['env.z'], 'eSecretValue')
})

test('compact leaves defaults out and round-trips through toDraft', () => {
  const entry = { name: 'x', enabled: true, description: '', transport: 'stdio', command: 'c', args: [], env: {}, cwd: '', url: '', headers: {}, toolCallTimeoutMs: 60000 }
  assert.deepEqual(compact(entry), { name: 'x', enabled: true, transport: 'stdio', command: 'c' })
  const draft = toDraft({ ...entry, env: { T: '${secret:MCP_X}' } })
  assert.equal(draft.env[0].stored, true)
  assert.equal(draft.env[0].ref, 'MCP_X')
  assert.equal(draft.env[0].value, '')
})
