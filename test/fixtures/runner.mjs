// Integration scenario, run inside a scratch directory whose node_modules is
// the installed DSH runtime, so the plugin meets the real Cordis and the real
// @deepseek-ai/dsh-mcp-client. Fake services stand in for tools, credentials
// and the web server. Exits non-zero on the first failed assertion.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import * as plugin from './plugin.mjs'

const [fakeServer, scratch] = process.argv.slice(2)
const SECRET = 'tok-7f3a9c2e-very-secret'

const registered = new Map()
const tools = {
  register(definition) {
    registered.set(definition.name, definition)
    return () => { registered.delete(definition.name) }
  },
  view() { return { visible: new Map(registered) } },
}
const store = new Map([['MCP_TEST_TOKEN', SECRET]])
const credentials = { async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'test' } : undefined } }
const routes = new Map()
const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => { routes.delete(route.path) }
  },
}

const root = new Context()
root.provide('tools', tools)
root.provide('credentials', credentials)
root.provide('webServer', webServer)

const dump = name => join(scratch, `${name}.json`)
const stdio = (name, extra = {}) => ({
  name,
  transport: 'stdio',
  command: process.execPath,
  args: [fakeServer, '--dump', dump(name)],
  ...extra,
})

const initial = [
  stdio('alpha', { env: { FAKE_TOKEN: '${secret:MCP_TEST_TOKEN}' }, cwd: '~' }),
  stdio('beta', { enabled: false, command: 'node', args: [fakeServer, '--dump', dump('beta')] }),
  { name: 'gamma', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
  stdio('delta', { command: 'definitely-not-a-command-xyz' }),
  stdio('eps', { env: { FAKE_TOKEN: '${secret:LATER_TOKEN}' } }),
]

const fiber = root.plugin(plugin, { servers: initial, loginShellTimeoutMs: 8000 })
await fiber
const servers = fiber.config.servers
assert.ok(typeof servers.get === 'function', 'servers is a volatile reference')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for: ${label}\n${JSON.stringify(await status(), null, 2)}`)
}

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} registered`)
  const request = (async function* () { if (body !== undefined) yield Buffer.from(body) })()
  Object.assign(request, { method, headers: { host: '127.0.0.1:3080', ...headers } })
  let statusCode = 0
  let text = ''
  const response = {
    writeHead(code) { statusCode = code },
    end(chunk) { text = chunk ?? '' },
  }
  await handler(request, response)
  return { statusCode, json: text ? JSON.parse(text) : undefined }
}
const status = async () => Object.fromEntries((await call('/dsh-custom-mcp/status')).json.servers.map(s => [s.name, s]))
const step = label => console.log(`ok - ${label}`)

// 1. initial pass
await until('alpha connected', async () => (await status()).alpha?.phase === 'connected')
let s = await status()
assert.deepEqual(s.alpha.tools, ['echo', 'env', 'ping'])
assert.ok(registered.has('mcp__alpha__ping'))
const alphaEnv = JSON.parse(readFileSync(dump('alpha'), 'utf8'))
assert.equal(alphaEnv.token, SECRET, 'secret placeholder resolved into the child env')
assert.equal(alphaEnv.cwd, process.env.HOME, '~ cwd expanded')
assert.equal(s.beta.phase, 'disabled')
assert.equal(s.delta.phase, 'invalid')
assert.match(s.delta.lastError, /找不到命令/)
assert.equal(s.eps.phase, 'invalid')
assert.match(s.eps.lastError, /LATER_TOKEN/)
step('alpha connected with secret env; disabled/invalid entries reported')

await until('gamma retrying', async () => (await status()).gamma?.phase === 'retrying')
s = await status()
assert.ok(s.gamma.lastError, 'gamma carries its connection error')
assert.match(s.gamma.detail, /重试/)
step(`gamma retrying: ${s.gamma.detail}`)

// 2. settings edit: switch alpha off, beta on (bare `node`, found via the login-shell PATH)
updateVolatile(servers, createVolatile([
  { ...initial[0], enabled: false },
  { ...initial[1], enabled: true },
  initial[2], initial[3], initial[4],
]))
root.emit('loader/volatile-update')
await until('alpha disabled', async () => (await status()).alpha?.phase === 'disabled')
assert.ok(![...registered.keys()].some(key => key.startsWith('mcp__alpha__')), 'alpha tools unregistered')
step('switching alpha off removes its tools')

await until('beta settled', async () => ['connected', 'invalid'].includes((await status()).beta?.phase))
s = await status()
if (s.beta.phase === 'connected') {
  const betaEnv = JSON.parse(readFileSync(dump('beta'), 'utf8'))
  assert.match(s.beta.command, /\/node$/)
  assert.ok(betaEnv.path.split(':').length > 4, 'login-shell PATH handed to the child')
  step(`beta started from bare "node" → ${s.beta.command}`)
} else {
  console.log(`# beta: login shell PATH has no node (${s.beta.lastError}); skipped`)
}

// 3. a credential arriving later starts the server that waited for it
store.set('LATER_TOKEN', 'later-value-123')
root.emit('credentials/reference-updated', 'LATER_TOKEN')
await until('eps connected', async () => (await status()).eps?.phase === 'connected')
assert.equal(JSON.parse(readFileSync(dump('eps'), 'utf8')).token, 'later-value-123')
step('eps starts once its credential is stored')

// 4. restart route: guarded, then restarts
let r = await call('/dsh-custom-mcp/restart', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"name":"eps"}' })
assert.equal(r.statusCode, 403, 'cross-site restart refused')
r = await call('/dsh-custom-mcp/restart', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"eps"}' })
assert.equal(r.statusCode, 403, 'non-JSON restart refused')
r = await call('/dsh-custom-mcp/restart', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: '{"name":"eps"}' })
assert.equal(r.statusCode, 200)
await until('eps reconnected', async () => (await status()).eps?.phase === 'connected')
step('restart route guarded and working')

// 5. secrets never reach the page
const everything = JSON.stringify((await call('/dsh-custom-mcp/status')).json)
assert.ok(!everything.includes(SECRET) && !everything.includes('later-value-123'), 'no secret in status payload')
step('status payload carries no secret values')

// 6. delete a server entirely
updateVolatile(servers, createVolatile([initial[2], initial[3], { ...initial[4] }]))
root.emit('loader/volatile-update')
await until('beta gone', async () => (await status()).beta === undefined)
assert.ok(![...registered.keys()].some(key => key.startsWith('mcp__beta__')))
step('deleted servers are stopped and forgotten')

// 7. unload: every child goes with the plugin
await fiber.dispose()
assert.equal([...registered.keys()].filter(key => key.startsWith('mcp__')).length, 0, 'all MCP tools unregistered on unload')
assert.equal(routes.size, 0, 'routes removed on unload')
step('plugin unload stops all servers and routes')

assert.ok(existsSync(dump('alpha')))
console.log('ALL PASSED')
process.exit(0)
