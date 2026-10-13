// Pure host-side helpers, bundled from src/ on the fly.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const project = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(project, 'node_modules/.cache/dsh-custom-mcp-test')
mkdirSync(outdir, { recursive: true })
await build({
  stdin: {
    contents: `export * from './src/status.ts'; export * from './src/resolve.ts'; export * from './src/servers.ts'; export * from './src/gate.ts'`,
    resolveDir: project,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(outdir, 'host.mjs'),
  logLevel: 'silent',
})
const host = await import(pathToFileURL(join(outdir, 'host.mjs')).href)

test('interpret maps mcp-client narration onto phases', () => {
  assert.deepEqual(host.interpret('warn', 'connection attempt failed: Error: boom'), { error: 'Error: boom' })
  assert.equal(host.interpret('warn', 'connection failed; retrying in 500ms (attempt 1/10)').phase, 'retrying')
  assert.equal(host.interpret('warn', 'connection lost; reconnecting in 1000ms (attempt 2/10)').phase, 'reconnecting')
  const back = host.interpret('info', 'reconnected and re-synced tools (attempt 2/10)')
  assert.equal(back.phase, 'connected')
  assert.equal(back.clearError, true)
  assert.equal(host.interpret('error', 'giving up after 10 consecutive failed reconnect attempts — tools unregistered').phase, 'failed')
  assert.deepEqual(host.interpret('info', 'tool list changed, re-syncing'), {})
})

test('parseLabel splits the client label', () => {
  assert.deepEqual(host.parseLabel('mcp-client(git-hub): connection attempt failed: x'), { name: 'git-hub', text: 'connection attempt failed: x' })
  assert.equal(host.parseLabel('something else'), undefined)
})

test('StatusBoard redacts secrets and folds phases', () => {
  const board = new host.StatusBoard(3)
  board.setSecrets('a', ['s3cr3t-value'])
  board.enter('a', 'starting')
  board.apply('a', 'warn', 'connection attempt failed: 401 for token s3cr3t-value')
  board.apply('a', 'warn', 'connection failed; retrying in 500ms (attempt 1/10)')
  const [status] = board.snapshot(() => ['t1'])
  assert.equal(status.phase, 'retrying')
  assert.ok(!JSON.stringify(status).includes('s3cr3t-value'))
  assert.match(status.lastError, /\*\*\*/)
  for (let i = 0; i < 5; i++) board.log('a', 'info', `line ${i}`)
  assert.equal(board.snapshot(() => [])[0].logs.length, 3, 'log ring is bounded')
  board.retain([])
  assert.equal(board.snapshot(() => []).length, 0)
})

test('StatusBoard reports the catalog, enabled tools only in tools, and redacts it', () => {
  const board = new host.StatusBoard(3)
  board.setSecrets('a', ['s3cr3t-value'])
  board.enter('a', 'connected')
  const catalog = [
    { name: 'on', description: 'uses s3cr3t-value', parameters: { type: 'object', properties: { k: { default: 's3cr3t-value' } } }, enabled: true },
    { name: 'off', description: '', enabled: false },
  ]
  const [status] = board.snapshot(() => catalog)
  assert.deepEqual(status.tools, ['on'])
  assert.deepEqual(status.catalog.map(tool => tool.name), ['on', 'off'])
  assert.ok(!JSON.stringify(status).includes('s3cr3t-value'))
  assert.equal(status.catalog[0].parameters.properties.k.default, '***')
  board.enter('a', 'disabled')
  assert.deepEqual(board.snapshot(() => catalog)[0].catalog, [], 'a switched-off server offers nothing')
})

test('ToolGate forwards switched-on tools and switches in place', () => {
  const registry = new Map()
  const real = {
    register(definition) {
      if (registry.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registry.set(definition.name, definition)
      return () => { registry.delete(definition.name) }
    },
    other() { return 'passed through' },
  }
  const errors = []
  const gate = new host.ToolGate('mcp__s__', real, ['b'], (tool, error) => errors.push(`${tool}: ${error.message}`))
  const tools = gate.facade(real)
  assert.equal(tools.other(), 'passed through')
  const def = name => ({ name: `mcp__s__${name}`, description: `does ${name}`, parameters: { type: 'object' } })
  const disposers = ['c', 'a', 'b'].map(name => tools.register(def(name)))
  assert.deepEqual([...registry.keys()].sort(), ['mcp__s__a', 'mcp__s__c'])
  assert.deepEqual(gate.list().map(tool => [tool.name, tool.enabled]), [['a', true], ['b', false], ['c', true]])
  assert.equal(gate.list()[0].description, 'does a')
  assert.throws(() => tools.register(def('b')), /already registered/, 'duplicates throw like the registry')

  const before = registry.get('mcp__s__a')
  gate.update(['c'])
  assert.deepEqual([...registry.keys()].sort(), ['mcp__s__a', 'mcp__s__b'])
  assert.equal(registry.get('mcp__s__a'), before, 'untouched tools stay registered')

  // A refused re-registration is reported, not thrown.
  registry.set('mcp__s__c', {})
  gate.update([])
  assert.match(errors[0], /^c: duplicate/)
  registry.delete('mcp__s__c')

  disposers[1]()
  disposers[1]()
  assert.ok(!registry.has('mcp__s__a'), 'the client withdrawing a tool unregisters it')
  assert.deepEqual(gate.list().map(tool => tool.name), ['b', 'c'])

  gate.close()
  assert.equal(registry.size, 0)
  tools.register(def('late'))
  assert.equal(registry.size, 0, 'nothing reaches the registry after close')
})

test('ToolGate: a refused registration leaves no trace', () => {
  const real = { register() { throw new Error('conflict') } }
  const gate = new host.ToolGate('mcp__s__', real, [])
  assert.throws(() => gate.register({ name: 'mcp__s__x' }), /conflict/)
  assert.deepEqual(gate.list(), [])
})

test('servers: problems, keys and client config', () => {
  const base = host.normalizeEntry({ name: 'x', command: 'npx' })
  assert.equal(host.problemOf(base), undefined)
  assert.match(host.problemOf({ ...base, command: '' }), /命令/)
  assert.match(host.problemOf({ ...base, transport: 'streamable-http', url: 'ftp://a' }), /http/)
  assert.equal(host.problemOf({ ...base, transport: 'streamable-http', url: 'https://${env:HOST}/mcp' }), undefined)
  assert.equal(host.connectionKey(base), host.connectionKey({ ...base, enabled: false, description: 'note' }), 'on/off and notes do not restart')
  assert.equal(host.connectionKey(base), host.connectionKey({ ...base, disabledTools: ['x'] }), 'switching tools does not restart')
  assert.deepEqual(base.disabledTools, [])
  assert.deepEqual(host.normalizeEntry({ name: 'x', disabledTools: ['a', 1, 'a', 'b'] }).disabledTools, ['a', 'b'])
  assert.notEqual(host.connectionKey(base), host.connectionKey({ ...base, args: ['-y'] }))
  assert.equal(host.connectionKey({ ...base, env: { A: '1', B: '2' } }), host.connectionKey({ ...base, env: { B: '2', A: '1' } }))
  const http = host.toClientConfig({ ...base, transport: 'streamable-http', url: 'https://a/mcp', headers: { A: 'b' } })
  assert.deepEqual(Object.keys(http).sort(), ['failOnStartupError', 'headers', 'serverName', 'toolCallTimeoutMs', 'transport', 'url'])
})

test('resolve: placeholders, PATH merge, command lookup', async () => {
  const entry = host.normalizeEntry({
    name: 'x', command: 'node', env: { T: '${secret:REF}', H: '${env:HOME}', M: '${secret:MISSING}' },
  })
  const { entry: out, missing, secretValues } = await host.substitute(entry, async ref => (ref === 'REF' ? 'v1' : undefined), key => process.env[key])
  assert.equal(out.env.T, 'v1')
  assert.equal(out.env.H, process.env.HOME)
  assert.deepEqual(missing, ['凭据 MISSING'])
  assert.deepEqual(secretValues, ['v1'])
  assert.deepEqual(host.referencesOf(entry), { secrets: ['REF', 'MISSING'], env: ['HOME'] })
  assert.equal(host.mergePath('/a:/b', undefined, '/b:/c'), '/a:/b:/c')
  assert.equal(host.resolveCommand('sh', '/nonexistent:/bin'), '/bin/sh')
  assert.equal(host.resolveCommand('definitely-not-here-xyz', '/bin:/usr/bin'), undefined)
  assert.equal(host.resolveCommand('/bin/sh', ''), '/bin/sh')
})
