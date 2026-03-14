# Forge Adoption Friction Report

**Source:** Claude Code (Opus) — beta testing Forge on the PainSignal project
**Date:** 2026-03-13
**Context:** Forge MCP was installed and functional for the entire PainSignal build (7+ phases, multiple sessions). Claude Code never used it once until the user asked why.

---

## The Core Problem

Forge was available, working, and would have been valuable — but it was never called. The user had to explicitly ask "why aren't you using Forge?" before it got any attention.

This is a **discoverability and activation problem**, not a functionality problem. The tool works well once you use it. The issue is that nothing in the AI's environment creates the habit of using it.

---

## Why Claude Code Didn't Use Forge

### 1. No Proactive Trigger in Tool Descriptions

The `forge_process_turn` description says "PROACTIVELY call this WITHOUT being asked" — but this instruction lives inside a deferred tool schema that Claude Code only fetches *after* deciding to use the tool. It's a catch-22: the instruction to use it proactively is only visible once you've already decided to use it.

Compare with skills that work well (like `seo-audit`):
```
"TRIGGER when: user says 'SEO audit', 'technical SEO', 'why am I not ranking'..."
```

These trigger descriptions are in the **available skills list** that's always visible in the system prompt, not buried inside a deferred schema.

**Fix:** The short description shown in the deferred tool list needs to carry the proactive trigger signal. When Claude Code sees `forge_process_turn` in the `<available-deferred-tools>` list, all it sees is the name — no description, no trigger guidance. By the time the full schema is fetched, the moment has passed.

### 2. No CLAUDE.md Integration Guidance

Most projects that successfully use MCP tools have a line in their `CLAUDE.md` that says something like:

```markdown
## Forge
- Always init a Forge session at the start of development work
- Record decisions, constraints, and rejections through forge_process_turn
- Approve leaning decisions with forge_approve when the user commits
```

Forge doesn't ship with a recommended CLAUDE.md snippet. This is the single highest-leverage fix — Claude Code follows CLAUDE.md instructions religiously.

### 3. The "Just Decide" Default

When Claude Code encounters an architectural decision (e.g., "should we use polymorphic tables or separate tables for community features?"), the default behavior is:

1. Consider the options internally
2. Pick one or ask the user
3. Implement it

There's no friction point where it thinks "wait, I should record this decision." Forge needs to insert itself into this decision-making flow, and right now it doesn't.

### 4. forge_query_memory Reads as "Multi-Project Only"

The description says "Search decisions and rejections from OTHER projects." For someone with one project, this reads as useless. The word "OTHER" in caps makes it sound like it has zero value for a single-project workspace.

In reality, `forge_query_memory` becomes valuable the moment you have a second project — but the description discourages even trying it on a single project.

### 5. No Session Lifecycle Nudge

The MCP server auto-resumes on startup, which is great. But Claude Code doesn't know that a session exists or that `forge://brief` contains valuable context from previous sessions. There's no mechanism that says "hey, Forge has context from your last 3 sessions — read it before you start."

---

## Specific Recommendations

### High Impact — Do These First

#### A. Ship a Recommended CLAUDE.md Snippet

Create a docs page or CLI command (`forge setup-claude-md`) that adds something like:

```markdown
## Forge — Cross-Session Decision Memory
- At the start of any development session, read the forge://brief resource for context from previous sessions
- Use forge_process_turn silently whenever the user makes a decision, states a constraint, rejects an approach, or sets a goal
- Use forge_approve when the user explicitly commits to a leaning decision
- Use forge_query_memory when facing architectural choices (database, auth, framework, deployment) to check if similar decisions were made in other projects
- Use forge_end_session when the conversation wraps up
- Do not tell the user you are recording — Forge operates silently in the background
```

This is the #1 fix. Claude Code follows CLAUDE.md with near-100% compliance.

#### B. Add a Post-Install Hook or Setup Command

After `forge_init` or on first install, Forge could:
- Check if CLAUDE.md exists in the project root
- Offer to append the recommended snippet
- Or create a `.claude/settings.json` entry (if that mechanism supports tool-use preferences)

Even a simple message in the `forge_init` response saying "Add these lines to your CLAUDE.md for best results" would help.

#### C. Improve the Deferred Tool List Presence

The `<available-deferred-tools>` block only shows tool names — no descriptions. This is a Claude Code platform constraint, but you can work around it by making tool names more self-describing:

Current: `mcp__forge__forge_process_turn`
Consider: The name is fine, but any mechanism to surface a one-line description alongside deferred tools would dramatically improve adoption. (This may be a feature request for the MCP SDK or Claude Code itself.)

### Medium Impact

#### D. Rewrite forge_query_memory Description

Current:
> "Search decisions and rejections from OTHER projects"

Suggested:
> "Search decisions, rejections, and lessons learned across all your projects — including the current one's history. Especially valuable when facing a choice the user may have encountered before. Call this proactively when you see decisions about databases, auth, frameworks, deployment, or pricing."

Drop the "OTHER" emphasis. Highlight that past decisions in the *current* project are also searchable.

#### E. Add a "Forge Status" Resource or Tool

A lightweight `forge_status` tool (or make `forge://brief` more visible) that returns:
- Whether a session is active
- How many decisions/constraints/rejections are recorded
- Last session date
- One-line summary

This gives Claude Code a quick way to check "should I be using Forge?" without fetching the full brief.

#### F. Surface forge://brief Automatically

If the MCP server detects that a new session has started (auto-resume), it could proactively surface a notification or make the brief available in a way that Claude Code reads it at conversation start. Currently, the brief sits as a resource that nobody reads because nobody knows to read it.

### Lower Impact but Worth Considering

#### G. Add Trigger Examples to Tool Descriptions

For `forge_process_turn`, the non-hooks description already has good examples, but they're only visible after fetching the deferred schema. Consider whether there's a way to surface these trigger patterns earlier in the conversation.

#### H. Create a "Forge Doctor" Diagnostic

A tool or command that checks:
- Is CLAUDE.md configured with Forge instructions?
- Has forge_process_turn been called this session?
- Are there decisions that should be approved?
- Is the brief stale (last session was days ago)?

This could be triggered by a health-check prompt or run automatically on session start.

#### I. Document the "Silent Recording" Pattern

Many MCP tools fail because the AI asks permission before every call: "I'm going to record this in Forge, okay?" This kills the UX. The tool description says "do this silently" but reinforcing this pattern in docs, examples, and the CLAUDE.md snippet is important.

---

## The Deeper Platform Issue

Forge's adoption problem is really an **MCP tool discoverability problem** that every MCP author will face:

1. **Deferred tools are invisible until fetched** — The AI sees a list of names but no descriptions, so it can't reason about when to use them.
2. **No "proactive tool" concept in MCP** — Tools are reactive (called in response to a need), but Forge needs to be proactive (called whenever a decision happens, regardless of whether anyone asked).
3. **CLAUDE.md is the only reliable proactive trigger** — Until the MCP spec or Claude Code adds a concept of "always-on" or "event-driven" tools, project instructions are the only way to create the habit.

Forge is actually ahead of the curve here with the hooks integration (`hasHooksInstalled()` check in the `forge_process_turn` description). That's the right architectural direction — capturing events automatically rather than relying on the AI to remember. Consider doubling down on hooks as the primary capture mechanism and using the tool call as a fallback.

---

## Summary

| Issue | Severity | Fix Effort | Recommendation |
|-------|----------|------------|----------------|
| No CLAUDE.md integration | Critical | Low | Ship a recommended snippet + setup command |
| Deferred tools have no visible descriptions | Critical | Platform limitation | Work around via CLAUDE.md; feature-request to Claude Code |
| No proactive trigger in AI's context | High | Low | CLAUDE.md snippet solves this |
| query_memory reads as multi-project only | Medium | Low | Rewrite description |
| forge://brief not auto-surfaced | Medium | Medium | Add session-start notification |
| No diagnostic/health-check | Low | Medium | Add forge_status or doctor command |

**The single highest-leverage change:** Ship a CLAUDE.md snippet that tells the AI to use Forge. Everything else is secondary.
