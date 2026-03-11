#!/usr/bin/env node
/**
 * Forge Auto-Capture Hook — UserPromptSubmit handler
 *
 * Fires when the user submits a prompt to Claude Code. Extracts the user's
 * message and spawns `forge hook-capture` as a detached background process
 * to run it through the extraction pipeline.
 *
 * Rules:
 * - NEVER block the user's prompt (always exit 0 immediately)
 * - NEVER print to stdout (would interfere with Claude Code)
 * - Skip empty messages
 * - Only run if .forge/state.json exists (Forge initialized)
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function main() {
  try {
    // Read hook input from stdin
    let input = '';
    try {
      input = readFileSync(0, 'utf-8');
    } catch {
      process.exit(0);
    }

    let data;
    try {
      data = JSON.parse(input);
    } catch {
      process.exit(0);
    }

    // Extract user message text
    const message = data.prompt || data.message || data.content || data.text || '';
    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      process.exit(0);
    }

    // Check if Forge is initialized in the project directory
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const stateFile = join(projectDir, '.forge', 'state.json');
    if (!existsSync(stateFile)) {
      process.exit(0);
    }

    // Find the forge CLI
    // Try common locations: global binary, local node_modules, or the repo path
    const forgePaths = [
      'forge',  // global/PATH
      join(projectDir, 'node_modules', '.bin', 'forge'),
      join(projectDir, 'packages', 'cli', 'dist', 'index.js'),
    ];

    let forgeBin = 'forge';
    let forgeArgs = ['hook-capture', message.trim()];

    // Check for the local repo path first (most reliable for dev)
    const localCli = join(projectDir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(localCli)) {
      forgeBin = 'node';
      forgeArgs = [localCli, 'hook-capture', message.trim()];
    }

    // Spawn in background (detached, no stdio)
    const child = spawn(forgeBin, forgeArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: projectDir,
      env: { ...process.env },
    });
    child.unref();

  } catch {
    // Never fail — silently exit
  }

  process.exit(0);
}

main();
