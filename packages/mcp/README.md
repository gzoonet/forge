# @gzoo/forge-mcp

MCP server that gives Claude Code persistent project memory. Decisions, constraints, rejections, and tensions survive across sessions.

**The pitch:** Install this MCP server. Now Claude Code remembers everything.

---

## Install

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["@gzoo/forge-mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Or add to `~/.claude/settings.json` under `mcpServers` for global access.

For local development, use the built version instead:

```json
{
  "mcpServers": {
    "forge": {
      "command": "node",
      "args": ["/path/to/forge/packages/mcp/dist/index.js"]
    }
  }
}
```

**3. Start Claude Code.** The forge tools and resources appear automatically.

---

## How It Works

```
Claude Code starts
  → MCP server starts via stdio
  → Checks for .forge/state.json in cwd
    Found?  → Opens existing project, starts new session, brief is ready
    Missing → Waits for forge_init tool call
  → Claude Code reads forge://brief → has full project context
  → User talks naturally
  → Claude Code calls forge_process_turn for significant statements
  → Model updates, brief refreshes
  → Claude Code exits → SIGTERM → session ends gracefully
```

Each Claude Code session = one Forge session. State persists in `.forge/forge.db` (SQLite).

---

## Resources

Read-only context that Claude Code can pull in.

| URI | Format | Description |
|-----|--------|-------------|
| `forge://brief` | Markdown | Session brief — goal, locked/decided/pending decisions, tensions, changes since last session. **Read this at session start.** |
| `forge://model` | JSON | Full project model — all decisions, constraints, rejections, explorations, tensions, artifacts. |
| `forge://tensions` | JSON | Active and acknowledged constraint conflicts with node details. |

The brief is the primary memory injection. It renders as readable markdown:

```markdown
# Project: Acme SaaS

## Goal
Build an analytics dashboard for SMBs

## Locked Decisions
- **Use TypeScript** [technical]

## Decided
- Stripe for payments [business]

## Pending Explorations
- Auth approach
  - Auth0 vs Clerk?

## Active Tensions
- [significant] 4-week timeline conflicts with custom auth
```

---

## Tools

5 tools. All write operations go through tools. Read operations use resources.

### forge_init

Initialize a new Forge project.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectName` | string | Name of the project |

Call once at the start of a new project. If `.forge/state.json` already exists, the server auto-resumes and this isn't needed.

### forge_process_turn

Record a significant conversational turn through the extraction pipeline.

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | string | The conversational turn text |
| `speaker` | `"user"` \| `"system"` | Who said this (default: `"user"`) |

**When to call:** User expresses a decision, states a constraint, rejects an approach, explores options, sets a goal, corrects a previous understanding, or approves a proposal.

**When NOT to call:** Greetings, trivial messages, questions that don't change the project model.

Returns: classification, model updates, promotion suggestions, memory matches, trust-calibrated surfacings.

### forge_approve

Promote a leaning decision to decided.

| Parameter | Type | Description |
|-----------|------|-------------|
| `decisionHint` | string | A phrase identifying which leaning decision to approve (fuzzy matched) |

This is the **only** way a decision moves from `leaning` to `decided`. It is never automatic. The hint is matched against leaning decisions using word overlap (Jaccard similarity).

### forge_end_session

End the current Forge session.

| Parameter | Type | Description |
|-----------|------|-------------|
| `reason` | `"explicit_close"` \| `"time_gap"` | Why the session ended (default: `"explicit_close"`) |

Call when the conversation wraps up. Also triggered automatically on SIGTERM when Claude Code exits.

### forge_query_memory

Search for relevant decisions, rejections, and explorations from other projects.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Describe the decision or topic to search for |

Searches across all projects in the workspace. Uses keyword matching with synonym expansion. Rejections get a relevance bonus (they're high-value signals about what was tried and rejected).

---

## Configuration

The server loads `.env` from the working directory via dotenv.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `FORGE_LLM_PROVIDER` | No | `anthropic`, `openai`, or `openai-compatible` (default: `anthropic`) |
| `OPENAI_API_KEY` | Yes* | OpenAI or compatible API key |
| `OPENAI_BASE_URL` | No | Base URL for OpenAI-compatible providers |
| `FORGE_FAST_MODEL` | No | Override the classifier model |
| `FORGE_QUALITY_MODEL` | No | Override the extractor model |

*One of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is required for the extraction pipeline. Resources still work without an LLM configured.

---

## Example Session

**First session** (no `.forge/state.json` exists):

```
Claude Code: [calls forge_init with "My SaaS App"]
Claude Code: [reads forge://brief → empty project]

User: "We're building a scheduling tool for freelancers"
Claude Code: [calls forge_process_turn → goal extracted]

User: "Definitely React and TypeScript on the frontend"
Claude Code: [calls forge_process_turn → decision extracted at 'leaning']

User: "Yeah, let's commit to React + TypeScript"
Claude Code: [calls forge_approve → decision promoted to 'decided']

User: "No WordPress. Not now, not ever."
Claude Code: [calls forge_process_turn → rejection extracted]
```

**Next session** (`.forge/state.json` exists):

```
Claude Code starts → MCP server resumes project automatically
Claude Code: [reads forge://brief]

  # Project: My SaaS App
  ## Goal
  Build a scheduling tool for freelancers
  ## Decided
  - React and TypeScript on the frontend [technical]
  ## Rejections
  - No WordPress (categorical)

Claude Code now has full context without the user repeating anything.
```

---

## Data Storage

- **State file:** `.forge/state.json` — current project/session IDs
- **Database:** `.forge/forge.db` — SQLite, event-sourced
- **Events are append-only** — the model is a materialized view of the event log

Add `.forge/` to your `.gitignore`. It's local state, not for version control.

---

## Development

```bash
# Build
npx tsc -b packages/mcp

# Run tests
npx vitest run packages/mcp

# Manual test (stdio)
node packages/mcp/dist/index.js
# Server listens on stdin/stdout for JSON-RPC
```
