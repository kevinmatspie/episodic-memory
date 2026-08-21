#!/usr/bin/env node
/**
 * Cross-platform wrapper script for MCP server that ensures dependencies are installed
 * This runs before the MCP server starts and works on Windows, macOS, and Linux
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ensureNativeDeps, reportUnavailable, PLUGIN_ROOT } from './native-deps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (won't overwrite existing env vars)
try {
  const envPath = join(__dirname, '..', '.env');
  const envFile = readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // No .env file — that's fine
}

// The MCP client kills a server that misses its startup timeout (30s by default), so this
// budget stays well under it: time spent waiting is time the client counts against us, and
// a repair that outlasts it keeps running detached anyway. The headroom is deliberate —
// ensureNativeDeps can spend up to two probe timeouts past the deadline (a poll's own
// probe, then a confirming re-probe), and being killed mid-report would trade an
// explanatory failure for silence.
const STARTUP_REPAIR_BUDGET_MS = 15 * 1000;

async function main() {
  try {
    // A node_modules directory that merely *exists* proves nothing: a Node major upgrade
    // leaves better-sqlite3 compiled against the previous V8 ABI, and a partial install can
    // leave it with no compiled binary at all. Both fail lazily, deep inside the first
    // search, so verify up front rather than starting a server that is guaranteed to error.
    const deps = await ensureNativeDeps({ waitMs: STARTUP_REPAIR_BUDGET_MS });
    if (deps !== 'ready') {
      reportUnavailable(deps, {
        retryHint: 'Restart Claude Code once it finishes to use episodic-memory.'
      });
      process.exit(1);
    }

    // Start the MCP server
    const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');

    if (!existsSync(mcpServerPath)) {
      console.error(`ERROR: MCP server not found at ${mcpServerPath}`);
      console.error('Please run: npm run build');
      process.exit(1);
    }

    // Use spawn with shell: false for better cross-platform compatibility
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: 'inherit',
      shell: false
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

// Only act when run as a program. Importing this module — for a test, a tooling script, a
// dynamic import of some symbol — must never start an MCP server against the user's real
// database or kick off a detached npm in their working tree.
//
// Both sides are realpath'd because they are not otherwise comparable: Node's ESM loader
// resolves symlinks when building import.meta.url, while process.argv[1] keeps whatever
// path the caller typed, so a naive comparison makes any symlinked component (~/.claude in
// a dotfiles repo, /tmp on macOS) look like an import and silently do nothing at all.
function isThisScript(candidate) {
  try {
    return realpathSync(candidate) === realpathSync(__filename);
  } catch {
    return resolve(candidate) === resolve(__filename);
  }
}

const entryPath = process.argv[1];
const invokedDirectly = Boolean(entryPath) &&
  (isThisScript(entryPath) || basename(entryPath) === basename(__filename));

if (invokedDirectly) main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
