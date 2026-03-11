import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ForgeServer } from './server'
import { formatBriefAsMarkdown } from './serialization'

/**
 * Register MCP prompts that teach Claude Code how to use Forge.
 */
export function registerPrompts(mcp: McpServer, forge: ForgeServer): void {

  // ── forge-workflow ──────────────────────────────────────────────────────

  mcp.registerPrompt(
    'forge-workflow',
    {
      title: 'Forge Workflow Guide',
      description: 'Instructions for how to use Forge tools during a conversation. Read this at session start to understand the workflow.',
    },
    () => {
      const briefContent = forge.isInitialized()
        ? formatBriefAsMarkdown(forge.getBrief())
        : 'No active project. Call forge_init with a project name to start tracking.'

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              '# Forge — Cross-Session Project Memory',
              '',
              'You have access to Forge, a persistent project memory that tracks decisions, constraints, rejections, and explorations across EVERY session.',
              '',
              '## Forge vs Plan Mode',
              '- **Plan mode** = single-session task breakdown. Good for "plan how to implement feature X." Resets when the session ends.',
              '- **Forge** = cross-session project memory. Remembers what was decided, rejected, and explored forever. Good for "what did we decide about auth last week?"',
              '- They complement each other. Use Plan mode for within-session task planning. Forge runs in the background, capturing decisions as they happen.',
              '- When you read forge://brief at session start, you get full context from ALL previous sessions — no need to re-ask questions or re-explore options.',
              '',
              '## How to use Forge during this conversation:',
              '',
              '1. **At session start**: Read the forge://brief resource to understand what has been decided in previous sessions. This is your project memory.',
              '',
              '2. **During conversation**: PROACTIVELY call `forge_process_turn` whenever the user says something significant:',
              '   - Decisions: "Let\'s use React" / "We\'ll go with PostgreSQL"',
              '   - Constraints: "Must ship by March" / "Budget is under $5k/month"',
              '   - Rejections: "No PHP" / "We tried Firebase, it didn\'t work"',
              '   - Goals: "We\'re building an analytics dashboard for SMBs"',
              '   - Explorations: "Maybe we could try..." / "What about using..."',
              '   - Corrections: "No, I said Postgres not MySQL"',
              '   - Do NOT call for greetings, trivial chat, or pure questions',
              '   - Pass the user\'s actual words. Do this SILENTLY — don\'t mention Forge to the user.',
              '',
              '3. **When user commits**: If the user explicitly commits to a decision they were leaning toward, call `forge_approve` with a phrase from the decision.',
              '',
              '4. **Cross-project memory**: When the user is making a decision (choosing tech, approach, etc.), call `forge_query_memory` to check if similar decisions were made in other projects.',
              '',
              '5. **Surface insights naturally**: If forge_process_turn returns surfacing messages or memory matches, weave them into your response naturally. Example: "By the way, in your previous project you rejected Firebase for this same reason."',
              '',
              '6. **Never mention Forge directly** unless the user asks about it. The tracking should be invisible.',
              '',
              '## Current project state:',
              '',
              briefContent,
            ].join('\n'),
          },
        }],
      }
    }
  )
}
