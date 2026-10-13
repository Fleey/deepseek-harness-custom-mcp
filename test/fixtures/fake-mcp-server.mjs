#!/usr/bin/env node
// Minimal stdio MCP server for tests: newline-delimited JSON-RPC, legacy
// initialize handshake, three tools. No dependencies.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// `--dump <file>`: record the environment this process was started with.
const dumpAt = process.argv.indexOf('--dump')
if (dumpAt !== -1) {
  writeFileSync(process.argv[dumpAt + 1], JSON.stringify({
    token: process.env.FAKE_TOKEN ?? null,
    path: process.env.PATH ?? '',
    cwd: process.cwd(),
  }))
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

const tools = [
  { name: 'ping', description: 'Reply with pong.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'echo',
    description: 'Echo the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'env',
    description: 'Report whether FAKE_TOKEN is set and how PATH starts.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const text = value => ({ content: [{ type: 'text', text: value }] })

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      send({
        id,
        result: {
          protocolVersion: SUPPORTED.includes(requested) ? requested : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        },
      })
      return
    }
    case 'ping':
      send({ id, result: {} })
      return
    case 'tools/list':
      send({ id, result: { tools } })
      return
    case 'tools/call': {
      const name = params?.name
      if (name === 'ping') return send({ id, result: text('pong') })
      if (name === 'echo') return send({ id, result: text(String(params?.arguments?.text ?? '')) })
      if (name === 'env') {
        return send({
          id,
          result: text(JSON.stringify({ token: process.env.FAKE_TOKEN ?? null, path: process.env.PATH ?? '' })),
        })
      }
      return send({ id, error: { code: -32602, message: `unknown tool ${name}` } })
    }
    default:
      send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
