#!/usr/bin/env node

import { init, turn, model, events, brief, test } from './commands'

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

    case 'test':
      test()
      break

    default:
      console.log('GZOO Forge — Phase 1 CLI')
      console.log('')
      console.log('Commands:')
      console.log('  forge init "Project name"    Start a new project')
      console.log('  forge turn "user text"       Process a conversational turn')
      console.log('  forge model                  View current project model')
      console.log('  forge events                 View event log')
      console.log('  forge brief                  View session brief')
      console.log('  forge test                   Run behavioral contract tests')
      break
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
