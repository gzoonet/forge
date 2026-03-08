# Contributing to GZOO Forge

Thanks for your interest in contributing to Forge.

## Getting Started

```bash
# Clone the repo
git clone git@github.com:gzoonet/forge.git
cd forge

# Install dependencies
npm install

# Build all packages
npx tsc -b

# Run all tests
npx vitest run
```

## Project Structure

Forge is a monorepo with npm workspaces. Packages build in dependency order:

```
packages/
  core/       → Types, IDs, provenance (zero dependencies)
  store/      → Event sourcing + SQLite (depends on core)
  extract/    → LLM pipeline: classify → extract (depends on core, store)
  execute/    → Execution hooks: GitHub integration (depends on core, store, extract)
  cli/        → CLI test surface (depends on core, store, extract, execute)
  mcp/        → MCP server for Claude Code (depends on core, store, extract)
```

## Development Workflow

### Building

```bash
# Build everything
npx tsc -b

# Build a specific package
npx tsc -b packages/mcp

# Watch mode (rebuild on changes)
npx tsc -b --watch
```

### Testing

```bash
# Run all tests
npx vitest run

# Run tests for one package
npx vitest run packages/extract

# Watch mode
npx vitest --watch
```

Tests require no external services. All LLM calls in tests are mocked.

### Environment Setup

Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
# Edit .env with your API key
```

You need an LLM API key to run the CLI or MCP server locally (but not for tests).

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **No default exports** — use named exports everywhere
- **Minimal dependencies** — think twice before adding a new package
- **Event sourcing** — the event log is the source of truth. The project model is a materialized view. Never mutate the model directly.

## Key Invariants

These are enforced by tests and must never be broken:

1. **`leaning → decided` is never automatic.** A decision moves to `decided` only through explicit user commitment (`forge_approve` or `explicit_commitment` trigger). Tests verify this.

2. **Events are append-only.** Never delete or modify events. Corrections are new events that supersede previous ones.

3. **The extraction pipeline is two-stage.** Stage 1 (classifier) determines the type. Stage 2 (extractor) pulls structured data. Both use LLM calls.

4. **Trust engine respects flow state.** When a user is in flow (3+ consecutive productive turns), only critical surfacings interrupt.

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `npx tsc -b` — must compile cleanly
4. Run `npx vitest run` — all tests must pass
5. Open a pull request against `main`

## Architecture Decisions

Major design decisions are documented in:

- [forge-project-model-v2.md](forge-project-model-v2.md) — Complete TypeScript schema
- [forge-behavioral-contract.md](forge-behavioral-contract.md) — 18 test scenarios

Read these before making architectural changes.

## Questions?

Open an issue on the [GitHub repo](https://github.com/gzoonet/forge/issues).
