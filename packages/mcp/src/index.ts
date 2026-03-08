#!/usr/bin/env node

import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ForgeServer } from './server'
import { registerResources } from './resources'
import { registerTools } from './tools'

const forge = new ForgeServer()

// Try to resume from existing .forge/state.json
const resumed = forge.tryResume()

const mcp = new McpServer({
  name: 'forge',
  version: '0.1.0',
})

// Register all resources and tools
registerResources(mcp, forge)
registerTools(mcp, forge)

// Graceful shutdown
function shutdown() {
  forge.shutdown()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Connect via stdio
async function main() {
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Log to stderr (stdout is for MCP protocol)
  if (resumed) {
    process.stderr.write(`[forge-mcp] Resumed project ${forge.getProjectId()}, session ${forge.getSessionId()}\n`)
  } else {
    process.stderr.write(`[forge-mcp] Started — no existing project found. Use forge_init to create one.\n`)
  }
}

main().catch(err => {
  process.stderr.write(`[forge-mcp] Fatal error: ${err.message}\n`)
  process.exit(1)
})
