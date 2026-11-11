import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { snapshotTask, stableDigest } from '../src/snapshot.js';
import { CacheStore } from '../src/cache.js';

const permissions = async paths => ({
  verified: true, entries: paths.map(itemPath => ({ path: itemPath, owner: 'test', dacl: 'read' })), reasons: [],
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-incremental-storage-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const repo = path.join(directory, 'repo');
  const state = path.join(directory, 'state');
  await fs.mkdir(repo);
  return { directory, repo, state };
}

function record(taskId, generation, output = { text: 'ok' }) {
  return {
    schemaVersion: 1, taskId, resultVersion: generation, fingerprint: 'a'.repeat(64), components: {}, output,
    provenance: {}, validation: [], reuseEligibility: { eligible: true, reasons: [] }, createdAt: '2026-11-11T00:00:00.000Z',
  };
}

test('snapshot hashes exact UTF-8 bytes, preserves BOM and includes empty and hidden directories', async t => {
  const { repo } = await fixture(t);
  await fs.mkdir(path.join(repo, 'data', 'empty'), { recursive: true });
  await fs.mkdir(path.join(repo, '.git'));
  const bytes = Buffer.from('\uFEFF你好\r\n');
  await fs.writeFile(path.join(repo, 'data', 'untracked.txt'), bytes);
  await fs.writeFile(path.join(repo, '.git', 'visible-to-snapshot'), 'metadata');
  const snapshot = await snapshotTask(repo, { files: ['data/untracked.txt'], directories: ['.'] }, { permissionProvider: permissions });
  const file = snapshot.files.find(entry => entry.path === 'data/untracked.txt');
  assert.equal(file.text, '\uFEFF你好\r\n');
  assert.equal(file.bytes, bytes.length);
  assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(snapshot.directories.find(entry => entry.path === 'data/empty').entries, []);
  assert(snapshot.files.some(entry => entry.path === '.git/visible-to-snapshot'));
  assert.deepEqual(snapshot.directories.find(entry => entry.path === 'data').entries, [
    { path: 'data/empty', type: 'directory' }, { path: 'data/untracked.txt', type: 'file' },
  ]);
  assert.equal(snapshot.assurance.verified, true);
});

test('snapshot cache digest ignores mtime and input declaration ordering', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(repo, 'b.txt'), 'beta');
  const first = await snapshotTask(repo, { files: ['b.txt', './a.txt'], directories: [] }, { permissionProvider: permissions });
  await fs.utimes(path.join(repo, 'a.txt'), new Date(1_000_000), new Date(1_000_000));
  const second = await snapshotTask(repo, { files: ['a.txt', 'b.txt'], directories: [] }, { permissionProvider: permissions });
  assert.equal(first.digest, second.digest);
  assert.equal(stableDigest({ b: 1, a: 2 }), stableDigest({ a: 2, b: 1 }));
});

test('snapshot rejects traversal, absolute paths, alternate streams, invalid UTF-8, and byte overflow', async t => {
  const { repo } = await fixture(t);
  for (const invalid of ['../secret', 'a/../secret', '/etc/passwd', 'C:\\secret', 'file:stream']) {
    await assert.rejects(snapshotTask(repo, { files: [invalid], directories: [] }, { permissionProvider: permissions }), { code: 'INPUT_PATH_INVALID' });
  }
  await fs.writeFile(path.join(repo, 'bad.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(snapshotTask(repo, { files: ['bad.txt'], directories: [] }, { permissionProvider: permissions }), { code: 'INPUT_ENCODING_INVALID' });
  await fs.writeFile(path.join(repo, 'big.txt'), '12345');
  await assert.rejects(snapshotTask(repo, { files: ['big.txt'], directories: [] }, { maxBytes: 4, permissionProvider: permissions }), { code: 'INPUT_TOO_LARGE' });
});

test('snapshot detects content and permission changes between scans', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a'), 'before');
  let calls = 0;
  await assert.rejects(snapshotTask(repo, { files: ['a'], directories: [] }, {
    permissionProvider: async paths => {
      if (++calls === 1) await fs.writeFile(path.join(repo, 'a'), 'after!');
      return permissions(paths);
    },
  }), { code: 'SNAPSHOT_DRIFT' });
  calls = 0;
  await assert.rejects(snapshotTask(repo, { files: ['a'], directories: [] }, {
    permissionProvider: async paths => ({ ...(await permissions(paths)), entries: paths.map(itemPath => ({ path: itemPath, dacl: String(++calls) })) }),
  }), { code: 'SNAPSHOT_DRIFT' });
});

test('unverified permissions allow execution but prohibit verified assurance', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a'), 'ok');
  const snapshot = await snapshotTask(repo, { files: ['a'], directories: [] }, {
    permissionProvider: async () => { throw new Error('ACL unavailable'); },
  });
  assert.equal(snapshot.files[0].text, 'ok');
  assert.equal(snapshot.assurance.verified, false);
  assert(snapshot.assurance.reasons.includes('permission_unverifiable'));
  const incomplete = await snapshotTask(repo, { files: ['a'], directories: [] }, {
    permissionProvider: async () => ({ verified: true, entries: [], reasons: [] }),
  });
  assert.equal(incomplete.assurance.verified, false);
});

test('permission-provider errors and uncertainty cannot attest verified assurance', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a'), 'ok');
  for (const change of [
    result => ({ ...result, entries: result.entries.map(entry => ({ ...entry, error: 'ACL unavailable' })) }),
    result => ({ ...result, reasons: ['permission_unverifiable'] }),
    result => ({ ...result, reasons: 'permission_unverifiable' }),
    result => ({ ...result, reasons: [{ code: 'permission_unverifiable' }] }),
    result => ({ ...result, entries: [...result.entries, { owner: 'missing path' }] }),
  ]) {
    const snapshot = await snapshotTask(repo, { files: ['a'], directories: [] }, {
      permissionProvider: async paths => change(await permissions(paths)),
    });
    assert.equal(snapshot.files[0].text, 'ok');
    assert.equal(snapshot.assurance.verified, false);
    assert(snapshot.assurance.reasons.length > 0);
  }
});

test('default platform permission inspection records every path and ancestor', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a'), 'ok');
  const snapshot = await snapshotTask(repo, { files: ['a'], directories: [] });
  assert(snapshot.permissions.entries.some(entry => entry.path === repo));
  assert(snapshot.permissions.entries.some(entry => entry.path === path.join(repo, 'a')));
  if (process.platform === 'win32') {
    assert.match(snapshot.permissions.principal.userSID, /^S-1-/u);
    assert.deepEqual(snapshot.permissions.principal.groupSIDs, [...new Set(snapshot.permissions.principal.groupSIDs)].sort());
    assert(snapshot.permissions.entries.some(entry => entry.path === repo && typeof entry.dacl === 'string' && entry.dacl.length > 0));
    if (!snapshot.assurance.verified) {
      assert(snapshot.permissions.entries.some(entry => typeof entry.error === 'string'));
      assert(snapshot.assurance.reasons.includes('permission_unverifiable'));
    }
  } else {
    assert.equal(snapshot.assurance.verified, false);
    assert(snapshot.assurance.reasons.includes('posix_acl_unverified'));
    assert(snapshot.permissions.entries.every(entry => Number.isInteger(entry.mode) && Number.isInteger(entry.owner) && Number.isInteger(entry.group)));
  }
});

test('effective principal identity and group membership enter the snapshot fingerprint', async t => {
  const { repo } = await fixture(t);
  await fs.writeFile(path.join(repo, 'a'), 'same bytes');
  const inputs = { files: ['a'], directories: [] };
  const withPrincipal = principal => async paths => ({ ...(await permissions(paths)), principal });
  const original = await snapshotTask(repo, inputs, {
    permissionProvider: withPrincipal({ userSID: 'S-1-5-21-1', groupSIDs: ['S-1-5-32-2', 'S-1-5-32-1'] }),
  });
  const reordered = await snapshotTask(repo, inputs, {
    permissionProvider: withPrincipal({ userSID: 'S-1-5-21-1', groupSIDs: ['S-1-5-32-1', 'S-1-5-32-2', 'S-1-5-32-1'] }),
  });
  assert.equal(original.digest, reordered.digest);
  for (const principal of [
    { userSID: 'S-1-5-21-2', groupSIDs: ['S-1-5-32-1', 'S-1-5-32-2'] },
    { userSID: 'S-1-5-21-1', groupSIDs: ['S-1-5-32-1'] },
  ]) {
    const changed = await snapshotTask(repo, inputs, { permissionProvider: withPrincipal(principal) });
    assert.notEqual(original.digest, changed.digest);
  }
  let calls = 0;
  await assert.rejects(snapshotTask(repo, inputs, {
    permissionProvider: async paths => ({ ...(await permissions(paths)), principal: { userSID: `S-1-5-21-${++calls}`, groupSIDs: [] } }),
  }), { code: 'SNAPSHOT_DRIFT' });
});

test('snapshot rejects directory junctions and linked repository ancestors', async t => {
  const { repo, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'no');
  const linked = path.join(repo, 'linked');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotTask(repo, { files: [], directories: ['.'] }, { permissionProvider: permissions }), { code: 'INPUT_LINK_FORBIDDEN' });
  const alias = path.join(directory, 'repo-alias');
  await fs.symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotTask(alias, { files: [], directories: [] }, { permissionProvider: permissions }), { code: 'INPUT_LINK_FORBIDDEN' });
});

test('cache commits content-addressed records, generations, and reports', async t => {
  const { repo, state } = await fixture(t);
  const store = new CacheStore(state, repo);
  await store.acquire();
  assert.equal((await store.readHead('task')).reason, 'cache_missing');
  const generation = await store.begin('task', 'run-1');
  assert.equal((await store.readHead('task')).reason, 'previous_incomplete');
  const result = record('task', generation);
  const hash = await store.commit('task', generation, result);
  assert.equal(hash, stableDigest(result));
  assert.deepEqual((await store.readHead('task')).record, result);
  assert.equal((await store.readHead('task')).reason, null);
  const report = { schemaVersion: 1, runId: 'run-1', tasks: [{ taskId: 'task', status: 'success' }] };
  await store.writeReport(report);
  assert.deepEqual(await store.readReport('run-1'), report);
  assert.deepEqual(await store.latestReport(), report);
  await store.release();
});

test('a new running or failed generation never falls back to an old successful object', async t => {
  const { repo, state } = await fixture(t);
  const store = new CacheStore(state, repo);
  await store.acquire();
  const first = await store.begin('task', 'run-1');
  await store.commit('task', first, record('task', first));
  const second = await store.begin('task', 'run-2');
  assert.equal((await store.readHead('task')).record, null);
  await assert.rejects(store.commit('task', first, record('task', first)), { code: 'CACHE_GENERATION_MISMATCH' });
  await store.fail('task', second, 'failed', new Error('execution failed'));
  const failed = await store.readHead('task');
  assert.equal(failed.reason, 'previous_failed');
  assert.equal(failed.record, null);
  await store.release();
  const reopened = new CacheStore(state, repo);
  assert.equal((await reopened.readHead('task')).reason, 'previous_failed');
});

test('cache verifies schema and exact stored object bytes and quarantines corruption', async t => {
  const { repo, state } = await fixture(t);
  const store = new CacheStore(state, repo);
  await store.acquire();
  const generation = await store.begin('task', 'run');
  await assert.rejects(store.commit('task', generation, { schemaVersion: 1 }), { code: 'CACHE_RECORD_INVALID' });
  const hash = await store.commit('task', generation, record('task', generation));
  const object = path.join(store.directory, 'objects', `${hash}.json`);
  await fs.appendFile(object, '\n');
  assert.equal((await store.readHead('task', { quarantine: true })).reason, 'cache_corrupt');
  assert.equal((await store.readHead('task')).reason, 'cache_missing');
  assert.equal((await fs.readdir(path.join(store.directory, 'quarantine'))).length, 2);
  await store.release();
});

test('failed atomic writes preserve committed data and clean their temporary files', async t => {
  const { repo, state } = await fixture(t);
  const store = new CacheStore(state, repo);
  await store.acquire();
  const generation = await store.begin('task', 'run');
  const result = record('task', generation);
  await store.commit('task', generation, result);
  const file = store.headPath('task');
  const before = await fs.readFile(file);
  await assert.rejects(store.atomicJson(file, { unsupported: 1n }), TypeError);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await store.readHead('task')).record, result);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
  await store.release();
});

test('cache lock excludes another live writer and checks owner nonce before release', async t => {
  const { repo, state } = await fixture(t);
  const first = new CacheStore(state, repo);
  const second = new CacheStore(state, repo);
  await first.acquire();
  await assert.rejects(second.acquire(), { code: 'CACHE_LOCK_BUSY' });
  const lock = await fs.readFile(first.lockPath);
  await fs.writeFile(first.lockPath, JSON.stringify({ pid: process.pid, nonce: 'other-owner' }));
  await assert.rejects(first.release(), { code: 'CACHE_LOCK_LOST' });
  await fs.writeFile(first.lockPath, lock);
  await first.release();
  await second.acquire();
  await second.release();
});

test('cache recovers only confirmed dead owners and keeps malformed locks busy', async t => {
  const { repo, state } = await fixture(t);
  const store = new CacheStore(state, repo);
  await store.initialize();
  await fs.writeFile(store.lockPath, '{broken');
  await assert.rejects(store.acquire(), { code: 'CACHE_LOCK_BUSY' });
  await fs.writeFile(store.lockPath, JSON.stringify({ pid: 2147483647, host: 'unknown-host', nonce: 'dead-owner' }));
  await assert.rejects(store.acquire(), { code: 'CACHE_LOCK_BUSY' });
  await fs.writeFile(store.lockPath, JSON.stringify({ pid: 2147483647, host: os.hostname(), nonce: 'dead-owner' }));
  let dead = false;
  try { process.kill(2147483647, 0); } catch (cause) { dead = cause.code === 'ESRCH'; }
  if (!dead) { t.skip('Platform cannot positively establish the synthetic PID is dead'); return; }
  await store.acquire();
  await store.release();
});

test('an existing recovery gate keeps stale-lock recovery busy and preserves committed records', async t => {
  const { repo, state } = await fixture(t);
  let dead = false;
  try { process.kill(2147483647, 0); } catch (cause) { dead = cause.code === 'ESRCH'; }
  if (!dead) { t.skip('Platform cannot positively establish the synthetic PID is dead'); return; }
  const store = new CacheStore(state, repo);
  await store.acquire();
  const generation = await store.begin('task', 'run');
  const result = record('task', generation);
  await store.commit('task', generation, result);
  await store.release();
  const staleLock = JSON.stringify({ pid: 2147483647, host: os.hostname(), nonce: 'dead-owner' });
  const gate = `${store.lockPath}.recovery`;
  await fs.writeFile(store.lockPath, staleLock);
  await fs.writeFile(gate, '');
  await assert.rejects(store.acquire(), { code: 'CACHE_LOCK_BUSY' });
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), staleLock);
  assert.equal(await fs.readFile(gate, 'utf8'), '');
  assert.deepEqual((await store.readHead('task')).record, result);
});

test('an abruptly killed writer leaves its durable running head and is recovered without old success fallback', { timeout: 20000 }, async t => {
  const { repo, state } = await fixture(t);
  const initial = new CacheStore(state, repo);
  await initial.acquire();
  const oldGeneration = await initial.begin('task', 'old-run');
  await initial.commit('task', oldGeneration, record('task', oldGeneration));
  await initial.release();

  // Constant child source; module/repository/state paths are JSON data over stdin.
  const childSource = `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const config = JSON.parse(input);
    const { CacheStore } = await import(config.moduleUrl);
    const store = new CacheStore(config.state, config.repo);
    await store.acquire();
    const generation = await store.begin('task', 'crashed-run');
    process.send({ generation });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Crash fixture exited before begin: ${stderr}`)));
  });
  child.stdin.end(JSON.stringify({ moduleUrl: new URL('../src/cache.js', import.meta.url).href, repo, state }));
  try {
    const { generation } = await ready;
    assert.notEqual(generation, oldGeneration);
    assert.equal((await initial.readHead('task')).reason, 'previous_incomplete');
    assert.equal((await initial.readHead('task')).record, null);
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    const recovered = new CacheStore(state, repo);
    await recovered.acquire();
    const interrupted = await recovered.readHead('task');
    assert.equal(interrupted.reason, 'previous_incomplete');
    assert.equal(interrupted.head.generation, generation);
    assert.equal(interrupted.record, null);
    const next = await recovered.begin('task', 'recovery-run');
    await recovered.commit('task', next, record('task', next));
    assert.equal((await recovered.readHead('task')).record.resultVersion, next);
    await recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('cache requires outside state and refuses symlinked storage or objects', async t => {
  const { repo, state, directory } = await fixture(t);
  assert.throws(() => new CacheStore(path.join(repo, 'cache'), repo), { code: 'CACHE_INSIDE_REPOSITORY' });
  await fs.mkdir(state);
  const alias = path.join(directory, 'state-alias');
  await fs.symlink(state, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new CacheStore(alias, repo).acquire(), { code: 'CACHE_LINK_FORBIDDEN' });
  const store = new CacheStore(state, repo);
  await store.acquire();
  const heads = path.join(store.directory, 'heads');
  await fs.rmdir(heads);
  await fs.symlink(repo, heads, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.begin('task', 'run'), { code: 'CACHE_LINK_FORBIDDEN' });
  assert.deepEqual(await fs.readdir(repo), []);
  await store.release();
});

test('cache rejects an ancestor state directory whose repository cache would write into the source', async t => {
  const { directory } = await fixture(t);
  const state = path.join(directory, 'ancestor-state');
  const repo = path.join(state, 'repositories');
  await fs.mkdir(repo, { recursive: true });
  assert.throws(() => new CacheStore(state, repo), { code: 'CACHE_INSIDE_REPOSITORY' });
  assert.deepEqual(await fs.readdir(repo), []);
});
