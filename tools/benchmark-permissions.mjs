// Native Windows-only permission benchmark. No provider, model, network, or npm use.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const execFile = promisify(childProcess.execFile);
const defaultBaseline = 'd32f848609e4be68e03135d4b8e87f7b5f26691e';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function requireChild(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Expected an output path strictly inside the project');
  }
  return child;
}
async function jsonFile(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
async function filesBelow(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(target));
    else if (entry.isFile()) result.push(target);
    else throw new Error('Benchmark inputs must contain only ordinary files and directories');
  }
  return result;
}
async function treeHashes(directory) {
  return Object.fromEntries(await Promise.all((await filesBelow(directory)).map(async target =>
    [path.relative(directory, target).replaceAll('\\', '/'), sha256(await readFile(target))])));
}

function argumentsFor(argv) {
  const options = { output: 'artifacts/permission-benchmark', repetitions: 5, baselineRef: defaultBaseline };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (!['--output', '--repetitions', '--baseline-ref'].includes(key) || seen.has(key)) {
      throw new Error(`Unknown or repeated argument: ${key}`);
    }
    seen.add(key);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--output') options.output = value;
    if (key === '--repetitions') {
      if (!/^[1-9][0-9]?$/u.test(value) || Number(value) > 10) throw new Error('Repetitions must be from 1 through 10');
      options.repetitions = Number(value);
    }
    if (key === '--baseline-ref') {
      if (!/^[a-f0-9]{7,40}$/iu.test(value)) throw new Error('Baseline ref must be a commit hash (7 to 40 hex digits)');
      options.baselineRef = value;
    }
  }
  if (path.isAbsolute(options.output) || /^[a-z]:/iu.test(options.output) || /[\x00-\x1f]/u.test(options.output)) {
    throw new Error('Output must be a project-relative child directory');
  }
  const parts = options.output.replaceAll('\\', '/').split('/');
  if (parts.includes('..')) throw new Error('Output must not contain parent traversal');
  options.output = requireChild(projectRoot, path.resolve(projectRoot, options.output));
  return options;
}

async function materializeBaseline(baselineRoot, commit) {
  const listing = await execFile('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src'], { cwd: projectRoot });
  const names = listing.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert(names.length > 0, 'Baseline src tree is missing');
  await mkdir(baselineRoot);
  await jsonFile(path.join(baselineRoot, 'package.json'), { private: true, type: 'module' });
  for (const name of names) {
    assert(/^src\/[a-z0-9_.\/-]+$/iu.test(name) && !name.split('/').includes('..'), 'Invalid baseline source path');
    const target = requireChild(baselineRoot, path.resolve(baselineRoot, name));
    const { stdout } = await execFile('git', ['show', `${commit}:${name}`], {
      cwd: projectRoot, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024,
    });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, stdout, { flag: 'wx' });
  }
}

async function runWorker(config) {
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [scriptPath, '--internal-worker'], {
      cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errors = [];
    let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Benchmark worker timed out after five minutes')); }, 300_000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) { child.kill(); reject(new Error('Benchmark worker output exceeded limit')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (errors.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) errors.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', cause => { clearTimeout(timer); reject(cause); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Benchmark worker failed (${code}): ${Buffer.concat(errors).toString('utf8').trim()}`));
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Benchmark worker did not return JSON')); }
      }
    });
    child.stdin.end(JSON.stringify(config));
  });
  return { ...result, nodeWallMs: performance.now() - started };
}

async function workerMain() {
  assert.equal(process.platform, 'win32', 'Native Windows assurance is required');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 64 * 1024) throw new Error('Worker input exceeded limit');
  }
  const config = JSON.parse(input);
  let pwshChildren = 0;
  let pwshElapsedMs = 0;
  const nativeSpawn = childProcess.spawn;
  // Observe actual child creation; preserve native calls, arguments, stdin, and output.
  childProcess.spawn = function observedSpawn(command, args, options) {
    const isPwsh = /^pwsh(?:\.exe)?$/iu.test(path.basename(String(command)));
    const start = performance.now();
    const child = Reflect.apply(nativeSpawn, this, [command, args, options]);
    if (isPwsh) {
      pwshChildren += 1;
      child.once('close', () => { pwshElapsedMs += performance.now() - start; });
    }
    return child;
  };
  syncBuiltinESMExports();
  const load = name => import(pathToFileURL(path.join(config.moduleRoot, 'src', name)).href);
  const { snapshotTask, stableDigest } = await load('snapshot.js');
  const manifest = JSON.parse(await readFile(path.join(config.repoRoot, 'review-tasks.json'), 'utf8'));
  if (config.stage === 'metadata') {
    const snapshots = [];
    for (const task of manifest.tasks) {
      const snapshot = await snapshotTask(config.repoRoot, task.inputs);
      assert.equal(snapshot.assurance.verified, true, `Native permission assurance failed for ${task.id}`);
      snapshots.push({ taskId: task.id, verified: snapshot.assurance.verified,
        reasons: snapshot.assurance.reasons, permissionEntries: snapshot.permissions.entries.length,
        permissionSha256: stableDigest(snapshot.permissions), repoIdentitySha256: stableDigest(snapshot.repoIdentity),
        snapshotSha256: snapshot.digest });
    }
    process.stdout.write(JSON.stringify({ snapshots, pwshChildren, pwshElapsedMs }));
    return;
  }
  const { runReview } = await load('engine.js');
  const { createFixtureExecutor } = await load('fixture-executor.js');
  const report = await runReview({ repoRoot: config.repoRoot, manifest,
    executor: createFixtureExecutor(), stateDir: config.stateDir });
  assert.equal(report.status, 'completed');
  assert.equal(report.tasks.length, 4);
  assert(report.tasks.every(task => task.currentSourceValid === true && task.reuseEligibility.eligible === true),
    'Every task must pass native permission assurance and remain reusable');
  for (const field of ['failed', 'blocked', 'cancelled', 'modelCalls', 'unknownCallCounts']) assert.equal(report.totals[field], 0, field);
  const seed = config.stage === 'seed';
  assert.equal(report.totals.executed, seed ? 4 : 0, 'executed tasks');
  assert.equal(report.totals.reused, seed ? 0 : 4, 'reused tasks');
  assert.equal(pwshChildren, seed ? 24 : 16, 'Actual fresh native permission child count');
  process.stdout.write(JSON.stringify({ totals: report.totals, pwshChildren, pwshElapsedMs,
    allTasksReusable: true, allTasksCurrentSourceValid: true,
    tasks: report.tasks.map(task => ({ taskId: task.taskId, status: task.status,
      eligible: task.reuseEligibility.eligible, currentSourceValid: task.currentSourceValid })) }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(samples, variant) {
  const selected = samples.filter(sample => sample.variant === variant);
  return { runs: selected.length,
    nodeWallMedianMs: median(selected.map(sample => sample.nodeWallMs)),
    reviewMedianMs: median(selected.map(sample => sample.totals.totalMs)),
    snapshotMedianMs: median(selected.map(sample => sample.totals.snapshotMs)),
    pwshElapsedMedianMs: median(selected.map(sample => sample.pwshElapsedMs)),
    totalNodeWallMs: selected.reduce((sum, sample) => sum + sample.nodeWallMs, 0),
    totalReviewMs: selected.reduce((sum, sample) => sum + sample.totals.totalMs, 0),
    executed: selected.reduce((sum, sample) => sum + sample.totals.executed, 0),
    reused: selected.reduce((sum, sample) => sum + sample.totals.reused, 0),
    modelCalls: selected.reduce((sum, sample) => sum + sample.totals.modelCalls, 0),
    actualFreshPwshChildren: selected.reduce((sum, sample) => sum + sample.pwshChildren, 0) };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('node tools/benchmark-permissions.mjs [--output artifacts/permission-benchmark] [--repetitions 5] [--baseline-ref COMMIT_HASH]');
    return;
  }
  assert.equal(process.platform, 'win32', 'Run this benchmark on Windows with native pwsh permission access');
  const { stdout } = await execFile('git', ['rev-parse', '--verify', `${options.baselineRef}^{commit}`], { cwd: projectRoot });
  const baselineCommit = stdout.trim();
  assert(/^[a-f0-9]{40}$/u.test(baselineCommit));
  const artifactDir = requireChild(options.output, path.join(options.output,
    `run-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`));
  await mkdir(artifactDir, { recursive: true });
  const baselineRoot = path.join(artifactDir, 'baseline');
  await materializeBaseline(baselineRoot, baselineCommit);
  // Copy only the built-in declared inputs; no repository program is executed.
  const repoRoot = path.join(artifactDir, 'repository');
  await cp(path.join(projectRoot, 'examples', 'demo-repo'), repoRoot, { recursive: true, force: false, errorOnExist: true });
  const originalInputs = await treeHashes(repoRoot);
  const originalCurrentSources = await treeHashes(path.join(projectRoot, 'src'));
  const baselineSources = await treeHashes(path.join(baselineRoot, 'src'));
  const variants = {
    baseline: { moduleRoot: baselineRoot, repoRoot, stateDir: path.join(artifactDir, 'baseline-state') },
    current: { moduleRoot: projectRoot, repoRoot, stateDir: path.join(artifactDir, 'current-state') },
  };
  const metadata = {};
  for (const variant of Object.keys(variants)) metadata[variant] = await runWorker({ ...variants[variant], stage: 'metadata' });
  assert.deepEqual(metadata.current.snapshots, metadata.baseline.snapshots, 'Native snapshot identities and permission metadata must match');
  const preparation = [];
  for (const stage of ['seed', 'warmup']) {
    for (const variant of Object.keys(variants)) {
      const result = await runWorker({ ...variants[variant], stage });
      preparation.push({ stage, variant, ...result });
      console.error(`${stage} ${variant}: ${result.nodeWallMs.toFixed(1)} ms (excluded from samples)`);
    }
  }
  const samples = [];
  for (let pair = 1; pair <= options.repetitions; pair += 1) {
    const order = pair % 2 ? ['baseline', 'current'] : ['current', 'baseline'];
    for (let position = 0; position < order.length; position += 1) {
      const variant = order[position];
      assert.deepEqual(await treeHashes(repoRoot), originalInputs, 'Generated example changed before sample');
      const result = await runWorker({ ...variants[variant], stage: 'sample' });
      const sample = { pair, position: position + 1, variant, ...result };
      samples.push(sample);
      await jsonFile(path.join(artifactDir, `pair-${String(pair).padStart(2, '0')}-${variant}.json`), sample);
      assert.deepEqual(await treeHashes(repoRoot), originalInputs, 'Generated example changed during sample');
      console.error(`pair ${pair} ${variant}: ${result.nodeWallMs.toFixed(1)} ms; reused ${result.totals.reused}; pwsh ${result.pwshChildren}`);
    }
  }
  assert.deepEqual(await treeHashes(path.join(projectRoot, 'src')), originalCurrentSources, 'Current source changed during benchmark');
  assert.deepEqual(await treeHashes(path.join(baselineRoot, 'src')), baselineSources, 'Baseline source changed during benchmark');
  const finalMetadata = {};
  for (const variant of Object.keys(variants)) finalMetadata[variant] = await runWorker({ ...variants[variant], stage: 'metadata' });
  for (const variant of Object.keys(variants)) assert.deepEqual(finalMetadata[variant].snapshots, metadata[variant].snapshots, 'Native snapshot metadata changed during benchmark');
  const baseline = summarize(samples, 'baseline');
  const current = summarize(samples, 'current');
  const report = { schemaVersion: 1, benchmark: 'native-windows-permission-overhead', baselineCommit,
    platform: process.platform, nodeVersion: process.version, completedAt: new Date().toISOString(),
    repetitions: options.repetitions, artifactDir,
    protocol: { fixtureOnly: true, network: 'none', permissionProvider: 'native (no injected provider)',
      concurrency: 1, process: 'Fresh Node process for every seed, warmup, metadata check, and sample',
      permissionProcess: 'Actual native pwsh spawn observed; each unchanged run must spawn 16 fresh children',
      preparation: 'Each variant seeded once, then warmed once; both excluded from sample statistics',
      states: 'Independent baseline/current state directories on one identical unchanged generated example',
      pairOrder: 'Odd pairs baseline/current; even pairs current/baseline',
      identityComparison: 'Native snapshots checked before and after; only metadata digests exported' },
    checks: { nativeSnapshotMetadataEqual: true, nativeAssuranceVerified: true,
      sourceUnchanged: true, generatedExampleUnchanged: true, allSamplesReused4Executed0Calls0: true,
      freshPwshChildrenPerUnchangedRun: 16 },
    sourceHashes: { baseline: baselineSources, current: originalCurrentSources, example: originalInputs },
    metadata, finalMetadata, preparation, samples, totals: { baseline, current },
    observedMedianDifferenceMs: { nodeWall: baseline.nodeWallMedianMs - current.nodeWallMedianMs,
      review: baseline.reviewMedianMs - current.reviewMedianMs,
      snapshot: baseline.snapshotMedianMs - current.snapshotMedianMs },
    limitations: [
      'Small deterministic synthetic fixture; no model quality, provider performance, or production speed claim.',
      'Local observed timings include ordinary machine load and scheduling; no confidence intervals or claimed percentage speedup.',
      'Native state directories contain private ACL/principal provenance and must not be published; share summary/raw sample JSON only.',
    ] };
  await jsonFile(path.join(artifactDir, 'summary.json'), report);
  const lines = ['# Native Windows permission comparison', '',
    `Baseline commit: ${baselineCommit}. Paired unchanged runs: ${options.repetitions}.`, '',
    'Each sample starts a fresh Node process. Seed and one warmup per implementation are excluded. Pair order alternates.', '',
    '| Implementation | Node wall median ms | Review median ms | Snapshot median ms | Executed | Reused | Model calls | Fresh pwsh children |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries({ baseline, current }).map(([name, value]) => `| ${name} | ${value.nodeWallMedianMs.toFixed(2)} | ${value.reviewMedianMs.toFixed(2)} | ${value.snapshotMedianMs.toFixed(2)} | ${value.executed} | ${value.reused} | ${value.modelCalls} | ${value.actualFreshPwshChildren} |`), '',
    `Observed median differences (baseline minus current): Node wall ${report.observedMedianDifferenceMs.nodeWall.toFixed(2)} ms; review ${report.observedMedianDifferenceMs.review.toFixed(2)} ms; snapshot ${report.observedMedianDifferenceMs.snapshot.toFixed(2)} ms.`, '',
    'Native permissions verified; baseline/current identity and permission metadata digests equal before and after; sources unchanged. Every unchanged sample reused four tasks, executed zero, made zero model calls, and spawned 16 fresh permission children.', '',
    '| Pair | Position | Implementation | Node wall ms | Review ms | Snapshot ms | Fresh pwsh children |',
    '| ---: | ---: | --- | ---: | ---: | ---: | ---: |',
    ...samples.map(sample => `| ${sample.pair} | ${sample.position} | ${sample.variant} | ${sample.nodeWallMs.toFixed(2)} | ${sample.totals.totalMs.toFixed(2)} | ${sample.totals.snapshotMs.toFixed(2)} | ${sample.pwshChildren} |`), '',
    ...report.limitations.map(note => `- ${note}`), ''];
  await writeFile(path.join(artifactDir, 'summary.md'), lines.join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ artifactDir, totals: report.totals, observedMedianDifferenceMs: report.observedMedianDifferenceMs, checks: report.checks }, null, 2));
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--internal-worker') await workerMain();
  else await main();
} catch (cause) {
  console.error(cause.stack ?? cause.message);
  process.exitCode = 1;
}
