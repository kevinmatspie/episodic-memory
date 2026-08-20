import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  chmodSync,
  symlinkSync
} from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Exercises the repair lock in cli/mcp-server-wrapper.js.
 *
 * The wrapper resolves its plugin root from CLAUDE_PLUGIN_ROOT at module load, so each
 * test gets a fresh temp root and a freshly imported module.
 */
const WRAPPER_PATH = new URL('../cli/mcp-server-wrapper.js', import.meta.url).href;

// Claiming a lock installs exit/signal handlers on the *vitest* process. Each loadWrapper
// call is a distinct module instance with its own state, so without tracking them the
// handlers accumulate and a Ctrl-C during a run would exit through the wrapper's handler
// instead of vitest's teardown, leaking the temp directories these tests create.
const loadedWrappers: Array<{ unguardLockAgainstExit: () => void }> = [];

async function loadWrapper(pluginRoot: string) {
  process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  vi.resetModules();
  const module = await import(`${WRAPPER_PATH}?root=${encodeURIComponent(pluginRoot)}`);
  loadedWrappers.push(module.__testing);
  return module.__testing;
}

function unguardLoadedWrappers() {
  while (loadedWrappers.length) loadedWrappers.pop()?.unguardLockAgainstExit();
}

function ageLock(lockPath: string, millisecondsOld: number) {
  const when = new Date(Date.now() - millisecondsOld);
  utimesSync(lockPath, when, when);
}

describe('repair lock', () => {
  let root: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    originalRoot = process.env.CLAUDE_PLUGIN_ROOT;
    root = mkdtempSync(join(tmpdir(), 'episodic-lock-'));
  });

  afterEach(() => {
    unguardLoadedWrappers();
    if (originalRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = originalRoot;
    try {
      chmodSync(root, 0o755);
    } catch {
      // Already writable.
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('acquires the lock when none exists', async () => {
    const t = await loadWrapper(root);
    await expect(t.claimRepairLock()).resolves.toBe(t.LOCK_ACQUIRED);
    expect(t.ownsRepairLock()).toBe(true);
    expect(t.repairInFlight()).toBe(true);
  });

  it('reports a fresh lock held by another process as taken', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'someone-else');

    await expect(t.claimRepairLock()).resolves.toBe(t.LOCK_TAKEN);
    expect(t.ownsRepairLock()).toBe(false);
  });

  it('steals a lock whose holder stopped heartbeating, then acquires it', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'dead-process');
    ageLock(t.LOCK_PATH, t.LOCK_STALE_MS * 2);

    // A successful steal must not consume the claim: the same call goes on to acquire.
    await expect(t.claimRepairLock()).resolves.toBe(t.LOCK_ACQUIRED);
    expect(t.ownsRepairLock()).toBe(true);
  });

  it('refuses to steal a lock that is stale but not yet past the threshold', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'busy-process');
    ageLock(t.LOCK_PATH, t.LOCK_STALE_MS / 2);

    expect(t.stealStaleLock()).toBe(false);
    await expect(t.claimRepairLock()).resolves.toBe(t.LOCK_TAKEN);
  });

  it('never deletes a lock owned by another process', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'someone-else');

    t.releaseRepairLock();
    expect(existsSync(t.LOCK_PATH)).toBe(true);
  });

  it('releases a lock it owns', async () => {
    const t = await loadWrapper(root);
    await t.claimRepairLock();
    expect(existsSync(t.LOCK_PATH)).toBe(true);

    t.releaseRepairLock();
    expect(existsSync(t.LOCK_PATH)).toBe(false);
  });

  it('does not consider an abandoned lock an in-flight repair', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'dead-process');

    expect(t.repairInFlight()).toBe(true);
    ageLock(t.LOCK_PATH, t.LOCK_STALE_MS * 2);
    expect(t.repairInFlight()).toBe(false);
  });

  // root bypasses directory permission checks, and chmod on a Windows directory does not
  // prevent creation — in both cases the mkdir would succeed and the premise would be gone.
  const cannotDenyWrites = process.platform === 'win32' || process.getuid?.() === 0;

  it.skipIf(cannotDenyWrites)('reports an unlockable plugin root as unavailable rather than taken', async () => {
    const t = await loadWrapper(root);
    chmodSync(root, 0o500); // Readable and traversable, but not writable.

    // "Cannot lock" must be distinguishable from "someone else holds it": waiting helps
    // only in the second case.
    expect(t.tryCreateLock()).toBe(t.LOCK_UNAVAILABLE);
    await expect(t.claimRepairLock()).resolves.toBe(t.LOCK_UNAVAILABLE);
  });
});

describe('entry-point detection', () => {
  // Regression: comparing process.argv[1] to import.meta.url's path without realpath'ing
  // both makes any symlinked path component look like an import, and the wrapper exits 0
  // having started neither a server nor a repair — a silent, total no-op.
  // Creating a directory symlink on Windows needs Administrator or Developer Mode, so the
  // premise of this test cannot be set up there.
  it.skipIf(process.platform === 'win32')('runs when invoked through a symlinked path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'episodic-symlink-'));
    try {
      const repoRoot = fileURLToPath(new URL('..', import.meta.url));
      const link = join(dir, 'linked-repo');
      symlinkSync(repoRoot, link);

      // Point it at an empty plugin root so it exits quickly instead of starting a server;
      // any output at all proves the script actually ran.
      const pluginRoot = join(dir, 'empty-root');
      mkdirSync(pluginRoot);

      const result = spawnSync(process.execPath, [join(link, 'cli', 'mcp-server-wrapper.js')], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, PATH: '/nonexistent' },
        encoding: 'utf8',
        timeout: 60_000
      });

      // Any output at all proves the script ran; the bug this guards against was a silent
      // exit 0 that produced nothing whatsoever.
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output.trim()).not.toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});

describe('probe diagnostics', () => {
  it('prefers the probe’s tagged message over unrelated Node warnings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-probe-'));
    try {
      const t = await loadWrapper(root);
      const stderr = [
        '(node:123) ExperimentalWarning: something unrelated',
        `${t.PROBE_ERROR_PREFIX}the real dlopen failure`
      ].join('\n');

      expect(t.extractProbeReason(stderr)).toBe('the real dlopen failure');
    } finally {
      unguardLoadedWrappers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the last non-blank line when nothing is tagged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-probe-'));
    try {
      const t = await loadWrapper(root);
      expect(t.extractProbeReason('first line\nlast line\n\n')).toBe('last line');
      expect(t.extractProbeReason('   \n')).toBe('unknown error');
    } finally {
      unguardLoadedWrappers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
