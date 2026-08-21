#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { createInterface } from 'readline';
import {
  ensureNativeDeps,
  reportUnavailable,
  isInteractiveRun,
  repairBudgetMs,
  PLUGIN_ROOT
} from './native-deps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

async function runScript(command, args) {
  // Guarded here rather than in main() so that --help (answered by showHelp above) and the
  // --rebuild confirmation prompt are both reached without triggering a repair; only work
  // that actually opens the database does.
  await requireNativeDeps();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '../dist/index-cli.js'), command, ...args], {
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

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

// `--session` is the automated path this tool documents for a sessionEnd hook, so it never
// waits long: nothing is served by stalling session teardown when the repair is detached
// and continues regardless. Going *silent* is a stricter condition — it additionally
// requires stderr not to be a terminal — so a person running --session by hand still waits
// only briefly but does see why it failed.
let hookInvocation = false;

// No help check here, unlike episodic-memory.js: main() handles --help before runScript is
// ever reached, and dist/index-cli.js ignores a trailing --help and opens the database
// anyway (`index-conversations --verify --help` really does run verify).
async function requireNativeDeps() {
  // Set by an ancestor that already ensured *this* tree — not by `episodic-memory index`,
  // which spawns this file unguarded so the --rebuild prompt comes first. The case it
  // exists for is summarization spawning `claude`, whose SessionStart hook runs a CLI again
  // inside this process tree; it carries the root rather than a bare flag so that a
  // different tree is never waved through as already verified.
  if (process.env.EPISODIC_MEMORY_DEPS_READY === PLUGIN_ROOT) return;

  const unattended = hookInvocation && !isInteractiveRun();
  const outcome = await ensureNativeDeps({
    waitMs: repairBudgetMs({ unattended: hookInvocation }),
    quiet: unattended
  });
  if (outcome !== 'ready') {
    if (!unattended) reportUnavailable(outcome);
    process.exit(1);
  }
  process.env.EPISODIC_MEMORY_DEPS_READY = PLUGIN_ROOT;
}

function showHelp() {
  console.log(`index-conversations - Index and manage conversation archives

USAGE:
  index-conversations [COMMAND] [OPTIONS]

COMMANDS:
  (default)      Index all conversations
  --cleanup      Process only unindexed conversations (fast, cheap)
  --session ID   Index specific session (used by hook)
  --verify       Check index health
  --repair       Fix detected issues
  --rebuild      Delete DB and re-index everything (requires confirmation)

OPTIONS:
  --concurrency N    Parallel summarization (1-16, default: 1)
  -c N               Short form of --concurrency
  --no-summaries     Skip AI summary generation (free, but no summaries in results)
  --verbose          Show per-conversation progress during embedding
  --help, -h         Show this help

EXAMPLES:
  # Index all unprocessed (recommended for backfill)
  index-conversations --cleanup

  # Index with 8 parallel summarizations (8x faster)
  index-conversations --cleanup --concurrency 8

  # Index without AI summaries (free, fast)
  index-conversations --cleanup --no-summaries

  # Check index health
  index-conversations --verify

  # Fix any issues found
  index-conversations --repair

  # Nuclear option (deletes everything, re-indexes)
  index-conversations --rebuild

WORKFLOW:
  1. Initial setup: index-conversations --cleanup
  2. Ongoing: Auto-indexed by sessionEnd hook
  3. Health check: index-conversations --verify (weekly)
  4. Recovery: index-conversations --repair (if issues found)

SEE ALSO:
  INDEXING.md - Setup and maintenance guide
  DEPLOYMENT.md - Production runbook`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  hookInvocation = command === '--session';

  try {
    switch (command) {
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;

      case undefined:
        await runScript('index-all', args);
        break;

      case '--session':
        await runScript('index-session', args);
        break;

      case '--cleanup':
        await runScript('index-cleanup', args);
        break;

      case '--verify':
        await runScript('verify', args);
        break;

      case '--repair':
        await runScript('repair', args);
        break;

      case '--rebuild':
        console.log('⚠️  This will DELETE the entire database and re-index everything.');
        const confirmed = await askConfirmation('Are you sure? [yes/NO]: ');
        if (confirmed) {
          await runScript('rebuild', args);
        } else {
          console.log('Cancelled');
        }
        break;

      default:
        await runScript('index-all', [command, ...args]);
        break;
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
