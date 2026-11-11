import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { stableDigest } from './snapshot.js';

function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function parentChain(target) {
  const parts = [];
  for (let current = target; ; current = path.dirname(current)) {
    parts.push(current);
    if (current === path.dirname(current)) return parts.reverse();
  }
}

async function safePath(target, { create = false } = {}) {
  for (const candidate of parentChain(target)) {
    let stat;
    try { stat = await fs.lstat(candidate); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      if (!create) return false;
      try { await fs.mkdir(candidate, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(candidate);
    }
    if (stat.isSymbolicLink()) {
      throw failure('CACHE_LINK_FORBIDDEN', `Storage links are forbidden: ${candidate}`);
    }
    if (candidate !== target && !stat.isDirectory()) throw failure('CACHE_PATH_INVALID', `Storage ancestor is not a directory: ${candidate}`);
  }
  if (!samePath(await fs.realpath(target), target)) throw failure('CACHE_LINK_FORBIDDEN', `Redirected storage path is forbidden: ${target}`);
  return true;
}

async function syncDirectory(directory) {
  // Windows cannot open directory handles through Node. File fsync still precedes every rename.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function jsonValue(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
}

function validRecord(record, taskId, generation) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.schemaVersion === 1 && record.taskId === taskId &&
    typeof record.resultVersion === 'string' && record.resultVersion.length > 0 &&
    (!generation || record.resultVersion === generation) && /^[a-f0-9]{64}$/u.test(record.fingerprint) &&
    record.components && typeof record.components === 'object' && !Array.isArray(record.components) &&
    record.output && typeof record.output === 'object' && !Array.isArray(record.output) &&
    record.provenance && typeof record.provenance === 'object' && !Array.isArray(record.provenance) &&
    Array.isArray(record.validation) && record.reuseEligibility && typeof record.reuseEligibility.eligible === 'boolean' &&
    Array.isArray(record.reuseEligibility.reasons) && typeof record.createdAt === 'string';
}

function processDead(pid, host) {
  if (host !== hostname()) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (cause) { return cause.code === 'ESRCH'; }
}

/** Durable single-writer storage. Every running generation supersedes prior success. */
export class CacheStore {
  constructor(stateDir, repoRoot) {
    this.stateDir = path.resolve(stateDir);
    this.repoRoot = path.resolve(repoRoot);
    if (inside(this.repoRoot, this.stateDir)) throw failure('CACHE_INSIDE_REPOSITORY', 'State directory must be outside the target repository');
    this.directory = path.join(this.stateDir, 'repositories', stableDigest({ path: process.platform === 'win32' ? this.repoRoot.toLowerCase() : this.repoRoot }));
    if (inside(this.repoRoot, this.directory)) throw failure('CACHE_INSIDE_REPOSITORY', 'Repository cache directory must be outside the target repository');
    this.lockPath = path.join(this.directory, 'writer.lock');
    this.nonce = null;
  }

  async initialize() {
    await safePath(this.repoRoot);
    // Check existing state ancestors before creating any directories.
    await safePath(this.stateDir);
    const realRepo = await fs.realpath(this.repoRoot);
    let nearest = this.stateDir;
    while (!(await safePath(nearest))) nearest = path.dirname(nearest);
    const resolvedState = path.resolve(await fs.realpath(nearest), path.relative(nearest, this.stateDir));
    if (inside(realRepo, resolvedState)) throw failure('CACHE_INSIDE_REPOSITORY', 'Resolved state directory must be outside target repository');
    const resolvedDirectory = path.resolve(resolvedState, path.relative(this.stateDir, this.directory));
    if (inside(realRepo, resolvedDirectory)) throw failure('CACHE_INSIDE_REPOSITORY', 'Resolved repository cache directory must be outside target repository');
    for (const subdirectory of [this.directory, path.join(this.directory, 'heads'), path.join(this.directory, 'objects'), path.join(this.directory, 'reports'), path.join(this.directory, 'quarantine')]) {
      await safePath(subdirectory, { create: true });
    }
  }

  async acquire() {
    if (this.nonce) throw failure('CACHE_LOCK_BUSY', 'This cache store already owns a writer lock');
    await this.initialize();
    for (let attempt = 0; attempt < 3; attempt++) {
      await safePath(path.dirname(this.lockPath));
      const nonce = randomUUID();
      let handle;
      try {
        handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(canonical({ schemaVersion: 1, pid: process.pid, host: hostname(), nonce, createdAt: new Date().toISOString() }));
        await handle.sync();
        await handle.close();
        handle = null;
        await syncDirectory(this.directory);
        this.nonce = nonce;
        return;
      } catch (cause) {
        if (handle) await handle.close();
        if (cause.code !== 'EEXIST') throw cause;
        await safePath(this.lockPath);
        let owner;
        let original;
        try { original = await fs.readFile(this.lockPath); owner = jsonValue(original); }
        catch { throw failure('CACHE_LOCK_BUSY', 'Writer lock owner cannot be verified'); }
        if (!owner || typeof owner.nonce !== 'string' || !processDead(owner.pid, owner.host)) throw failure('CACHE_LOCK_BUSY', 'Another writer owns the cache, or its liveness is unknown');
        // A separate recovery gate prevents two stale-lock reclaimers from deleting a new writer's lock.
        const gate = `${this.lockPath}.recovery`;
        let recovery;
        try { recovery = await fs.open(gate, 'wx', 0o600); }
        catch { throw failure('CACHE_LOCK_BUSY', 'Another process is recovering the writer lock'); }
        try {
          await safePath(this.lockPath);
          if (!original.equals(await fs.readFile(this.lockPath))) throw failure('CACHE_LOCK_BUSY', 'Writer lock changed while recovering');
          if (!processDead(owner.pid, owner.host)) throw failure('CACHE_LOCK_BUSY', 'Writer owner is no longer confirmed dead');
          await fs.unlink(this.lockPath);
          await syncDirectory(this.directory);
        } finally {
          await recovery.close();
          await fs.unlink(gate);
        }
      }
    }
    throw failure('CACHE_LOCK_BUSY', 'Unable to acquire writer lock');
  }

  async assertOwner() {
    if (!this.nonce) throw failure('CACHE_LOCK_REQUIRED', 'Acquire the cache writer lock first');
    await safePath(this.lockPath);
    let owner;
    try { owner = jsonValue(await fs.readFile(this.lockPath)); }
    catch { throw failure('CACHE_LOCK_LOST', 'Writer lock was lost'); }
    if (owner.pid !== process.pid || owner.nonce !== this.nonce) throw failure('CACHE_LOCK_LOST', 'Writer lock ownership changed');
  }

  async release() {
    if (!this.nonce) return;
    await this.assertOwner();
    await fs.unlink(this.lockPath);
    await syncDirectory(this.directory);
    this.nonce = null;
  }

  headPath(taskId) { return path.join(this.directory, 'heads', `${stableDigest({ taskId })}.json`); }

  async readJson(file) {
    if (!(await safePath(file))) return null;
    return jsonValue(await fs.readFile(file));
  }

  async atomicJson(file, value) {
    await this.assertOwner();
    await safePath(path.dirname(file), { create: true });
    await safePath(file);
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(canonical(value));
        await handle.sync();
      } finally { await handle.close(); }
      await this.assertOwner();
      await safePath(file);
      await fs.rename(temporary, file);
      await syncDirectory(path.dirname(file));
    } catch (cause) {
      if (created) await fs.unlink(temporary).catch(() => {});
      throw cause;
    }
  }

  async quarantine(file) {
    if (!this.nonce) return;
    await this.assertOwner();
    if (!(await safePath(file))) return;
    const destination = path.join(this.directory, 'quarantine', `${path.basename(file)}.${randomUUID()}.corrupt`);
    await safePath(path.dirname(destination));
    await fs.rename(file, destination);
    await syncDirectory(path.dirname(file));
    await syncDirectory(path.dirname(destination));
  }

  async readHead(taskId, { quarantine = false } = {}) {
    const file = this.headPath(taskId);
    let head;
    try { head = await this.readJson(file); }
    catch (cause) {
      if (cause.code === 'CACHE_LINK_FORBIDDEN') throw cause;
      if (quarantine) await this.quarantine(file);
      return { head: null, record: null, reason: 'cache_corrupt' };
    }
    if (!head) return { head: null, record: null, reason: 'cache_missing' };
    if (head.schemaVersion !== 1 || head.taskId !== taskId || typeof head.generation !== 'string' || !head.generation) {
      if (quarantine) await this.quarantine(file);
      return { head: null, record: null, reason: 'cache_corrupt' };
    }
    if (head.status !== 'success') {
      return { head, record: null, reason: head.status === 'running' ? 'previous_incomplete' : 'previous_failed' };
    }
    if (!/^[a-f0-9]{64}$/u.test(head.objectHash)) {
      if (quarantine) await this.quarantine(file);
      return { head: null, record: null, reason: 'cache_corrupt' };
    }
    const objectFile = path.join(this.directory, 'objects', `${head.objectHash}.json`);
    let record;
    let byteHash;
    try {
      if (await safePath(objectFile)) {
        const bytes = await fs.readFile(objectFile);
        byteHash = createHash('sha256').update(bytes).digest('hex');
        record = jsonValue(bytes);
      }
    }
    catch (cause) {
      if (cause.code === 'CACHE_LINK_FORBIDDEN') throw cause;
    }
    if (!validRecord(record, taskId, head.generation) || byteHash !== head.objectHash || stableDigest(record) !== head.objectHash) {
      if (quarantine) { await this.quarantine(objectFile); await this.quarantine(file); }
      return { head: null, record: null, reason: 'cache_corrupt' };
    }
    return { head, record, reason: null };
  }

  async begin(taskId, runId) {
    if (typeof taskId !== 'string' || !taskId || typeof runId !== 'string' || !runId) throw failure('CACHE_RECORD_INVALID', 'Task and run IDs must be nonempty strings');
    const generation = randomUUID();
    await this.atomicJson(this.headPath(taskId), { schemaVersion: 1, taskId, runId, generation, status: 'running', updatedAt: new Date().toISOString() });
    return generation;
  }

  async currentGeneration(taskId, generation) {
    await this.assertOwner();
    const head = await this.readJson(this.headPath(taskId));
    if (!head || head.generation !== generation || head.status !== 'running') throw failure('CACHE_GENERATION_MISMATCH', 'Only the current running generation may be completed');
    return head;
  }

  async commit(taskId, generation, record) {
    if (!validRecord(record, taskId, generation)) throw failure('CACHE_RECORD_INVALID', 'Result record failed schema validation');
    const head = await this.currentGeneration(taskId, generation);
    const objectHash = stableDigest(record);
    const objectFile = path.join(this.directory, 'objects', `${objectHash}.json`);
    // Rewriting a content address is safe and repairs an existing corrupt object.
    await this.atomicJson(objectFile, record);
    await this.currentGeneration(taskId, generation);
    await this.atomicJson(this.headPath(taskId), { ...head, status: 'success', objectHash, updatedAt: new Date().toISOString() });
    return objectHash;
  }

  async fail(taskId, generation, status, error) {
    const head = await this.currentGeneration(taskId, generation);
    if (typeof status !== 'string' || !status || status === 'running' || status === 'success') throw failure('CACHE_RECORD_INVALID', 'Failure status is invalid');
    const detail = typeof error === 'string' ? error : { code: error?.code ?? null, message: error?.message ?? String(error) };
    await this.atomicJson(this.headPath(taskId), { ...head, status, error: detail, updatedAt: new Date().toISOString() });
  }

  async writeReport(report) {
    const runId = report?.runId;
    if (typeof runId !== 'string' || !runId) throw failure('CACHE_REPORT_INVALID', 'Report must have a runId');
    const file = path.join(this.directory, 'reports', `${stableDigest({ runId })}.json`);
    const envelope = { schemaVersion: 1, runId, hash: stableDigest(report), report };
    await this.atomicJson(file, envelope);
    await this.atomicJson(path.join(this.directory, 'latest-report.json'), { schemaVersion: 1, runId });
  }

  async readReport(runId) {
    const envelope = await this.readJson(path.join(this.directory, 'reports', `${stableDigest({ runId })}.json`));
    if (!envelope) return null;
    if (envelope.schemaVersion !== 1 || envelope.runId !== runId || envelope.report?.runId !== runId || envelope.hash !== stableDigest(envelope.report)) {
      throw failure('CACHE_REPORT_CORRUPT', 'Report failed integrity validation');
    }
    return envelope.report;
  }

  async latestReport() {
    const pointer = await this.readJson(path.join(this.directory, 'latest-report.json'));
    if (!pointer) return null;
    if (pointer.schemaVersion !== 1 || typeof pointer.runId !== 'string') throw failure('CACHE_REPORT_CORRUPT', 'Latest report pointer is invalid');
    return this.readReport(pointer.runId);
  }
}
