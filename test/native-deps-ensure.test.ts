import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  realpathSync
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Covers the contract every entry point relies on: a command that opens the database
 * repairs broken native dependencies first, and a command that does not open the database
 * never pays for a repair.
 *
 * These drive the real CLI scripts as subprocesses against a scratch package root, so they
 * exercise the wiring (import, guard placement) rather than the module in isolation.
 */
// Must match native-deps.js's PLUGIN_ROOT exactly, or the EPISODIC_MEMORY_DEPS_READY
// short-circuit below silently fails to disarm the guard — and on a machine whose deps are
// actually broken those tests would spawn a real npm install into the working tree.
// realpathSync for symlinked checkouts (PLUGIN_ROOT is realpath'd), resolve() for the
// trailing separator fileURLToPath leaves on a directory URL.
const REPO_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));

function scratchRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'episodic-ensure-'));
  const root = join(dir, 'pkg');
  mkdirSync(join(root, 'cli'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const f of ['native-deps.js', 'episodic-memory.js', 'index-conversations.js', 'search-conversations.js']) {
    cpSync(join(REPO_ROOT, 'cli', f), join(root, 'cli', f));
  }
  // A real dist/, so the help assertions below prove help was printed rather than passing
  // on a "Cannot find module" crash — which would look identical to the guard working.
  // The package.json is required too: without "type": "module" Node refuses the ESM dist.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scratch', type: 'module' }));
  cpSync(join(REPO_ROOT, 'dist'), join(root, 'dist'), { recursive: true });
  return { dir, root };
}

// Point the CLI at a root whose node_modules exists but is empty, and make npm a no-op that
// fails — so a repair is attempted and cannot succeed, without touching the network.
function runCli(root: string, script: string, args: string[], fakeBinDir: string) {
  return spawnSync(process.execPath, [join(root, 'cli', script), ...args], {
    env: {
      ...process.env,
      EPISODIC_MEMORY_ROOT: root,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`
    },
    encoding: 'utf8',
    timeout: 120_000
  });
}

function failingNpm(dir: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\necho "npm unavailable in test" >&2\nexit 1\n', { mode: 0o755 });
  return bin;
}

describe.skipIf(process.platform === 'win32')('ensureNativeDeps wiring', () => {
  it('repairs before running a command that opens the database', () => {
    const { dir, root } = scratchRoot();
    try {
      const result = runCli(root, 'search-conversations.js', ['anything'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      // It must notice the tree is unusable and attempt a repair rather than crashing deep
      // inside better-sqlite3, and must not pretend success when the repair fails.
      expect(output).toMatch(/native dependencies are unusable|not installed yet/);
      expect(output).toMatch(/could not repair its native dependencies/);
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('does not attempt a repair for --help', () => {
    const { dir, root } = scratchRoot();
    try {
      const result = runCli(root, 'episodic-memory.js', ['--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toContain('episodic-memory - Manage and search');
      expect(output).not.toMatch(/repairing|unusable/);
      expect(existsSync(join(root, '.episodic-memory-repair.log'))).toBe(false);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('guards subcommand help rather than letting it crash on an unusable tree', () => {
    const { dir, root } = scratchRoot();
    try {
      // Subcommand help is not exempt from the guard. Exempting it would save one ~70ms
      // probe on a healthy tree, and would hand the user a raw ERR_MODULE_NOT_FOUND on a
      // tree where nothing resolves.
      const result = runCli(root, 'episodic-memory.js', ['search', '--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toMatch(/not installed yet|could not repair/);
      expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('guards show only when its own dependency cannot resolve', () => {
    const { dir, root } = scratchRoot();
    try {
      // show never opens the database, so on a merely ABI-broken tree it works and must not
      // be gated — guarding it unconditionally turns a working command into one that exits
      // 1 having rendered nothing, in every non-TTY context. Here `marked` is absent, which
      // is the case that does need the guard.
      const result = runCli(root, 'episodic-memory.js', ['show', '--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toMatch(/not installed yet|could not repair|unusable/);
      expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('runs show unguarded when only the database dependency is broken', () => {
    const { dir, root } = scratchRoot();
    try {
      // The regression this guards against: guarding show unconditionally turned a command
      // that worked on an ABI-broken tree into one that exits 1 having rendered nothing, in
      // every non-TTY context. Giving the scratch root a resolvable `marked` — and still no
      // better-sqlite3 — is exactly that situation.
      symlinkSync(
        join(REPO_ROOT, 'node_modules', 'marked'),
        join(root, 'node_modules', 'marked')
      );

      const result = runCli(root, 'episodic-memory.js', ['show', '--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toContain('Usage: episodic-memory show');
      expect(output).not.toMatch(/repairing|unusable/);
      expect(existsSync(join(root, '.episodic-memory-repair.log'))).toBe(false);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('still guards a command that ignores a trailing --help', () => {
    const { dir, root } = scratchRoot();
    try {
      // dist/index-cli.js ignores --help after a subcommand and opens the database anyway,
      // so `--verify --help` must NOT be treated as a help request.
      const result = runCli(root, 'index-conversations.js', ['--verify', '--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toMatch(/native dependencies are unusable|not installed yet/);
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  it('does not attempt a repair for index --help', () => {
    const { dir, root } = scratchRoot();
    try {
      const result = runCli(root, 'index-conversations.js', ['--help'], failingNpm(dir));
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toContain('index-conversations - Index and manage');
      expect(output).not.toMatch(/repairing|unusable/);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);
});

describe('help and non-database commands against a healthy tree', () => {
  // These run in the real checkout, where the dependencies resolve. That is what makes the
  // assertions meaningful: in a scratch root with no node_modules, a crash and a correctly
  // printed help message are indistinguishable from the outside.
  function runHere(script: string, args: string[]) {
    return spawnSync(process.execPath, [join(REPO_ROOT, 'cli', script), ...args], {
      // Short-circuit the guard. These tests assert help output, not repair behaviour, and
      // on a machine whose deps are actually broken — a Node major upgrade, the very case
      // this feature targets — an armed guard would spawn a real detached npm install into
      // the working tree and hang the suite until it timed out.
      env: { ...process.env, EPISODIC_MEMORY_DEPS_READY: REPO_ROOT },
      encoding: 'utf8',
      timeout: 120_000
    });
  }

  it('prints subcommand help', () => {
    const result = runHere('episodic-memory.js', ['search', '--help']);
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: episodic-memory search');
    expect(result.status).toBe(0);
  }, 130_000);

  it('prints show help', () => {
    const result = runHere('episodic-memory.js', ['show', '--help']);
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: episodic-memory show');
    expect(result.status).toBe(0);
  }, 130_000);
});
