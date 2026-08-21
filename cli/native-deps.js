#!/usr/bin/env node
/**
 * Keeps this package's native dependencies loadable, and repairs them when they are not.
 *
 * better-sqlite3 compiles against the V8 ABI rather than N-API, so every Node major
 * upgrade leaves it unloadable; a partial install can leave it with no compiled binary at
 * all. Either way the failure surfaces lazily, deep inside the first query, which is a
 * miserable place to discover it. Every entry point that will end up opening the database
 * calls ensureNativeDeps() first.
 *
 * Shared by the MCP server wrapper and the CLI entry points. Run directly with
 * --repair-worker it *is* the detached repair worker (see spawnDetachedRepair).
 */

import { spawn } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'fs';
import { createRequire } from 'module';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The package this module lives in — always the tree whose node_modules will be loaded.
// Deliberately not CLAUDE_PLUGIN_ROOT: when a repo checkout's CLI is run from inside a
// Claude Code session that variable points at the *plugin* copy, and we would repair the
// wrong node_modules. EPISODIC_MEMORY_ROOT exists so tests can target a scratch tree; it
// must be a real environment variable, because ESM hoists this module ahead of any
// caller's .env loader.
const PLUGIN_ROOT = process.env.EPISODIC_MEMORY_ROOT || dirname(realpathSync(__dirname));

// Runs an npm subcommand against PLUGIN_ROOT. Resolves on exit 0, rejects otherwise.
// npm output goes to stderr, never stdout: for the MCP server that stream is the JSON-RPC
// transport, and for the CLIs stdout is the command's actual result.
// Tracks the npm process currently rewriting node_modules. Holding a handle on it means
// it can be stopped if this wrapper is signalled or loses its lock, rather than being left
// running unsupervised.
let activeNpmChild = null;

function killActiveNpm(signal) {
  const child = activeNpmChild;
  if (!child || !child.pid) return;
  // On Windows the tracked child is the cmd.exe shell npm runs under, so killing it would
  // orphan npm and its node-gyp children — still writing node_modules after we release the
  // lock. taskkill /T takes down the whole tree.
  const killDirectly = () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      // spawn failures arrive as an event, not a throw. Without this listener a missing or
      // policy-blocked taskkill would become an uncaught exception — killing this process
      // before it could release the lock, which is the opposite of the intent. A non-zero
      // exit (access denied, pid already gone) needs the same fallback: taskkill spawning
      // successfully is not the same as it having killed anything.
      killer.on('error', killDirectly);
      killer.on('close', (code) => { if (code !== 0) killDirectly(); });
      return;
    } catch {
      killDirectly();
      return;
    }
  }

  // Signal the whole process group, not just npm. npm's real work happens in descendants
  // (node-gyp, make, cc), and killing only the npm CLI would leave those still writing
  // node_modules after the lock is released — the concurrent-write corruption the lock
  // exists to prevent. runNpm makes the child a group leader so that -pid addresses it.
  try {
    process.kill(-child.pid, signal);
  } catch {
    killDirectly(); // No process group (or already gone); fall back to the child itself.
  }
}

// Test seam: the release invariant depends on whether an npm child is still tracked, and
// that is otherwise only reachable by actually running npm.
function setActiveNpmChildForTest(child) {
  activeNpmChild = child;
}

function clearRecordedNpmPid() {
  // Gated on ownership exactly like the write. A holder whose lock was stolen mid-repair
  // still runs this when its npm exits, and without the check it would erase the *new*
  // holder's record — leaving a third process free to steal and start a second npm over a
  // tree that is still being written, which is the whole thing this record prevents.
  if (!ownsRepairLock()) return;
  try {
    rmSync(LOCK_NPM_PID_PATH, { force: true });
  } catch {
    // Best effort: a stale entry only makes a stealer more cautious, never less.
  }
}

function runNpm(args, description) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const npmCommand = isWindows ? 'npm.cmd' : 'npm';

    console.error(description);
    console.error('This may take 30-60 seconds...');

    const child = spawn(npmCommand, args, {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows, // On Windows, we need shell: true to find npm.cmd
      // Make npm a process-group leader on POSIX so killActiveNpm can signal it together
      // with the node-gyp/make/cc descendants that do the actual work.
      detached: !isWindows
    });
    activeNpmChild = child;
    // Record npm's pid inside the lock so that if this process is SIGKILLed — never running
    // its cleanup handlers — a stealer can still see that the tree is being written and
    // decline to start a second npm over it.
    if (child.pid && ownsRepairLock()) {
      try {
        writeFileSync(LOCK_NPM_PID_PATH, String(child.pid));
      } catch {
        // Only costs a stealer the extra caution; the staleness window still applies.
      }
    }

    child.stdout.on('data', (data) => {
      // Route npm's stdout to stderr — stdout is the MCP transport.
      process.stderr.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    // 'close' rather than 'exit': it waits for the forwarded stdio streams to end, so
    // npm's output cannot be truncated by the promise settling first.
    child.on('close', (code) => {
      activeNpmChild = null;
      clearRecordedNpmPid();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm ${args[0]} failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      activeNpmChild = null;
      clearRecordedNpmPid();
      reject(new Error(`Failed to run npm ${args[0]}: ${err.message}`));
    });
  });
}

// Mirrors what initDatabase() does in src/db.ts: open a SQLite handle and load the
// sqlite-vec extension. Runs in a child process so that a hard native crash (or an
// ERR_DLOPEN_FAILED from an ABI mismatch) is observed as a non-zero exit rather than
// taking down this wrapper. Deliberately narrow: better-sqlite3 compiles against the
// V8 ABI and so breaks on every Node major bump, and sqlite-vec ships its binary via
// platform-specific optionalDependencies that npm sometimes fails to install. The
// other native deps (onnxruntime-node, sharp) are N-API and survive Node upgrades,
// and loading them here would cost seconds on every server start.
//
// The probe reports the failure itself rather than letting Node print a stack trace,
// whose first line is an unhelpful frame from bindings.js. Native load errors are often
// multi-line, so they are flattened into a single log-friendly line.
// Marks the probe's own message so it can be picked out of stderr. Node writes its own
// warnings there first (ExperimentalWarning, anything a user's NODE_OPTIONS triggers), and
// reporting one of those instead of the load failure would defeat the probe.
const PROBE_ERROR_PREFIX = 'episodic-probe: ';

// Loading two small native modules is a sub-second operation (~70ms here), so anything
// near this is hung. Deliberately kept well below any caller's wait budget: the deadline is
// only tested between iterations, so a probe allowed to run longer than the whole budget
// could overshoot it — and with it the caller's own timeout — by its own duration.
const PROBE_TIMEOUT_MS = 5 * 1000;

const NATIVE_PROBE = `
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.prepare('select vec_version()').get();
    db.close();
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    console.error('${PROBE_ERROR_PREFIX}' + message.replace(/\\s+/g, ' ').trim().slice(0, 200));
    // Set exitCode instead of calling process.exit: on macOS a piped stderr is async and
    // process.exit would not flush it, discarding the very diagnostic we came here for.
    process.exitCode = 1;
  }
`;

function probeNativeDeps() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', NATIVE_PROBE], {
      cwd: PLUGIN_ROOT, // require() in `node -e` resolves from cwd
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false
    });

    // A dlopen that hangs (a .node on a stalled network filesystem) would otherwise leave
    // this promise pending forever, and the caller's deadline is only checked between
    // awaits — so the wait ceiling would never be reached at all.
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      settle({ ok: false, reason: 'probe timed out' });
    }, PROBE_TIMEOUT_MS);
    timer.unref();

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    // 'close' rather than 'exit', so the captured stderr is complete — otherwise the
    // diagnostic this probe exists to produce can be lost to an unflushed pipe.
    child.on('close', (code, signal) => {
      if (code === 0) return settle({ ok: true });
      // A thoroughly broken .node binary can take the child down on a signal, leaving no
      // exit code and no stderr; naming the signal beats reporting "unknown error".
      const reason = signal ? `probe terminated by ${signal}` : extractProbeReason(stderr);
      settle({ ok: false, reason });
    });
    child.on('error', (err) => settle({ ok: false, reason: err.message }));
  });
}

// Prefers the probe's own tagged message; falls back to the last non-blank line, which is
// far more likely to be the failure than the first (Node's warnings come first).
function extractProbeReason(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const tagged = lines.find((l) => l.startsWith(PROBE_ERROR_PREFIX));
  if (tagged) return tagged.slice(PROBE_ERROR_PREFIX.length);
  return lines.length ? lines[lines.length - 1] : 'unknown error';
}

// Coarse cross-process lock so that concurrently starting Claude Code sessions do not
// run overlapping npm processes against the same node_modules. mkdir is atomic on every
// supported platform, so exactly one process can create the lock directory.
//
// A holder heartbeats the lock's mtime while it works, so "stale" means the holder
// actually died rather than merely being slow — building better-sqlite3 from source can
// take longer than LOCK_STALE_MS on a slow machine, which is precisely the case this
// repair path exists to handle.
const LOCK_PATH = join(PLUGIN_ROOT, '.episodic-memory-repair.lock');
const LOCK_OWNER_PATH = join(LOCK_PATH, 'owner');
const LOCK_NPM_PID_PATH = join(LOCK_PATH, 'npm-pid');
const LOCK_HEARTBEAT_MS = 30 * 1000;
// How often the holder re-checks that the lock is still its own (see startLockHeartbeat).
const LOCK_OWNERSHIP_POLL_MS = 3 * 1000;
// Three missed heartbeats. Because a working holder keeps its lock fresh, this only needs
// to outlast scheduling jitter — not the repair itself. Kept as short as that allows,
// because until a hard-killed holder's lock ages out nobody else can repair either.
const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;
// Upper bound on how long a recorded npm pid may hold off a steal (see evaluateLock).
// Comfortably longer than any real install or from-source build, so it only ever releases
// a lock whose npm record has gone stale.
const NPM_VETO_MAX_MS = 30 * 60 * 1000;
// Every caller passes its own waitMs, because the right ceiling depends entirely on who is
// waiting: the MCP wrapper is on a startup path its client kills, a hook must not delay
// session teardown, and a terminal command can simply wait. What they share is the need for
// *some* ceiling — a holder whose npm has wedged keeps heartbeating indefinitely, so
// staleness alone would never release a waiter.

// Identifies this process's claim so it never deletes a lock that someone else now owns.
const OWNER_TOKEN = `${process.pid}-${process.hrtime.bigint()}`;

// Milliseconds since the lock was last heartbeat, or null when there is no lock.
function lockAgeMs() {
  try {
    return Date.now() - statSync(LOCK_PATH).mtimeMs;
  } catch {
    return null;
  }
}

// True while some process is actively repairing. An abandoned lock does not count: nobody
// is working under it, so waiting on it would be waiting on nothing.
//
// Deliberately the exact complement of "stealable", so the readiness gate and the steal
// can never disagree: the gate exists to stop the MCP server starting against a tree an
// npm is still materialising, and treating an aged-but-busy lock as free would let a
// passing better-sqlite3 probe green-light a half-written node_modules.
function repairInFlight() {
  const state = evaluateLock();
  return state.present && !state.stealable;
}

// "Someone else holds it" and "this root cannot be locked at all" call for opposite
// responses — wait, versus stop immediately — so they are reported as distinct outcomes
// rather than a shared false.
const LOCK_ACQUIRED = 'acquired';
const LOCK_TAKEN = 'taken';
const LOCK_UNAVAILABLE = 'unavailable';

function tryCreateLock() {
  try {
    mkdirSync(LOCK_PATH);
  } catch (err) {
    if (err.code === 'EEXIST') return LOCK_TAKEN;
    // An unwritable plugin root (read-only install, wrong owner) can never be locked, so
    // waiting would accomplish nothing: report it as fatal and let the caller advise.
    console.error(`Could not create the dependency-repair lock: ${err.message}`);
    return LOCK_UNAVAILABLE;
  }

  try {
    writeFileSync(LOCK_OWNER_PATH, OWNER_TOKEN);
    // Guard as soon as the lock exists on disk, not once the caller has finished settling
    // and verifying: a signal arriving in that window would otherwise terminate us on the
    // default handler and strand the lock for its full staleness window.
    guardLockAgainstExit();
    return LOCK_ACQUIRED;
  } catch (err) {
    // ENOENT means someone removed the directory between our mkdir and this write — a
    // transient race, not a broken plugin root, so it must stay retryable. Anything else
    // is a genuine permissions/space problem.
    if (err.code === 'ENOENT') return LOCK_TAKEN;

    // An owner-less lock blocks every repair until it ages out, so clean it up instead of
    // leaving it behind.
    console.error(`Could not record dependency-repair lock ownership: ${err.message}`);
    try {
      rmSync(LOCK_PATH, { recursive: true, force: true });
    } catch {
      // Best effort; the lock will at least age out.
    }
    return LOCK_UNAVAILABLE;
  }
}

function readLockOwner() {
  try {
    return readFileSync(LOCK_OWNER_PATH, 'utf8');
  } catch {
    return null;
  }
}

// Discards a lock whose holder stopped heartbeating. Renaming is atomic between racing
// stealers, but it cannot by itself be atomic with the staleness *check* that preceded
// it: another process may steal and re-create the lock in between, in which case this
// rename would carry off a brand-new, perfectly live lock. Comparing the owner token
// observed before the rename against the one actually carried off detects exactly that,
// and the lock is put back when they differ.
// Counts every steal this process attempts, so each discard path is unique for the whole
// lifetime of the process. A per-call attempt index would repeat across the outer
// wait/claim cycles, and a leftover directory from an earlier cycle whose cleanup failed
// would then make renameSync fail with ENOTEMPTY — reported as a lost race, leaving a
// genuinely stale lock in place forever.
let stealCounter = 0;

function stealStaleLock() {
  // evaluateLock reads the owner once and hands it back, so the token judged here is the
  // same one carried off below. With a dead holder detected on the first poll rather than
  // after 90s, every waiter reaches this path in the same tick, and re-reading between the
  // check and the rename would routinely judge one lock and carry off another.
  const { stealable, owner: observedOwner } = evaluateLock();
  if (!stealable) return false;

  const discarded = `${LOCK_PATH}.stale-${OWNER_TOKEN}-${stealCounter++}`;
  try {
    renameSync(LOCK_PATH, discarded);
  } catch {
    return false; // Another process won the race, or the lock was just released.
  }

  let carriedOwner;
  try {
    carriedOwner = readFileSync(join(discarded, 'owner'), 'utf8');
  } catch {
    carriedOwner = null;
  }

  if (carriedOwner !== observedOwner) {
    // We took a lock other than the stale one we judged — it belongs to a live holder.
    // Put it back, and if that fails leave it untouched rather than deleting it: removing
    // another process's lock would strand it rewriting node_modules unprotected. The
    // orphaned directory is inert and gitignored; the holder's heartbeat notices the loss
    // and aborts.
    try {
      renameSync(discarded, LOCK_PATH);
    } catch {
      // Intentionally left in place.
    }
    return false;
  }

  console.error('Cleared a stale dependency-repair lock.');
  try {
    rmSync(discarded, { recursive: true, force: true });
  } catch {
    // Best effort: the renamed directory is inert either way.
  }
  return true;
}

// Signal 0 performs the existence/permission check without delivering anything. EPERM
// means the process exists under another user, which still counts as alive; only ESRCH
// proves it is gone. Same-machine only, which node_modules always is, and a recycled pid
// reads as alive — so this can only ever be conservative.
function processGone(pid, asGroup = false) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(asGroup ? -pid : pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

// The npm this lock's holder started, recorded so a stealer can tell whether the work is
// really over. runNpm puts npm in its own process group, so the group is queried rather
// than the npm CLI itself: when npm exits but node-gyp and cc are still compiling, the
// group survives and the tree is still being written.
function lockNpmAlive() {
  let recorded;
  try {
    recorded = readFileSync(LOCK_NPM_PID_PATH, 'utf8').trim();
  } catch {
    return false; // No npm running under this lock.
  }
  const pid = Number.parseInt(recorded, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Check the group first, then the process itself. runNpm makes npm a group leader on
  // POSIX so the group query is the meaningful one — it stays alive while node-gyp and cc
  // are still compiling after npm itself has exited. But nothing guarantees the recorded
  // pid leads a group (Windows has none, and a detached spawn can fail), and a group query
  // against a non-leader reports ESRCH — a false "gone" that would license a second npm.
  if (!processGone(pid, true)) return true;
  return !processGone(pid, false);
}

function holderProcessGone(owner) {
  if (!owner) return false;
  return processGone(Number.parseInt(owner.split('-')[0], 10));
}

// Decides in one place whether the lock is free for the taking, and hands back the owner
// token it judged so the caller carries off the very lock it evaluated.
//
// A live npm vetoes a steal at *any* age, which is the whole point of recording its pid.
// Consulting it only for a fresh lock — as an `age <= STALE && !abandoned` short-circuit
// does — protects precisely the window the staleness timer already covered, and abandons
// the tree at the moment protection starts to matter: a holder killed with SIGKILL never
// runs its cleanup handlers, and a from-source better-sqlite3 build routinely outlives
// LOCK_STALE_MS, so past 90s a stealer would start a second npm over a tree the first is
// still writing.
//
// Past the staleness window the holder is presumed gone whatever its token says, so an
// unparseable owner still ages out rather than blocking every steal forever.
function evaluateLock() {
  const age = lockAgeMs();
  if (age === null) return { present: false, stealable: false, owner: null };

  const owner = readLockOwner();
  // The npm veto is bounded. processGone() reports "alive" for EPERM and for a pid that has
  // since been recycled by an unrelated process, so an unbounded veto turns a SIGKILLed
  // worker plus one pid reuse into a lock nobody can ever steal and a repairInFlight() that
  // is permanently true — every entry point would report "still being repaired" forever and
  // the self-heal could never converge. That is a worse failure than the concurrent npm it
  // guards against, so past NPM_VETO_MAX_MS the record is presumed stale.
  //
  // A genuinely long install cannot trip this: its holder is alive and heartbeating, which
  // keeps age near zero. Only an unheartbeated lock ages into the bypass.
  if (age <= NPM_VETO_MAX_MS && lockNpmAlive()) {
    return { present: true, stealable: false, owner };
  }
  if (age > LOCK_STALE_MS) return { present: true, stealable: true, owner };
  return { present: true, stealable: holderProcessGone(owner), owner };
}

function ownsRepairLock() {
  return readLockOwner() === OWNER_TOKEN;
}

// Time allowed for a concurrent stealer to finish its rename/re-create before we trust
// that the lock we just created is really ours. Those are a handful of syscalls, so this
// is generous by orders of magnitude.
const LOCK_SETTLE_MS = 250;
const MAX_CLAIM_ATTEMPTS = 3;

// Creating the lock is not on its own proof of holding it, because a stealer acting on a
// stale observation can rename it away immediately afterwards. Settling and then
// re-reading the owner token resolves that: of any two processes that believe they
// acquired the lock, only the one whose token is still on disk proceeds.
async function claimRepairLock() {
  // Bounds iterations rather than acquisitions: a successful steal only clears the way, so
  // it must leave a pass behind it to actually take the lock. Sizing this above
  // MAX_CLAIM_ATTEMPTS keeps a steal on the last attempt from being wasted.
  for (let i = 0; i < MAX_CLAIM_ATTEMPTS * 2; i++) {
    const created = tryCreateLock();
    if (created === LOCK_UNAVAILABLE) return LOCK_UNAVAILABLE;
    if (created === LOCK_ACQUIRED) {
      await sleep(LOCK_SETTLE_MS);
      if (ownsRepairLock()) return LOCK_ACQUIRED;
      // Stolen from under us. If the lock now on disk has no owner at all it is orphaned
      // — nobody is heartbeating it and nobody will release it — so clear it here instead
      // of leaving every later session to wait out its full staleness window. The age
      // check avoids racing a process that is mid-acquire, between its mkdir and its
      // owner write, and would otherwise have its lock deleted underneath it.
      const orphanAge = lockAgeMs();
      if (readLockOwner() === null && orphanAge !== null && orphanAge > LOCK_SETTLE_MS * 4) {
        try {
          rmSync(LOCK_PATH, { recursive: true, force: true });
        } catch {
          // Best effort; it will age out.
        }
      }
      continue;
    }
    if (!stealStaleLock()) {
      // stealStaleLock declines both when a live holder owns the lock and when there is no
      // lock at all — the latter whenever the holder released between our failed create
      // and this check. Reporting that as "taken" would defer a repair nobody is doing.
      if (lockAgeMs() === null) continue;
      return LOCK_TAKEN; // A live holder owns it.
    }
  }
  return LOCK_TAKEN;
}

function releaseRepairLock() {
  // Never unlock a tree npm is still writing. The lock directory holds the npm-pid record,
  // so releasing it erases the very evidence that would stop the next session starting a
  // second npm — and on the signal path npm gets only NPM_SHUTDOWN_GRACE_MS to die, which a
  // node-gyp compile can outlast. Leaving the lock standing is the safe failure: its holder
  // is gone but its npm is alive, which evaluateLock() correctly reads as "still busy".
  if (activeNpmChild) return;

  try {
    if (readFileSync(LOCK_OWNER_PATH, 'utf8') !== OWNER_TOKEN) return;
  } catch {
    // Missing or unreadable owner file: the lock is no longer demonstrably ours.
    return;
  }
  try {
    rmSync(LOCK_PATH, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover lock goes stale on its own.
  }
}

// Being killed part-way through a repair is routine, not exotic: the MCP client enforces
// its own startup timeout and an `npm rebuild` can outlast it. Without these handlers the
// lock would survive this process and stall the next session until it aged out — and that
// session would be killed the same way, so the sessions would livelock on each other.
// They are installed only while the lock is held, so they cannot interfere with the
// signal forwarding the server child relies on later.
const LOCK_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function releaseLockOnExit() {
  releaseRepairLock();
}

// How long to let a signalled npm wind down before releasing the lock anyway.
const NPM_SHUTDOWN_GRACE_MS = 2000;

function releaseLockOnSignal(signal) {
  const child = activeNpmChild;
  killActiveNpm(signal); // Don't leave npm rewriting node_modules with no lock held.

  const finish = () => {
    releaseRepairLock();
    process.exit(1);
  };
  if (!child) return finish();

  // Signalling npm only asks it to stop. Releasing the lock while it is still writing
  // node_modules would let the next session start a second npm over the same tree, so wait
  // for it to actually exit — bounded, so a wedged npm cannot block shutdown forever.
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    finish();
  };
  child.once('close', finishOnce);
  setTimeout(finishOnce, NPM_SHUTDOWN_GRACE_MS).unref();
}

// Idempotent: the claim loop can create the lock several times, and re-registering the
// same listeners would leak them and trip Node's max-listeners warning.
let lockGuarded = false;

function guardLockAgainstExit() {
  if (lockGuarded) return;
  lockGuarded = true;
  process.on('exit', releaseLockOnExit);
  for (const signal of LOCK_SIGNALS) process.on(signal, releaseLockOnSignal);
}

function unguardLockAgainstExit() {
  if (!lockGuarded) return;
  lockGuarded = false;
  process.off('exit', releaseLockOnExit);
  for (const signal of LOCK_SIGNALS) process.off(signal, releaseLockOnSignal);
}

// Set when the heartbeat notices this process no longer owns the lock it is working under.
let lockLost = false;

// Keeps the lock's mtime fresh for as long as this process is genuinely working, so that
// a legitimately slow repair is never mistaken for an abandoned one.

function startLockHeartbeat() {
  lockLost = false;
  // Losing the lock is drastic — it aborts the repair — so require two consecutive
  // observations. A single unreadable owner file (an AV scanner on Windows, EMFILE while
  // npm holds thousands of descriptors) is transient and must not kill a healthy repair.
  let missedOwnershipChecks = 0;
  let lastRefresh = Date.now();

  // The tick is much faster than the mtime refresh it drives. Ownership has to be checked
  // often, because every tick spent unaware of a lost lock is a tick spent running npm
  // over a tree another process may also be writing; refreshing the mtime that often would
  // just be pointless I/O. Realistic trigger for the gap: the machine sleeps mid-repair,
  // heartbeats stop, the lock ages out and is stolen, and we wake with npm still running.
  const timer = setInterval(() => {
    if (!ownsRepairLock()) {
      if (++missedOwnershipChecks < 2) return;
      // Losing the lock means someone else may already be rewriting node_modules, so
      // continuing would create the concurrent-npm corruption the lock exists to prevent.
      // Stop our own npm and let the repair unwind rather than pressing on unprotected.
      if (!lockLost) {
        lockLost = true;
        console.error('Lost the dependency-repair lock to another process; stopping.');
        killActiveNpm('SIGTERM');
      }
      return; // Never keep someone else's lock looking fresh.
    }
    missedOwnershipChecks = 0;
    if (Date.now() - lastRefresh < LOCK_HEARTBEAT_MS) return;
    lastRefresh = Date.now();
    const now = new Date();
    try {
      utimesSync(LOCK_PATH, now, now);
    } catch {
      // Lock removed; the next tick's ownership check decides what to do.
    }
  }, LOCK_OWNERSHIP_POLL_MS);
  timer.unref(); // Never hold the process open on the heartbeat alone.
  return () => clearInterval(timer);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Records the Node ABI the dependencies were last built for. Lives inside node_modules so
// it is discarded whenever the tree is, and is ignored by git for free.
const ABI_MARKER_PATH = join(PLUGIN_ROOT, 'node_modules', '.episodic-memory-abi');

function readBuiltAbi() {
  try {
    return readFileSync(ABI_MARKER_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function recordBuiltAbi() {
  try {
    writeFileSync(ABI_MARKER_PATH, process.versions.modules);
  } catch {
    // The marker is only advisory — losing it costs a warning, not correctness.
  }
}

// Keeps the marker current whenever the dependencies are known-good, including after a
// plain `npm install` done by hand. Without this the first Node switch produces a silent
// rebuild, because there is no recorded ABI to notice the change against.
function syncBuiltAbi() {
  if (readBuiltAbi() !== process.versions.modules) recordBuiltAbi();
}

// One plugin root shared by two Node majors (typically nvm) means each version's probe
// fails against the other's freshly built binary, so every start pays a full rebuild.
// That is a user-level configuration problem, so say so instead of silently churning.
function warnOnAbiChurn() {
  const previous = readBuiltAbi();
  if (previous && previous !== process.versions.modules) {
    console.error(
      `Note: these dependencies were last built for Node ABI ${previous}, but this process is ` +
      `Node ${process.version} (ABI ${process.versions.modules}). Running episodic-memory under ` +
      'more than one Node major will rebuild them on every start; pin a single Node version to ' +
      'avoid the churn.'
    );
  }
}

// Scoped to better-sqlite3 on purpose. A bare `npm rebuild` re-runs install scripts for
// the whole tree — including onnxruntime-node's postinstall, which fetches the ONNX
// runtime binaries — turning the cheap first repair step into a multi-minute download that
// would overrun the MCP client's startup timeout and get this wrapper killed before it
// could report anything. better-sqlite3 is also the only probed dependency a rebuild can
// fix: sqlite-vec declares no install scripts at all and gets its binary from a
// platform-specific optionalDependency, so only INSTALL_STEP can repair that one.
const REBUILD_STEP = {
  args: ['rebuild', 'better-sqlite3'],
  description: 'Rebuilding better-sqlite3 for this version of Node...'
};
const INSTALL_STEP = {
  args: ['install', '--prefer-offline', '--no-audit', '--no-fund'],
  description: 'Installing episodic-memory dependencies...'
};

// Ordinarily rebuild first: it recompiles better-sqlite3 against the running Node ABI and
// is the cheap fix for the common case (a Node upgrade), with `npm install` behind it
// because that additionally restores missing platform-specific optionalDependencies. When
// the tree is missing outright there is nothing to rebuild, so install leads instead.
function repairSteps(treeMissing) {
  return treeMissing ? [INSTALL_STEP, REBUILD_STEP] : [REBUILD_STEP, INSTALL_STEP];
}

// Worker exit codes. The parent needs these to tell "nothing more will happen, tell the
// user" apart from "someone else is still working, keep waiting" — the two look identical
// from outside but call for opposite messages.
const REPAIR_OK = 0;
const REPAIR_FAILED = 1;
const REPAIR_DEFERRED = 2;

// Runs the repair itself. This executes in the detached worker, never on the startup path,
// so it is free to take as long as the build actually needs.
async function repairNativeDeps(reason, { treeMissing = false } = {}) {
  console.error(`episodic-memory: ${reason}`);

  const claim = await claimRepairLock();
  if (claim !== LOCK_ACQUIRED) {
    unguardLockAgainstExit(); // Nothing held; drop the guards tryCreateLock installed.
    if (claim === LOCK_UNAVAILABLE) return REPAIR_FAILED; // Waiting cannot help; advise.
    // Another worker is already on it. Two workers repairing the same tree is the thing
    // the lock prevents, so stand down and let the parent keep waiting on that one.
    console.error('Another episodic-memory process is already repairing dependencies.');
    return REPAIR_DEFERRED;
  }

  const stopHeartbeat = startLockHeartbeat();
  try {
    const steps = repairSteps(treeMissing);
    for (const [index, step] of steps.entries()) {
      const hasNextStep = index < steps.length - 1;
      // Checked at the top of every iteration, not only around runNpm: the heartbeat can
      // declare the lock lost during the probe below, and by then killActiveNpm has
      // nothing left to kill. Starting the next npm step unlocked is precisely the
      // concurrent-write corruption this lock exists to prevent.
      if (lockLost) return REPAIR_DEFERRED;
      try {
        await runNpm(step.args, step.description);
      } catch (err) {
        // Losing the lock means another worker took over, so this is deferral, not defeat.
        if (lockLost) return REPAIR_DEFERRED;
        // Don't promise a next step after the last one — this log is what the user is
        // pointed at, and it would otherwise read as though it had been cut off.
        console.error(hasNextStep ? `${err.message} — trying the next repair step.` : err.message);
        continue;
      }
      if (lockLost) return REPAIR_DEFERRED;
      const result = await probeNativeDeps();
      if (lockLost) return REPAIR_DEFERRED;
      if (result.ok) {
        console.error('episodic-memory dependencies are ready.');
        recordBuiltAbi();
        return REPAIR_OK;
      }
      console.error(`Still failing after \`npm ${step.args[0]}\` (${result.reason}).`);
    }
    return REPAIR_FAILED;
  } finally {
    stopHeartbeat();
    releaseRepairLock();
    unguardLockAgainstExit();
  }
}

// Every dependency failure ends the same way for the user: a manual npm install in the
// plugin root. Keep that instruction attached to the error rather than leaving them with
// a bare npm exit code.
// console.error to a pipe is asynchronous on macOS and process.exit does not flush it, so
// the remediation advice — the entire user-facing payoff of a failed repair — can be lost
// exactly when it matters most. writeSync bypasses that buffering.
function writeStderrSync(line) {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    console.error(line); // Fall back rather than lose the message entirely.
  }
}

// The repair runs in a detached child rather than inline, because the MCP wrapper calls
// this from a startup path the client kills when its own timeout expires. Inline,
// a build slower than that timeout would be killed part-way every single time and the
// self-heal could never converge — each attempt would redo the work the last one lost.
// Detached, the build keeps running after we are gone, so the next start finds it done.
const REPAIR_WORKER_FLAG = '--repair-worker';
const REPAIR_LOG_PATH = join(PLUGIN_ROOT, '.episodic-memory-repair.log');
const PROBE_POLL_MS = 1000;
const PROBE_POLL_MAX_MS = 5000;

const REPAIR_LOG_MAX_BYTES = 512 * 1024;

// Appends, rotating once the log grows past a cap — this file is a diagnostic for the last
// repair, and nothing else ever prunes it.
//
// Rotated by rename rather than truncated in place. Two parents can be opening this
// concurrently (the MCP wrapper and the SessionStart hook both call ensureNativeDeps), and
// truncating would cut the file out from under a worker that already holds an append fd on
// it — losing the head of exactly the log reportUnavailable is about to point at. After a
// rename that worker keeps writing to the same inode, now under the .1 name.
function openRepairLog() {
  try {
    if (statSync(REPAIR_LOG_PATH).size > REPAIR_LOG_MAX_BYTES) {
      renameSync(REPAIR_LOG_PATH, `${REPAIR_LOG_PATH}.1`);
    }
  } catch {
    // No log yet, or another process rotated it first; either way, just append.
  }
  try {
    return openSync(REPAIR_LOG_PATH, 'a');
  } catch {
    return null; // Without a log the repair still runs; only its diagnostics are lost.
  }
}

// Whether a worker's output actually went to the log, so the user is never pointed at a
// file that was never written, and whether its path has already been shown.
let repairLogWritten = false;
let repairLogAnnounced = false;

function reportRepairLog(prefix = 'Repair details were logged to') {
  // writeStderrSync, not console.error: callers exit immediately afterwards, and this is
  // the pointer to the only diagnostic that exists. Skipped when the path was already
  // announced before the wait — saying it twice in different words reads as two files.
  if (repairLogWritten && !repairLogAnnounced) writeStderrSync(`${prefix} ${REPAIR_LOG_PATH}.`);
}

function spawnDetachedRepair(treeMissing, quiet = false) {
  const logFd = openRepairLog();
  const output = logFd === null ? 'ignore' : logFd;
  repairLogWritten = logFd !== null;

  try {
    const child = spawn(
      process.execPath,
      [__filename, REPAIR_WORKER_FLAG, treeMissing ? 'tree-missing' : 'probe-failed'],
      {
        cwd: PLUGIN_ROOT,
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true, // A detached child would otherwise pop a console on Windows.
        env: { ...process.env, EPISODIC_MEMORY_ROOT: PLUGIN_ROOT }
      }
    );
    child.unref(); // Let this process exit without waiting on the repair.
    return child;
  } catch (err) {
    if (!quiet) console.error(`Could not start the dependency repair: ${err.message}`);
    repairLogWritten = false; // No worker ran, so nothing was logged.
    return null;
  } finally {
    // The child holds its own duplicate; this process runs for the rest of the session and
    // has no further use for the descriptor.
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        // Nothing to do.
      }
    }
  }
}

// Waits for whichever worker is repairing — ours or one already running — to make the
// dependencies usable. Polling the probe rather than the lock means it does not matter
// which process does the work, or whether it started before we did.
//
// Our own worker exiting only ends the wait when it exited because the repair is not going
// to succeed. A worker that stood down (REPAIR_DEFERRED) means a different one is still
// working, so waiting remains the right thing to do.
// How often to say something while waiting. A repair can legitimately take minutes (a fresh
// install pulling onnxruntime), and npm's own output goes to the detached worker's log, so
// without this the terminal shows one line and then nothing at all until the wait ends.
const PROGRESS_NOTICE_MS = 15 * 1000;

async function awaitRepair(deadline, worker, quiet = false) {
  let abandoned = !worker;
  let workerExited = !worker;
  if (worker) {
    worker.on('exit', (code) => {
      workerExited = true;
      // Only give up when nothing more is coming. REPAIR_DEFERRED means another worker is
      // still going, and REPAIR_OK means this one succeeded — reporting either as failure
      // would tell the user a completed repair had failed. A null code means it was killed.
      if (code === REPAIR_FAILED || code === null) abandoned = true;
    });
    // spawn reports failures asynchronously; without this listener an EMFILE/EAGAIN would
    // be re-thrown by EventEmitter on a later tick, outside every try/catch here.
    worker.on('error', (err) => {
      if (!quiet) console.error(`Dependency repair could not run: ${err.message}`);
      // The worker never started, so the log holds nothing about this failure — it is
      // opened in append mode and would still show the previous run. Don't point there.
      //
      // Deliberately not deleting the empty file openRepairLog created: another session's
      // worker may already hold an append fd on that same path, and unlinking it would send
      // its entire repair log to an orphaned inode. An empty file is the cheaper problem.
      repairLogWritten = false;
      abandoned = true;
    });
  }

  // Back the interval off as the wait lengthens. Each poll spawns a probe subprocess, and
  // the CLI budget is 30x the MCP one — at a flat 1s that would be hundreds of spawns
  // competing with the npm rebuild they are waiting on. The sleep is clamped to the time
  // actually left: the deadline is only tested between iterations, so an unclamped backoff
  // would overshoot it by its own length and eat into the caller's own timeout.
  const startedAt = Date.now();
  let pollMs = PROBE_POLL_MS;
  let nextNotice = startedAt + PROGRESS_NOTICE_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(pollMs * 1.5, PROBE_POLL_MAX_MS);

    if (!quiet && Date.now() >= nextNotice) {
      nextNotice = Date.now() + PROGRESS_NOTICE_MS;
      console.error(
        `episodic-memory: still repairing (${Math.round((Date.now() - startedAt) / 1000)}s)...`
      );
    }
    // The probe covers better-sqlite3 and sqlite-vec, but the server also loads
    // onnxruntime-node (via @huggingface/transformers) at import time. During a fresh
    // `npm install` those can become usable minutes apart, so a passing probe alone would
    // start a server against a half-written tree. An unheld lock is the real signal that
    // no npm is still running.
    if ((await probeNativeDeps()).ok && !repairInFlight()) return 'repaired';

    // Our worker is not going to help us any further — it failed to spawn, exited without
    // fixing anything, or was killed. One condition covers all of those, because splitting
    // them invites exactly the inconsistency that made an earlier version condemn the tree
    // while another session's npm was running and advise a concurrent `npm install` — the
    // corruption this whole lock exists to prevent.
    //
    // It only ends the wait if nobody else is repairing either. While someone is, waiting
    // remains the right thing to do: their worker is making the progress ours did not.
    if ((abandoned || workerExited) && !repairInFlight()) {
      // Confirm before condemning. This fires for a worker that exited 0 as well, and the
      // poll above can fail transiently — a probe timing out on a machine node-gyp has just
      // saturated, or EMFILE at session start. Re-check the lock *after* the probe too: it
      // takes 70ms–5s, long enough for another session to claim the lock and start npm, and
      // a passing probe alone would call a half-written tree 'repaired'.
      return ((await probeNativeDeps()).ok && !repairInFlight()) ? 'repaired' : 'failed';
    }
  }
  return 'in-progress';
}

async function runRepairWorker(mode) {
  const treeMissing = mode === 'tree-missing';

  // Probe on both paths, including tree-missing. Another process can finish installing
  // between the parent's existsSync check and this worker starting, and a needless
  // `npm install` would then hold the lock while every other session's readiness gate
  // waits on it — turning working dependencies into "restart Claude Code".
  const current = await probeNativeDeps();
  if (current.ok) return REPAIR_OK; // Someone else already fixed it while we were starting.

  const probe = treeMissing
    ? { ok: false, reason: 'dependencies are not installed yet.' }
    : current;

  return repairNativeDeps(
    treeMissing ? probe.reason : `native dependencies are unusable (${probe.reason}).`,
    { treeMissing }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry contract used by the MCP wrapper and the CLI entry points.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify the native dependencies and, when they are broken, get them repaired.
 *
 * Returns 'ready' when the dependencies are usable, 'failed' when the repair cannot
 * succeed (and the caller should tell the user to run npm install), or 'in-progress' when
 * a repair is genuinely still running but outlasted waitMs.
 *
 * waitMs differs by caller: the MCP wrapper is on a startup path the client kills, so it
 * gives up quickly and asks for a restart; a CLI has no such deadline and can simply wait.
 */
export async function ensureNativeDeps({ waitMs, quiet = false } = {}) {
  // Deliberately no default — the right ceiling is the caller's to choose — but a missing
  // one must fail loudly. Left alone it makes the deadline NaN, every `Date.now() < NaN`
  // comparison false, and the wait loop a no-op: the caller would be told "still being
  // repaired" for a tree that a two-second wait would have seen fixed.
  if (!Number.isFinite(waitMs)) {
    throw new TypeError(`ensureNativeDeps requires a finite waitMs, received ${waitMs}`);
  }
  const deadline = Date.now() + waitMs;
  const treeMissing = !existsSync(join(PLUGIN_ROOT, 'node_modules'));
  let probe = treeMissing
    ? { ok: false, reason: 'dependencies are not installed yet.' }
    : await probeNativeDeps();

  // Repairing deletes and recompiles a binary other processes may be using, so never do it
  // on the strength of a single failure — a probe can time out on a loaded machine or hit
  // EMFILE when several processes start at once, and those clear on a retry.
  if (!probe.ok && !treeMissing) {
    const retry = await probeNativeDeps();
    if (retry.ok) probe = retry;
  }

  if (probe.ok) {
    syncBuiltAbi();
    return 'ready';
  }

  if (!quiet) {
    console.error(
      treeMissing
        ? 'episodic-memory: dependencies are not installed yet; repairing...'
        : `episodic-memory: native dependencies are unusable (${probe.reason}); repairing...`
    );
    warnOnAbiChurn();
  }

  const worker = spawnDetachedRepair(treeMissing, quiet);
  // Point at the log before the wait, not only after it. npm's output goes to the detached
  // worker, so this is the only way to watch a repair that is legitimately taking minutes.
  if (!quiet && repairLogWritten) {
    console.error(`episodic-memory: progress is being logged to ${REPAIR_LOG_PATH}`);
    repairLogAnnounced = true;
  }
  let outcome = await awaitRepair(deadline, worker, quiet);

  // The deadline can fall between the last poll and a worker finishing, so re-probe before
  // concluding anything: reporting failure for a repair that just succeeded is worse than
  // spending another ~70ms.
  if (outcome === 'in-progress' && (await probeNativeDeps()).ok && !repairInFlight()) {
    outcome = 'repaired';
  }
  // Deliberately no "no lock held, so it must have died" conversion here. The worker probes
  // for up to PROBE_TIMEOUT_MS before claiming the lock, so an absent lock is equally
  // consistent with a worker that has not started yet — and awaitRepair already reports
  // 'failed' for a worker that actually exited without fixing anything. Condemning a live
  // repair would tell the user to run npm install over a tree that is about to be fixed.

  if (outcome === 'repaired') {
    syncBuiltAbi();
    return 'ready';
  }
  return outcome === 'failed' ? 'failed' : 'in-progress';
}

// What a caller should print when ensureNativeDeps did not return 'ready'. Kept here so
// every entry point says the same thing about the same situation.
//
// Everything goes through writeStderrSync: console.error to a pipe is asynchronous on
// macOS and process.exit does not flush it, so the remediation advice — the entire
// user-facing payoff — can be lost exactly when it matters. retryHint is caller-supplied
// because how you retry differs: a CLI is re-run by hand, an MCP server by restarting the
// client, and telling a user to do the wrong one is worse than saying nothing.
export function reportUnavailable(outcome, { retryHint = 'Run this again once it finishes.' } = {}) {
  if (outcome === 'in-progress') {
    writeStderrSync('ERROR: episodic-memory dependencies are still being repaired.');
    if (repairLogWritten && !repairLogAnnounced) {
      writeStderrSync(`Progress is being logged to ${REPAIR_LOG_PATH}.`);
    }
    writeStderrSync(retryHint);
    // Name the lock. If this message keeps recurring, the repair is not actually running
    // and the lock is the thing standing in the way — without naming it there is no way for
    // anyone to find that out, let alone clear it.
    writeStderrSync(`If this persists, no repair is running: remove ${LOCK_PATH} and retry.`);
    return;
  }
  reportRepairLog();
  writeStderrSync('ERROR: episodic-memory could not repair its native dependencies.');
  writeStderrSync(`Please run manually: cd "${PLUGIN_ROOT}" && npm install`);
}

// Whether the package can resolve a runtime dependency by name. Exact rather than
// heuristic: existsSync('node_modules') is satisfied by an empty directory that resolves
// nothing, which is how an earlier version of this check managed to be wrong.
export function canResolveDependency(name) {
  try {
    // Resolved from PLUGIN_ROOT, not from this module's own location. Everything else in
    // this file reasons about PLUGIN_ROOT, and the two diverge whenever EPISODIC_MEMORY_ROOT
    // is set — including in the detached worker, which is spawned with exactly that env.
    // Answering about the wrong tree is the one way this check can be quietly wrong.
    createRequire(join(PLUGIN_ROOT, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

// Someone watching a terminal will wait for a repair; a hook, cron job, or piped command
// will not, and nothing is served by holding its slot. Shared here so the entry points
// cannot drift apart on it.
export const CLI_REPAIR_BUDGET_MS = 10 * 60 * 1000;
export const BACKGROUND_REPAIR_BUDGET_MS = 15 * 1000;

export function isInteractiveRun() {
  return Boolean(process.stderr.isTTY);
}

// `unattended` lets a caller assert that nobody is waiting even when stderr happens to be a
// terminal — a hook or background run. Without it the budget rests on TTY-ness alone, and a
// hook launched from a terminal would inherit the full ten-minute ceiling and stall session
// teardown, which is the opposite of the contract the hook paths document.
export function repairBudgetMs({ unattended = false } = {}) {
  return !unattended && isInteractiveRun() ? CLI_REPAIR_BUDGET_MS : BACKGROUND_REPAIR_BUDGET_MS;
}

export { PLUGIN_ROOT };

// Run directly with --repair-worker, this module is the detached repair worker itself.
// Both sides are realpath'd because Node's ESM loader resolves symlinks when building
// import.meta.url while process.argv[1] keeps whatever path the caller typed; comparing
// them naively makes any symlinked path component look like an import.
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

if (invokedDirectly && process.argv[2] === REPAIR_WORKER_FLAG) {
  console.error(`--- episodic-memory dependency repair started ${new Date().toISOString()} ---`);
  runRepairWorker(process.argv[3]).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Repair failed: ${error.message}`);
      process.exit(REPAIR_FAILED);
    }
  );
}

// Exported for tests only. The lock state machine is the most intricate logic here and is
// otherwise reachable only by racing real processes.
export const __testing = {
  LOCK_PATH,
  LOCK_ACQUIRED,
  LOCK_TAKEN,
  LOCK_UNAVAILABLE,
  LOCK_STALE_MS,
  NPM_VETO_MAX_MS,
  OWNER_TOKEN,
  PROBE_ERROR_PREFIX,
  claimRepairLock,
  clearRecordedNpmPid,
  setActiveNpmChildForTest,
  extractProbeReason,
  lockAgeMs,
  ownsRepairLock,
  releaseRepairLock,
  repairInFlight,
  stealStaleLock,
  tryCreateLock,
  unguardLockAgainstExit
};
