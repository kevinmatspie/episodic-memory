#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { ensureNativeDeps, reportUnavailable, repairBudgetMs, PLUGIN_ROOT } from './native-deps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

// EPISODIC_MEMORY_DEPS_READY lets a parent entry point that already ensured this exact
// tree spare this one a second probe. Help is not exempted: every path here ends in
// dist/search-cli.js, and a probe costs ~70ms against a repair that costs minutes.
const forwarded = process.argv.slice(2);

if (process.env.EPISODIC_MEMORY_DEPS_READY !== PLUGIN_ROOT) {
  // Wrapped like the guards in the other entry points: an unhandled rejection here would
  // surface as a raw ERR_UNHANDLED_REJECTION stack, which is the failure mode this guard
  // exists to replace.
  try {
    const outcome = await ensureNativeDeps({ waitMs: repairBudgetMs() });
    if (outcome !== 'ready') {
      reportUnavailable(outcome);
      process.exit(1);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
  process.env.EPISODIC_MEMORY_DEPS_READY = PLUGIN_ROOT;
}

const child = spawn(process.execPath, [join(__dirname, '../dist/search-cli.js'), ...forwarded], {
  stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code ?? 0));

// Without this, a missing dist/search-cli.js (unbuilt checkout, partial install) emits an
// unhandled 'error' and the user gets a raw spawn ENOENT stack — the failure mode this
// whole guard exists to replace. The sibling entry points already handle it.
child.on('error', (err) => {
  console.error(`ERROR: Failed to run search: ${err.message}`);
  process.exit(1);
});
