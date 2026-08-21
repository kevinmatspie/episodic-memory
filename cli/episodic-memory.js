#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { realpathSync, readFileSync } from 'fs';
import {
  ensureNativeDeps,
  reportUnavailable,
  canResolveDependency,
  isInteractiveRun,
  repairBudgetMs,
  PLUGIN_ROOT
} from './native-deps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

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

const command = process.argv[2];
const args = process.argv.slice(3);

async function runScript(scriptPath, args) {
  // Guarded here rather than in main() so that a bare --help, answered by showHelp above,
  // never reaches this path. Subcommand help (`search --help`) is deliberately NOT exempt:
  // an exemption only saves a probe on a healthy tree, and the ways it can be wrong — an
  // empty node_modules where nothing resolves, a child that ignores --help and opens the
  // database anyway — all end in a raw stack trace instead of a repair.
  await requireNativeDeps(args);
  return runUnguarded(scriptPath, args);
}

function runUnguarded(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // Exit with the child's code rather than rejecting: the child has already explained
      // itself (often with remediation advice from its own dependency guard), and main's
      // catch would append an unrelated-looking "Command failed with exit code 1" on top.
      process.exit(code ?? 1);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

// How long to wait is decided by whether anyone is watching, not by a flag (repairBudgetMs
// in native-deps.js). The repo's own cron recipe (scripts/sync-machines.example.sh) runs
// `sync --no-summary-limit` with no --background at all, and would otherwise block a */15
// slot for ten minutes after a Node upgrade. The repair is detached and continues
// regardless, so the next run picks it up.
//
// Whether to say anything is a separate question, and a stricter one: silence is only for
// runs that explicitly asked to be in the background *and* have nowhere to print. A person
// redirecting output to a file still wants to find out why the command failed.
function isBackgroundRun(args) {
  // Gated on the subcommand as well as the flag: only `sync` understands --background, so
  // matching it anywhere would let `episodic-memory search -- --background` swallow the
  // failure message entirely.
  return command === 'sync' && args.includes('--background');
}

function isUnattendedRun(args) {
  return isBackgroundRun(args) && !isInteractiveRun();
}

async function requireNativeDeps(args = []) {
  // Set by an ancestor that already ensured *this* tree — not by `index`, which is spawned
  // unguarded so its --rebuild prompt comes first. The case it exists for is summarization
  // spawning `claude`, whose SessionStart hook runs the *plugin* copy's CLI with this
  // environment inherited: it carries the root rather than a bare flag precisely so that a
  // different tree is not waved through as already verified.
  if (process.env.EPISODIC_MEMORY_DEPS_READY === PLUGIN_ROOT) return;

  // Two separate questions: a background run never waits long (nobody is there to wait,
  // whatever stderr happens to be attached to), but it only goes silent when it also has
  // nowhere to print.
  const background = isBackgroundRun(args);
  const unattended = isUnattendedRun(args);
  const outcome = await ensureNativeDeps({
    waitMs: repairBudgetMs({ unattended: background }),
    quiet: unattended
  });
  if (outcome !== 'ready') {
    if (!unattended) reportUnavailable(outcome);
    process.exit(1);
  }
  process.env.EPISODIC_MEMORY_DEPS_READY = PLUGIN_ROOT;
}

function showHelp() {
  console.log(`episodic-memory - Manage and search Claude Code conversations

USAGE:
  episodic-memory <command> [options]

COMMANDS:
  sync        Sync conversations from ~/.claude/projects and index them
  index       Index conversations for search
  search      Search indexed conversations
  show        Display a conversation in readable format
  stats       Show index statistics

Run 'episodic-memory <command> --help' for command-specific help.

EXAMPLES:
  # Index all conversations
  episodic-memory index --cleanup

  # Search for something
  episodic-memory search "React Router auth"

  # Display a conversation
  episodic-memory show path/to/conversation.jsonl

  # Generate HTML output
  episodic-memory show --format html conversation.jsonl > output.html`);
}

async function main() {
  try {
    const distDir = join(__dirname, '../dist');

    switch (command) {
      case 'index':
        // Deliberately not guarded here: index-conversations.js guards after its --rebuild
        // confirmation prompt, and repairing before asking "are you sure?" would make the
        // user sit through an npm rebuild they may be about to decline.
        await runUnguarded(join(__dirname, 'index-conversations.js'), args);
        break;

      case 'search':
        await runScript(join(distDir, 'search-cli.js'), args);
        break;

      case 'show':
        // show never opens the database — it reads a .jsonl and formats it — so on a tree
        // that is merely ABI-broken it works, and guarding it would turn a working command
        // into a failing one (in any non-TTY context the short budget returns 'in-progress'
        // and it exits having rendered nothing). But it does import `marked`, so on a tree
        // that cannot resolve, running it unguarded means a raw ERR_MODULE_NOT_FOUND.
        //
        // Asking whether `marked` actually resolves settles both: it is the exact question,
        // where existsSync('node_modules') was a heuristic an empty directory defeated.
        if (canResolveDependency('marked')) {
          await runUnguarded(join(distDir, 'show-cli.js'), args);
        } else {
          await runScript(join(distDir, 'show-cli.js'), args);
        }
        break;

      case 'stats':
        await runScript(join(distDir, 'stats-cli.js'), args);
        break;

      case 'sync':
        await runScript(join(distDir, 'sync-cli.js'), args);
        break;

      case '--help':
      case '-h':
      case undefined:
        showHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Try: episodic-memory --help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
