// Runs test/fixtures/runner.mjs against an installed DSH runtime.
// DSH_RUNTIME: the runtime's app directory (holding node_modules/@deepseek-ai/*).
// DSH_NODE: a Node >= 22.19 binary; defaults to the Desktop app run as Node.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const desktop = '/Applications/DSH NEXT.app'
const runtime = process.env.DSH_RUNTIME ?? join(desktop, 'Contents/Resources/app')
const node = process.env.DSH_NODE ?? join(desktop, 'Contents/MacOS/DSH NEXT')
const available = existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-mcp-client')) && existsSync(node)

test('host plugin against the real dsh-mcp-client', { skip: !available && 'no DSH runtime found', timeout: 120_000 }, () => {
  assert.ok(existsSync(join(project, 'lib/index.js')), 'run `pnpm build` first')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-custom-mcp-'))
  try {
    symlinkSync(join(runtime, 'node_modules'), join(scratch, 'node_modules'))
    copyFileSync(join(project, 'lib/index.js'), join(scratch, 'plugin.mjs'))
    copyFileSync(join(here, 'fixtures/runner.mjs'), join(scratch, 'runner.mjs'))
    const result = spawnSync(node, [join(scratch, 'runner.mjs'), join(here, 'fixtures/fake-mcp-server.mjs'), scratch], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 110_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    process.stdout.write(result.stdout)
    if (result.status !== 0) process.stderr.write(result.stderr)
    assert.equal(result.status, 0, 'runner failed')
    assert.match(result.stdout, /ALL PASSED/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
