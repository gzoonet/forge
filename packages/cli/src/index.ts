#!/usr/bin/env node

import * as path from 'path'
import { config } from 'dotenv'

// Load .env from project root (two levels up from packages/cli)
config({ path: path.resolve(__dirname, '../../..', '.env') })
// Also load .env from cwd (where forge is run)
config()

import { init, turn, model, events, brief, artifacts, tensions, actions, execute, trust, workspace, workspaceRebuild, memory, setup, test } from './commands'
import { hookCapture } from './hook-capture'

const args = process.argv.slice(2)
const command = args[0]

async function main() {
  switch (command) {
    case 'init':
      if (!args[1]) {
        console.error('Usage: forge init "Project name"')
        process.exit(1)
      }
      init(args[1])
      break

    case 'turn':
      if (!args[1]) {
        console.error('Usage: forge turn "user turn text"')
        process.exit(1)
      }
      await turn(args[1])
      break

    case 'model':
      model()
      break

    case 'events':
      events()
      break

    case 'brief':
      brief()
      break

    case 'artifacts':
      artifacts()
      break

    case 'tensions':
      tensions()
      break

    case 'actions':
      await actions()
      break

    case 'execute':
      if (!args[1]) {
        console.error('Usage: forge execute <action-id>')
        console.error('Run: forge actions  — to see available actions')
        process.exit(1)
      }
      await execute(args[1])
      break

    case 'trust':
      trust()
      break

    case 'workspace':
      workspace()
      break

    case 'workspace:rebuild':
      workspaceRebuild()
      break

    case 'memory':
      if (!args[1]) {
        console.error('Usage: forge memory "query text"')
        console.error('Searches cross-project memory for relevant decisions, rejections, and explorations.')
        process.exit(1)
      }
      await memory(args[1])
      break

    case 'setup':
      setup()
      break

    case 'test':
      test()
      break

    case 'hook-capture': {
      // Read text from stdin for hook-driven capture (no stdout output)
      let stdinText = ''
      if (args[1]) {
        stdinText = args[1]
      } else {
        try {
          const { readFileSync } = await import('fs')
          stdinText = readFileSync(0, 'utf-8').trim()
        } catch { /* empty stdin */ }
      }
      if (stdinText) {
        await hookCapture(stdinText)
      }
      break
    }

    default:
      console.log('GZOO Forge — Persistent Project Intelligence')
      console.log('')
      console.log('Getting started:')
      console.log('  forge init "Project name"    Start a new project')
      console.log('  forge setup                  Add Forge instructions to CLAUDE.md (recommended)')
      console.log('')
      console.log('Commands:')
      console.log('  forge turn "user text"       Process a conversational turn')
      console.log('  forge model                  View current project model')
      console.log('  forge events                 View event log')
      console.log('  forge brief                  View session brief')
      console.log('  forge artifacts              View generated artifacts')
      console.log('  forge tensions               View constraint tensions')
      console.log('  forge actions                View proposed execution actions')
      console.log('  forge execute <id>           Approve and execute an action')
      console.log('  forge trust                  View trust calibration metrics')
      console.log('  forge workspace              View workspace values and risk profile')
      console.log('  forge workspace:rebuild      Rebuild values model and risk profile')
      console.log('  forge memory "query"         Search cross-project memory')
      console.log('  forge test                   Run behavioral contract tests')
      break
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
