import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareExample } from '../src/benchmark.js';
import { builtinSourceReferences, createDispatchLedger, evaluateCoreAcceptance, parseCoreArguments,
  validateBuiltinSourceHashes, validateBuiltinTaskSources, verifyPreparedBuiltinExample, withDispatchLedger } from '../tools/verify-core.mjs';

// All tests below exercise local controls/projection with constructed records.
// None makes a provider request or establishes real-model feature acceptance.
const ids = ['auth', 'pagination', 'pricing', 'summary'];
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: 0 };
function records() {
  const definitions = [
    ['initial', ids, []], ['unchanged', [], ids], ['pricing-changed', ['pricing', 'summary'], ['auth', 'pagination']],
  ];
  return definitions.map(([stage, executed, reused]) => ({
    stage, reportPath: `${stage}.report.json`, sourceSnapshotVerified: true, report: {
      status: 'completed',
      executor: { kind: 'dsh', adapter: 'deepseek', model: { provider: 'deepseek-official', id: 'deepseek-flash' } },
      reusePolicy: { mode: 'visible-model', maxAgeMs: 86400000 }, identityObservation: { status: 'observed', requestCount: 1 },
      totals: { executed: executed.length, reused: reused.length, failed: 0, blocked: 0, cancelled: 0,
        modelCalls: executed.length, unknownCallCounts: 0, usage: executed.length ? usage : null },
      tasks: ids.map((taskId) => ({ taskId, status: executed.includes(taskId) ? 'executed' : 'reused',
        modelCalls: executed.includes(taskId) ? 1 : 0, usage: executed.includes(taskId) ? usage : null,
        resultVersion: `${taskId}-${stage === 'pricing-changed' && executed.includes(taskId) ? 'changed' : 'initial'}`,
        currentSourceValid: true, reasons: [], reuseEligibility: { eligible: true, reasons: [],
          risks: ['model_revision_unverified', 'provider_update_undetectable'] },
        cacheCheck: reused.includes(taskId) ? { status: 'within_window', maxAgeMs: 86400000, ageMs: 100 } : null })),
    },
  }));
}
function projection(overrides = {}) {
  return evaluateCoreAcceptance({ stages: records(), attempts: 6, maxCalls: 10, actualModelCalls: 6,
    repositoryChecks: { freshRepositoryOutsideCache: true, onlyDeclaredPricingSourceChanged: true,
      builtinSourceReferenceValidated: true, initialMatchesBuiltinReference: true,
      pricingFixedMatchesBuiltinReferenceBeforeProvider: true, initialSnapshotRestoredBeforeProvider: true,
      providerInputsGuardedByBuiltinHashes: true }, ...overrides });
}
async function temporaryDirectory(t) {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, 'dsh-core-controls-test-'));
  t.after(async () => {
    const relative = path.relative(tempRoot, path.resolve(directory));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function referenceFixture() {
  const files = { 'src/auth.js': { sha256: 'a'.repeat(64) }, 'src/pagination.js': { sha256: 'b'.repeat(64) },
    'src/pricing.js': { sha256: 'c'.repeat(64) } };
  return { schemaVersion: 1, notice: 'Local unit-test reference only', snapshots: {
    initial: { files: structuredClone(files), findings: [{ evidence: 'ANSWER_REFERENCE_MUST_STAY_LOCAL' }] },
    pricingFixed: { files: { ...structuredClone(files), 'src/pricing.js': { sha256: 'd'.repeat(64) } }, findings: [] },
  } };
}

test('local known-sample validator retains hashes only and rejects invalid reference paths or hashes', () => {
  const reference = referenceFixture();
  const projected = builtinSourceReferences(reference);
  assert.equal(JSON.stringify(projected).includes('findings'), false);
  assert.equal(JSON.stringify(projected).includes('ANSWER_REFERENCE_MUST_STAY_LOCAL'), false);
  assert.deepEqual(Object.keys(projected), ['initial', 'pricingFixed']);
  assert(Object.isFrozen(projected) && Object.isFrozen(projected.initial));
  for (const change of [
    (value) => { value.schemaVersion = 2; },
    (value) => { delete value.snapshots.pricingFixed; },
    (value) => { delete value.snapshots.initial.files['src/auth.js']; },
    (value) => { value.snapshots.initial.files['../outside.js'] = { sha256: 'a'.repeat(64) }; },
    (value) => { value.snapshots.initial.files['src\\auth.js'] = value.snapshots.initial.files['src/auth.js']; delete value.snapshots.initial.files['src/auth.js']; },
    (value) => { value.snapshots.initial.files['src/auth.js'].sha256 = 'not-a-hash'; },
    (value) => { value.snapshots.initial.files['src/auth.js'].sha256 = 'A'.repeat(64); },
    (value) => { value.snapshots.initial.files['src/auth.js'].extra = 'not-allowed'; },
    (value) => { value.snapshots.pricingFixed.files['src/auth.js'].sha256 = 'e'.repeat(64); },
    (value) => { value.snapshots.pricingFixed.files['src/pricing.js'].sha256 = value.snapshots.initial.files['src/pricing.js'].sha256; },
  ]) {
    const invalid = structuredClone(reference);
    change(invalid);
    assert.throws(() => builtinSourceReferences(invalid), { code: 'INVALID_BUILTIN_SOURCE_REFERENCE' });
  }
  assert.equal(validateBuiltinSourceHashes(projected.initial, projected.initial), true);
  assert.throws(() => validateBuiltinSourceHashes(projected.initial, projected.pricingFixed), { code: 'BUILTIN_SOURCE_HASH_MISMATCH' });
  assert.throws(() => validateBuiltinSourceHashes({ ...projected.initial, '../outside.js': 'a'.repeat(64) }, projected.initial),
    { code: 'INVALID_BUILTIN_SOURCE_HASHES' });
});

test('local builtin preflight verifies both known snapshots and restores fresh-copy source and manifest', async (t) => {
  const example = await prepareExample({ outputDir: await temporaryDirectory(t) });
  const pricingPath = path.join(example.repoRoot, 'src', 'pricing.js');
  const pricingBefore = await readFile(pricingPath);
  const manifestBefore = await readFile(example.manifestPath);
  const preflight = await verifyPreparedBuiltinExample(example);
  assert(Object.values(preflight.checks).every(Boolean));
  assert.deepEqual(await readFile(pricingPath), pricingBefore);
  assert.deepEqual(await readFile(example.manifestPath), manifestBefore, 'Legitimate manifest descriptions and acceptance fields stay intact');
  assert.equal(JSON.stringify(preflight).includes('findings'), false);
  assert.equal(preflight.references.initial['src/pricing.js'], preflight.initialSnapshot['src/pricing.js']);
  assert.notEqual(preflight.references.initial['src/pricing.js'], preflight.references.pricingFixed['src/pricing.js']);
});

test('local builtin preflight fails changed initial sources and wrong fixed hashes before any executor exists', async (t) => {
  const root = await temporaryDirectory(t);
  const changed = await prepareExample({ outputDir: path.join(root, 'changed-initial') });
  await writeFile(path.join(changed.repoRoot, 'src', 'auth.js'), 'export const unrelated = true;\n');
  await assert.rejects(verifyPreparedBuiltinExample(changed), { code: 'BUILTIN_SOURCE_HASH_MISMATCH' });
  const fixed = await prepareExample({ outputDir: path.join(root, 'wrong-fixed-hash') });
  const pricingPath = path.join(fixed.repoRoot, 'src', 'pricing.js'), before = await readFile(pricingPath);
  const reference = JSON.parse(await readFile(fixed.groundTruthPath, 'utf8'));
  reference.snapshots.pricingFixed.files['src/pricing.js'].sha256 = 'f'.repeat(64);
  await writeFile(fixed.groundTruthPath, JSON.stringify(reference));
  await assert.rejects(verifyPreparedBuiltinExample(fixed), { code: 'BUILTIN_SOURCE_HASH_MISMATCH' });
  assert.deepEqual(await readFile(pricingPath), before, 'Failure still restores initial copied pricing bytes');
  const internalReference = path.join(fixed.repoRoot, 'answer-reference.json');
  await writeFile(internalReference, JSON.stringify(reference));
  await assert.rejects(verifyPreparedBuiltinExample({ ...fixed, groundTruthPath: internalReference }), { code: 'BUILTIN_REFERENCE_PATH_INVALID' });
});

test('local pre-dispatch source guard rejects changed frozen bytes through prepared views without reserving a call', async (t) => {
  const text = 'export const sample = true;\n', sha256 = createHash('sha256').update(text).digest('hex');
  const expected = { ...builtinSourceReferences(referenceFixture()).initial, 'src/auth.js': sha256 };
  const input = { task: { id: 'auth', inputs: { files: ['src/auth.js'] } },
    snapshot: { files: [{ path: 'src/auth.js', sha256, text }], directories: [] } };
  assert.equal(validateBuiltinTaskSources(input, expected), true);
  const changed = structuredClone(input);
  changed.snapshot.files[0].text = 'Unapproved bytes despite a claimed known hash';
  assert.throws(() => validateBuiltinTaskSources(changed, expected), { code: 'BUILTIN_SOURCE_HASH_MISMATCH' });
  const ledger = await createDispatchLedger(path.join(await temporaryDirectory(t), 'ledger.jsonl'), 1);
  let calls = 0;
  const executor = { async execute() { calls++; },
    async prepareRun() { return { execute: executor.execute.bind(executor) }; } };
  const wrapped = withDispatchLedger(executor, ledger, () => 'unit-stage', (value) => validateBuiltinTaskSources(value, expected));
  const prepared = await wrapped.prepareRun();
  await assert.rejects(prepared.execute(changed), { code: 'BUILTIN_SOURCE_HASH_MISMATCH' });
  assert.equal(calls, 0);
  assert.equal(ledger.attempts, 0);
  await prepared.execute(input);
  assert.equal(calls, 1);
  assert.equal(ledger.attempts, 1);
});

test('unit-only projection recognizes expected status, call, version, and source invariants', () => {
  const result = projection();
  assert.equal(result.status, 'passed');
  assert(result.stages.every((stage) => stage.status === 'passed'));
  assert(Object.values(result.checks).every(Boolean));
  assert.deepEqual(result.stages.map((stage) => [stage.totals.executed, stage.totals.reused, stage.totals.modelCalls]), [[4, 0, 4], [0, 4, 0], [2, 2, 2]]);
  assert.equal(result.evidenceType, undefined, 'Pure projection cannot claim real-provider provenance');
});

test('unit-only projection fails hidden calls, stale data, wrong invalidation, and unknown usage', () => {
  const mutate = (fn) => { const stages = records(); fn(stages); return projection({ stages }); };
  for (const result of [
    mutate((stages) => { stages[1].report.tasks[0].modelCalls = 1; }),
    mutate((stages) => { stages[2].report.tasks[0].resultVersion = 'unnecessarily-replaced'; }),
    mutate((stages) => { stages[2].report.tasks[2].resultVersion = 'pricing-initial'; }),
    mutate((stages) => { stages[1].report.tasks[0].currentSourceValid = false; }),
    mutate((stages) => { stages[0].report.tasks[0].usage = null; }),
    mutate((stages) => { stages[0].report.totals.modelCalls = null; stages[0].report.totals.unknownCallCounts = 1; }),
    mutate((stages) => { stages[1].report.tasks[0].cacheCheck.status = 'expired'; }),
    mutate((stages) => { stages[0].report.tasks[0].reuseEligibility.risks = []; }),
    mutate((stages) => { stages[0].report.reusePolicy.mode = 'strict'; }),
    mutate((stages) => { stages[0].report.identityObservation.status = 'unavailable'; }),
    mutate((stages) => { stages[0].sourceSnapshotVerified = false; }),
    projection({ attempts: 5 }), projection({ actualModelCalls: 0 }), projection({ maxCalls: 11 }),
    projection({ error: 'MODEL_REQUEST_FAILED' }), projection({ repositoryChecks: {} }),
  ]) assert.equal(result.status, 'failed');
  const notRun = projection({ stages: [] });
  assert.equal(notRun.status, 'failed');
  assert(notRun.stages.every((stage) => stage.status === 'not-run'));
});

test('local ledger reserves durably before mocked execute and wraps prepared execution views once', async (t) => {
  const ledgerPath = path.join(await temporaryDirectory(t), 'dispatch-ledger.jsonl');
  const ledger = await createDispatchLedger(ledgerPath, 2);
  let calls = 0, prepares = 0;
  const original = { identity: { kind: 'unit-test-only-no-provider' },
    async execute(input) {
      const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(lines.length, calls + 2, 'Reservation is already on disk when execution starts');
      assert.equal(lines.at(-1).taskId, input.task.id);
      calls += 1;
      return { unitOnly: true };
    },
    async prepareRun() {
      prepares += 1;
      return { identity: { kind: 'prepared-unit-view' }, execute: original.execute.bind(original) };
    },
  };
  const wrapped = withDispatchLedger(original, ledger, () => 'unit-stage');
  const view = await wrapped.prepareRun();
  assert.equal(ledger.attempts, 0, 'Preparation must not consume a model-call reservation');
  await view.execute({ task: { id: 'one' } });
  await wrapped.execute({ task: { id: 'two' } });
  await assert.rejects(view.execute({ task: { id: 'three' } }), { code: 'ACCEPTANCE_CALL_BUDGET_EXHAUSTED', modelCalls: 0 });
  assert.equal(calls, 2);
  assert.equal(ledger.attempts, 2);
  assert.equal(prepares, 1);
  const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.slice(1).map(({ number, taskId }) => [number, taskId]), [[1, 'one'], [2, 'two']]);
  assert.equal(lines[0].maxDispatchAttempts, 2);
  await assert.rejects(createDispatchLedger(ledgerPath, 2), { code: 'EEXIST' });
});

test('local ledger conservatively counts failed attempts, serializes reservations and stops if storage disappears', async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = path.join(directory, 'dispatch-ledger.jsonl');
  const ledger = await createDispatchLedger(ledgerPath, 2);
  let calls = 0;
  const wrapped = withDispatchLedger({ async execute() { calls++; throw new Error('unit failure'); } }, ledger, () => 'unit');
  const results = await Promise.allSettled([wrapped.execute({ task: { id: 'one' } }), wrapped.execute({ task: { id: 'two' } }), wrapped.execute({ task: { id: 'three' } })]);
  assert(results.every((result) => result.status === 'rejected'));
  assert.equal(results[2].reason.code, 'ACCEPTANCE_CALL_BUDGET_EXHAUSTED');
  assert.equal(ledger.attempts, 2);
  assert.equal(calls, 2);
  const missingPath = path.join(directory, 'removed-ledger.jsonl');
  const missing = await createDispatchLedger(missingPath, 1);
  await rm(missingPath);
  const guarded = withDispatchLedger({ async execute() { assert.fail('No dispatch without durable ledger'); } }, missing, () => 'unit');
  await assert.rejects(guarded.execute({ task: { id: 'none' } }), { code: 'ACCEPTANCE_LEDGER_UNAVAILABLE' });
  assert.equal(missing.attempts, 0);
});

test('CLI requires a private credential file, disallows other repositories and caps shared budget', () => {
  assert.deepEqual(parseCoreArguments(['--help']), { help: true });
  for (const args of [[], ['--fixture'], ['--repo', '.'], ['--credential-file', 'private', '--max-calls', '11'],
    ['--credential-file', 'private', '--max-calls', '0'], ['--credential-file', 'private', '--max-calls', 'NaN'],
    ['--credential-file', 'private', '--credential-file', 'other']]) {
    assert.throws(() => parseCoreArguments(args));
  }
  const parsed = parseCoreArguments(['--credential-file', 'private', '--max-calls', '10']);
  assert.equal(parsed.maxCalls, 10);
  assert.equal(parsed.credentialFile, path.resolve('private'));
});

test('CLI help exits without provider dispatch, credentials, or artifact creation', async () => {
  const exec = promisify(execFile);
  const result = await exec(process.execPath, [fileURLToPath(new URL('../tools/verify-core.mjs', import.meta.url)), '--help'],
    { windowsHide: true, timeout: 30000 });
  assert.match(result.stdout, /REAL official DeepSeek/);
  assert.match(result.stdout, /default and maximum 10/);
  assert.match(result.stdout, /no retries/);
  assert.equal(result.stderr, '');
});
