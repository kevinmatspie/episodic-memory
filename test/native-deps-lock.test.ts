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
import { spawn, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Exercises the repair lock in cli/native-deps.js, shared by the MCP wrapper and the CLIs.
 *
 * The module resolves its package root once at load, so each test gets a fresh temp root
 * (via EPISODIC_MEMORY_ROOT) and a freshly imported module.
 */
const WRAPPER_PATH = new URL('../cli/native-deps.js', import.meta.url).href;

// Claiming a lock installs exit/signal handlers on the *vitest* process. Each loadWrapper
// call is a distinct module instance with its own state, so without tracking them the
// handlers accumulate and a Ctrl-C during a run would exit through the wrapper's handler
// instead of vitest's teardown, leaking the temp directories these tests create.
const loadedWrappers: Array<{ unguardLockAgainstExit: () => void }> = [];

async function loadWrapper(pluginRoot: string) {
  process.env.EPISODIC_MEMORY_ROOT = pluginRoot;
  vi.resetModules();
  const module = await import(`${WRAPPER_PATH}?root=${encodeURIComponent(pluginRoot)}`);
  loadedWrappers.push(module.__testing);
  return module.__testing;
}

function unguardLoadedWrappers() {
  while (loadedWrappers.length) loadedWrappers.pop()?.unguardLockAgainstExit();
}

// A pid that is provably dead: spawn a real process, wait for it to exit, and reuse its
// pid. A hardcoded large number (999999) is above macOS's ceiling but perfectly reachable
// on a Linux host with a raised pid_max, where these tests would then flake.
function deadPid(): number {
  const finished = spawnSync(process.execPath, ['-e', '']);
  return finished.pid as number;
}

function ageLock(lockPath: string, millisecondsOld: number) {
  const when = new Date(Date.now() - millisecondsOld);
  utimesSync(lockPath, when, when);
}

describe('repair lock', () => {
  let root: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    originalRoot = process.env.EPISODIC_MEMORY_ROOT;
    root = mkdtempSync(join(tmpdir(), 'episodic-lock-'));
  });

  afterEach(() => {
    unguardLoadedWrappers();
    if (originalRoot === undefined) delete process.env.EPISODIC_MEMORY_ROOT;
    else process.env.EPISODIC_MEMORY_ROOT = originalRoot;
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

  it('treats a lock whose holder process is gone as abandoned, without waiting it out', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    // Owner token names a pid that has already exited, so the holder is provably dead even
    // though the lock is far too fresh to be stale by mtime.
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${deadPid()}-123456789`);

    expect(t.repairInFlight()).toBe(false);
    expect(t.stealStaleLock()).toBe(true);
  });

  it('refuses to steal from a dead holder whose npm is still writing node_modules', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${deadPid()}-123456789`); // holder killed

    // A holder killed with SIGKILL never runs its cleanup handlers, so the npm tree it
    // started keeps rewriting node_modules. Declaring the lock free on the holder's death
    // alone would hand a second npm to every waiter.
    const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore'
    });
    survivor.unref();
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), String(survivor.pid));

    try {
      expect(t.repairInFlight()).toBe(true);
      expect(t.stealStaleLock()).toBe(false);
    } finally {
      try {
        process.kill(-(survivor.pid as number), 'SIGKILL');
      } catch {
        survivor.kill('SIGKILL');
      }
    }
  });

  it('still refuses to steal once the lock has aged past the staleness window', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${deadPid()}-123456789`);

    const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore'
    });
    survivor.unref();
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), String(survivor.pid));

    // The age check must not short-circuit the npm check. A from-source better-sqlite3
    // build routinely outlives LOCK_STALE_MS, so consulting the npm record only for a
    // *fresh* lock would protect exactly the window the staleness timer already covered and
    // then abandon the tree at the point protection starts to matter.
    ageLock(t.LOCK_PATH, t.LOCK_STALE_MS * 3);

    try {
      expect(t.repairInFlight()).toBe(true);
      expect(t.stealStaleLock()).toBe(false);
    } finally {
      try {
        process.kill(-(survivor.pid as number), 'SIGKILL');
      } catch {
        survivor.kill('SIGKILL');
      }
    }
  });

  it('eventually ignores an npm record whose pid has been recycled', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${deadPid()}-123456789`);
    // A pid that is unquestionably alive but is not this lock's npm — what a recycled pid
    // looks like from the outside. processGone() reports "alive" for EPERM and for reuse,
    // so an unbounded veto would make this lock unstealable and repairInFlight() true
    // forever: every entry point would report "still being repaired" and the self-heal
    // could never converge. That is a worse failure than the concurrent npm it guards.
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), String(process.pid));

    ageLock(t.LOCK_PATH, t.LOCK_STALE_MS * 3);
    expect(t.repairInFlight()).toBe(true); // still honoured while plausible

    ageLock(t.LOCK_PATH, t.NPM_VETO_MAX_MS * 2);
    expect(t.repairInFlight()).toBe(false);
    expect(t.stealStaleLock()).toBe(true);
  });

  it('refuses to release the lock while its npm is still running', async () => {
    const t = await loadWrapper(root);
    await t.claimRepairLock();
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), '4242');

    // On the signal path npm gets only a short grace period, which a node-gyp compile can
    // outlast. Releasing then would delete the lock *and* the npm-pid record inside it,
    // leaving the next session nothing to consult before starting a second npm over a tree
    // the first one is still writing.
    t.setActiveNpmChildForTest({ pid: 4242 });
    t.releaseRepairLock();
    expect(existsSync(t.LOCK_PATH)).toBe(true);
    expect(existsSync(join(t.LOCK_PATH, 'npm-pid'))).toBe(true);

    // Once npm is gone, the release proceeds as normal.
    t.setActiveNpmChildForTest(null);
    t.releaseRepairLock();
    expect(existsSync(t.LOCK_PATH)).toBe(false);
  });

  it('does not let a dispossessed holder erase the new holder\'s npm record', async () => {
    const t = await loadWrapper(root);
    // Simulate the aftermath of a steal: the lock and its npm-pid belong to someone else.
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), 'the-new-holder');
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), '4242');

    // The old holder's npm exits and it runs its cleanup. It no longer owns the lock, so
    // the record must survive — erasing it would let a third process steal from a holder
    // whose npm is still writing the tree.
    t.clearRecordedNpmPid();

    expect(existsSync(join(t.LOCK_PATH, 'npm-pid'))).toBe(true);
  });

  it('allows the steal once that npm has exited too', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${deadPid()}-123456789`);
    writeFileSync(join(t.LOCK_PATH, 'npm-pid'), String(deadPid())); // also gone

    expect(t.repairInFlight()).toBe(false);
    expect(t.stealStaleLock()).toBe(true);
  });

  it('leaves a lock held by a live process alone', async () => {
    const t = await loadWrapper(root);
    mkdirSync(t.LOCK_PATH);
    // This test process is unquestionably alive.
    writeFileSync(join(t.LOCK_PATH, 'owner'), `${process.pid}-someone-else`);

    expect(t.repairInFlight()).toBe(true);
    expect(t.stealStaleLock()).toBe(false);
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

      // EPISODIC_MEMORY_ROOT, not CLAUDE_PLUGIN_ROOT: the module no longer reads the
      // latter, so without this the wrapper resolves its root through the symlink to the
      // real checkout — probing the developer's actual node_modules, starting the real MCP
      // server against the real database, and writing lock/log files into the working tree.
      const scratchRoot = join(dir, 'empty-root');
      mkdirSync(scratchRoot);

      // Targets native-deps.js in --repair-worker mode, which is where the entry-point
      // guard actually lives now. A misfire there is worse than the original bug: the
      // worker would exit 0 without repairing anything, and every waiting parent would
      // poll out its entire budget believing a repair was under way.
      const result = spawnSync(
        process.execPath,
        [join(link, 'cli', 'native-deps.js'), '--repair-worker', 'probe-failed'],
        {
          env: { ...process.env, EPISODIC_MEMORY_ROOT: scratchRoot, PATH: '/nonexistent' },
          encoding: 'utf8',
          timeout: 60_000
        }
      );

      // Any output at all proves the worker ran; the bug this guards against was a silent
      // exit 0 that produced nothing whatsoever.
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output.trim()).not.toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);

  it('starts the MCP wrapper when invoked through a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'episodic-symlink-wrapper-'));
    try {
      const repoRoot = fileURLToPath(new URL('..', import.meta.url));
      const link = join(dir, 'linked-repo');
      symlinkSync(repoRoot, link);

      const scratch = join(dir, 'empty-root');
      mkdirSync(scratch);

      // mcp-server-wrapper.js carries its own copy of the guard, and it is the only thing
      // between a symlinked ~/.claude (a dotfiles repo, say) and a wrapper that exits 0
      // having started neither a server nor a repair — silently, with no diagnostic at all.
      const result = spawnSync(
        process.execPath,
        [join(link, 'cli', 'mcp-server-wrapper.js')],
        {
          env: { ...process.env, EPISODIC_MEMORY_ROOT: scratch, PATH: '/nonexistent' },
          encoding: 'utf8',
          timeout: 60_000
        }
      );

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
