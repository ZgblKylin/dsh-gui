#!/usr/bin/env node
/**
 * Minimal stdio MCP server used to verify `dsh-mcp-on-demand` end to end
 * without starting a real analysis engine.
 *
 * It speaks newline-delimited JSON-RPC 2.0 (the MCP stdio framing), answers the
 * initialize handshake with the client's requested protocol version, and
 * publishes one `ping` tool. Run it through an mcp-client entry:
 *
 *   command: node
 *   args: [<this file>]
 *
 * It is a test fixture, not part of the installed package (`files` excludes it).
 */

import { createInterface } from 'node:readline'

const serverInfo = { name: 'fake-mcp', version: '0.0.0' }

/** @param {unknown} message @returns {void} */
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object' || message.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  const fail = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo,
      })
      return
    case 'ping':
      reply({})
      return
    case 'tools/list':
      reply({
        tools: [{
          name: 'ping',
          description: 'Returns pong; test tool for dsh-mcp-on-demand.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      })
      return
    case 'tools/call':
      reply({ content: [{ type: 'text', text: `pong from ${serverInfo.name} (tool: ${String(message.params?.name)})` }] })
      return
    default:
      fail(-32601, `method not found: ${String(message.method)}`)
  }
})
