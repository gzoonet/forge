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

## Setup Checklist

Follow these steps to get Forge working in your project:

- [ ] **1. Install** — Add MCP config to `.mcp.json` (see [Install](#install) above)
- [ ] **2. API Key** — Set `ANTHROPIC_API_KEY` (or another provider) in `.env` or the MCP config's `env` block
- [ ] **3. .gitignore** — Add `.forge/` to your project's `.gitignore`
- [ ] **4. CLAUDE.md** — Copy the contents of `CLAUDE.md.forge-snippet` into your project's `CLAUDE.md` (optional but recommended)
- [ ] **5. Verify** — Start Claude Code and check that forge tools appear (see [Verifying It Works](#verifying-it-works))

---

## Project vs Global Config

You can configure Forge in two places:

| Location | Scope | Best for |
|----------|-------|----------|
| `.mcp.json` in project root | This project only | Team projects (commit to repo so everyone gets it) |
| `~/.claude/settings.json` | All projects | Personal use across all your projects |

**Project-level** (`.mcp.json`):
```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["@gzoo/forge-mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

**Global** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["@gzoo/forge-mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

If both exist, project-level takes precedence. Note: if you commit `.mcp.json` to your repo, **do not** include API keys — use environment variables or a `.env` file instead.

---

## Verifying It Works

After adding the MCP config, start Claude Code and look for these signs:

1. **Startup log** — In Claude Code's output, you should see the MCP server connect. Check for errors.
2. **Tools available** — Ask Claude Code: "What forge tools do you have?" It should list `forge_init`, `forge_process_turn`, `forge_approve`, `forge_end_session`, `forge_query_memory`.
3. **Resources available** — Ask Claude Code to read `forge://brief`. It should return either project state or "No active Forge project".
4. **Quick test** — Say: "Let's use TypeScript for this project." Claude Code should silently call `forge_process_turn` to record the decision.

---

## Troubleshooting

### Tools don't appear in Claude Code

- **Check `.mcp.json` syntax** — Must be valid JSON. Common mistake: trailing commas.
- **Restart Claude Code** — MCP servers connect at startup. After changing config, restart Claude Code completely.
- **Check npx resolves** — Run `npx @gzoo/forge-mcp --help` in your terminal. If it fails, the package isn't installed or your npm registry isn't configured.
- **Check Node version** — Requires Node 20+. Run `node --version` to verify.

### "No active project" errors

- This is normal on first use. The server waits for `forge_init` to be called.
- If you had a project before, check that `.forge/state.json` exists in your project root.
- If `state.json` exists but errors persist, the file may be corrupted — delete `.forge/` and re-init.

### LLM / extraction failures

- **Missing API key** — `forge_process_turn` requires an LLM. Check that `ANTHROPIC_API_KEY` (or your provider's key) is set.
- **Wrong provider** — If using OpenAI, set `FORGE_LLM_PROVIDER=openai`. Default is `anthropic`.
- **Rate limits** — If you see rate limit errors, wait a moment and try again. Forge makes 1-2 LLM calls per turn.
- **Resources still work** — Even without an LLM configured, `forge://brief` and `forge://model` will return data from previously recorded sessions.

### Permission errors on .forge/

- The `.forge/` directory is created in your project root. Ensure your user has write permissions there.
- If running in a container or CI, mount a writable volume at the project root.

### State seems corrupted

Delete the `.forge/` directory and start fresh:

```bash
rm -rf .forge/
# Next Claude Code session will prompt for forge_init
```

Your decisions will be lost, but you can re-record important ones in a new session.

---

## Upgrading

```bash
# Clear npx cache and use latest version
npx @gzoo/forge-mcp@latest
```

Or update the version in your `.mcp.json`:
```json
"args": ["@gzoo/forge-mcp@latest"]
```

State files (`.forge/forge.db`) are forward-compatible — upgrading the server won't lose your decisions.

---

## Privacy & Data

| Data | Where it goes |
|------|--------------|
| Conversation text | Sent to your configured LLM provider (Anthropic, OpenAI, etc.) for classification and extraction |
| Extracted decisions | Stored locally in `.forge/forge.db` (SQLite) |
| Project state | Stored locally in `.forge/state.json` |
| Source code | **Never sent anywhere** — Forge only processes conversation text |
| Telemetry | **None** — Forge does not phone home, collect analytics, or send data to GZOO servers |

Your decisions stay on your machine. The only external calls are to the LLM provider you configure.

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
