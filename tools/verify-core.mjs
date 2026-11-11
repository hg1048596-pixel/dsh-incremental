#!/usr/bin/env node
// This entry point only runs the real installed DSH adapter. It has no fixture mode.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPricingChange, prepareExample } from '../src/benchmark.js';
import { createDshExecutor } from '../src/dsh-executor.js';
import { inspectDshRuntime } from '../src/doctor.js';
import { runReview } from '../src/engine.js';

const checkoutRoot = fileURLToPath(new URL('../', import.meta.url));
const taskIds = ['auth', 'pagination', 'pricing', 'summary'];
const sourcePaths = ['src/auth.js', 'src/pagination.js', 'src/pricing.js'];
const stageDefinitions = [
  { id: 'initial', executed: taskIds, reused: [], modelCalls: 4 },
  { id: 'unchanged', executed: [], reused: taskIds, modelCalls: 0 },
  { id: 'pricing-changed', executed: ['pricing', 'summary'], reused: ['auth', 'pagination'], modelCalls: 2 },
];
const credentialReference = 'DSH_INCREMENTAL_CORE_ACCEPTANCE_PRIVATE_KEY';
const reusePolicy = Object.freeze({ mode: 'visible-model', maxAgeMs: 86400000 });
export const defaultRuntimeRoot = process.env.DSH_TEST_RUNTIME_ROOT ?? [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/dsh-app'),
  path.join(homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/dsh-app'),
].find((candidate) => candidate && existsSync(path.join(candidate, 'node_modules/@deepseek-ai/dsh-llm/package.json')));

export const helpText = `Usage: node tools/verify-core.mjs --credential-file PATH [--runtime-root PATH] [--output PATH] [--max-calls 10]

Runs REAL official DeepSeek requests through an existing DSH rc.6 installation.
Explicit invocation approves uploading only the freshly generated builtin example.
Model: deepseek-flash; thinking disabled; reasoning off; 4096 tokens; 120s timeout.
Reuse: visible-model ID, accepting unknown immutable revision, TTL 86400000ms.
Stages: initial 4 executions; unchanged 4 reuses / 0 calls; pricing edit 2 executions + 2 reuses.
One shared call budget (default and maximum 10), durable pre-dispatch ledger, no retries.
Credential file: a private plaintext API key, resolved only in memory; never copied.
Default output: artifacts/core-acceptance/run-*/acceptance.json plus raw stage reports.
Both builtin source snapshots must match the external hash reference before any provider request.
No arbitrary repository input, fixture fallback, source-script execution, or package installation.
This checks actual cache behavior on the builtin example, not review correctness or broad performance.
`;

function fail(code) { return Object.assign(new Error(code), { code, modelCalls: 0 }); }
function errorCode(error) { return /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code ?? '') ? error.code : 'CORE_ACCEPTANCE_FAILED'; }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function childOf(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function writeJson(target, value) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/** Local safety control, unit tested separately. Every reservation is fsynced before execute. */
export async function createDispatchLedger(ledgerPath, max = 10) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10) throw fail('INVALID_CALL_BUDGET');
  const header = await open(ledgerPath, 'wx', 0o600);
  try {
    await header.writeFile(`${JSON.stringify({ type: 'budget', maxDispatchAttempts: max, createdAt: new Date().toISOString() })}\n`);
    await header.sync();
  } finally { await header.close(); }
  let attempts = 0, failed = false, pending = Promise.resolve();
  return {
    get attempts() { return attempts; },
    max,
    reserve(stage, taskId) {
      const reservation = pending.then(async () => {
        if (failed) throw fail('ACCEPTANCE_LEDGER_UNAVAILABLE');
        if (attempts >= max) throw fail('ACCEPTANCE_CALL_BUDGET_EXHAUSTED');
        const number = attempts + 1;
        // r+ forbids silently replacing a missing ledger. The helper is its sole writer.
        let handle;
        try {
          handle = await open(ledgerPath, 'r+');
          const bytes = `${JSON.stringify({ type: 'dispatch-attempt', number, stage, taskId, reservedAt: new Date().toISOString() })}\n`;
          const buffer = Buffer.from(bytes, 'utf8'), position = (await handle.stat()).size;
          let written = 0;
          while (written < buffer.length) {
            const result = await handle.write(buffer, written, buffer.length - written, position + written);
            if (!result.bytesWritten) throw fail('ACCEPTANCE_LEDGER_UNAVAILABLE');
            written += result.bytesWritten;
          }
          await handle.sync();
          attempts = number;
        } catch {
          failed = true;
          throw fail('ACCEPTANCE_LEDGER_UNAVAILABLE');
        } finally { await handle?.close(); }
        return number;
      });
      pending = reservation.catch(() => {});
      return reservation;
    },
  };
}

/** prepareRun returns an execution view, whose execute must also pass the ledger. */
export function withDispatchLedger(executor, ledger, stage, beforeExecute) {
  const wrapped = {
    ...executor,
    async execute(input) {
      await beforeExecute?.(input);
      await ledger.reserve(stage(), input.task.id);
      return executor.execute(input);
    },
  };
  if (typeof executor.prepareRun === 'function') {
    wrapped.prepareRun = async (...args) => withDispatchLedger(await executor.prepareRun(...args), ledger, stage, beforeExecute);
  }
  return wrapped;
}

function stageChecks(report, definition) {
  const tasks = report?.tasks ?? [];
  const statuses = (status) => tasks.filter((task) => task.status === status).map((task) => task.taskId).sort();
  const executed = tasks.filter((task) => task.status === 'executed');
  const reused = tasks.filter((task) => task.status === 'reused');
  return {
    completed: report?.status === 'completed',
    allFourTasksPresent: equal(tasks.map((task) => task.taskId).sort(), taskIds),
    expectedExecutions: equal(statuses('executed'), definition.executed),
    expectedReuses: equal(statuses('reused'), definition.reused),
    expectedModelCalls: report?.totals?.modelCalls === definition.modelCalls,
    realOfficialDshIdentity: report?.executor?.kind === 'dsh' && report.executor.adapter === 'deepseek'
      && report.executor.model?.provider === 'deepseek-official' && report.executor.model?.id === 'deepseek-flash',
    explicitVisibleModelPolicy: equal(report?.reusePolicy, reusePolicy),
    advertisedRouteObserved: report?.identityObservation?.status === 'observed',
    noUnknownCallCounts: report?.totals?.unknownCallCounts === 0,
    noFailedBlockedOrCancelled: ['failed', 'blocked', 'cancelled'].every((key) => report?.totals?.[key] === 0),
    currentSourceValid: tasks.length === 4 && tasks.every((task) => task.currentSourceValid === true),
    perTaskCallsConsistent: tasks.length === 4 && tasks.every((task) => task.modelCalls === (task.status === 'executed' ? 1 : 0)),
    reportedTaskTotalsConsistent: report?.totals?.executed === executed.length && report?.totals?.reused === reused.length,
    allResultsReusable: tasks.length === 4 && tasks.every((task) => task.reuseEligibility?.eligible === true),
    unknownRevisionRisksRecorded: tasks.length === 4 && tasks.every((task) =>
      ['model_revision_unverified', 'provider_update_undetectable'].every((risk) => task.reuseEligibility?.risks?.includes(risk))),
    reusedResultsWithinTtl: reused.every((task) => task.cacheCheck?.status === 'within_window'
      && task.cacheCheck.maxAgeMs === reusePolicy.maxAgeMs && Number.isFinite(task.cacheCheck.ageMs)
      && task.cacheCheck.ageMs >= 0 && task.cacheCheck.ageMs < reusePolicy.maxAgeMs),
    usageRecordedForExecutions: executed.every((task) => Number.isSafeInteger(task.usage?.inputTokens)
      && task.usage.inputTokens >= 0 && Number.isSafeInteger(task.usage?.outputTokens) && task.usage.outputTokens >= 0),
    noNewUsageOnReuse: reused.every((task) => task.usage === null),
  };
}

/** Pure projection for unit tests. Supplied records alone are never real-provider proof. */
export function evaluateCoreAcceptance({ stages, attempts, maxCalls, actualModelCalls, repositoryChecks = {}, error = null }) {
  const projected = stageDefinitions.map((definition) => {
    const stage = stages.find((item) => item.stage === definition.id);
    const checks = stageChecks(stage?.report, definition);
    return {
      stage: definition.id, status: stage?.report ? (Object.values(checks).every(Boolean) ? 'passed' : 'failed') : 'not-run',
      checks, reportPath: stage?.reportPath ?? null, totals: stage?.report?.totals ?? null,
      reusePolicy: stage?.report?.reusePolicy ?? null, identityObservation: stage?.report?.identityObservation ?? null,
      tasks: (stage?.report?.tasks ?? []).map((task) => ({ taskId: task.taskId, status: task.status,
        modelCalls: task.modelCalls, usage: task.usage, resultVersion: task.resultVersion,
        currentSourceValid: task.currentSourceValid, reuseEligibility: task.reuseEligibility,
        reasons: task.reasons, reusedFrom: task.reusedFrom ?? null, cacheCheck: task.cacheCheck ?? null })),
    };
  });
  const reports = Object.fromEntries(stages.map((stage) => [stage.stage, stage.report]));
  const task = (stage, id) => reports[stage]?.tasks?.find((item) => item.taskId === id);
  const initialVersion = (id) => task('initial', id)?.resultVersion;
  const checks = {
    allStagesPassed: projected.every((stage) => stage.status === 'passed'),
    unchangedKeepsAllVersions: taskIds.every((id) => typeof initialVersion(id) === 'string'
      && initialVersion(id).length > 0 && task('unchanged', id)?.resultVersion === initialVersion(id)),
    unaffectedVersionsKept: ['auth', 'pagination'].every((id) => typeof initialVersion(id) === 'string'
      && task('pricing-changed', id)?.resultVersion === initialVersion(id)),
    affectedVersionsReplaced: ['pricing', 'summary'].every((id) => typeof initialVersion(id) === 'string'
      && typeof task('pricing-changed', id)?.resultVersion === 'string'
      && task('pricing-changed', id).resultVersion !== initialVersion(id)),
    exactlySixRealModelCalls: actualModelCalls === 6 && stages.reduce((sum, stage) => sum + (stage.report?.totals?.modelCalls ?? NaN), 0) === 6,
    sixDurableDispatchAttempts: attempts === 6,
    sharedBudgetRespected: Number.isSafeInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 10
      && Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= maxCalls
      && Number.isSafeInteger(actualModelCalls) && actualModelCalls >= 0 && actualModelCalls <= attempts,
    freshRepositoryOutsideCache: repositoryChecks.freshRepositoryOutsideCache === true,
    builtinSourceReferenceValidated: repositoryChecks.builtinSourceReferenceValidated === true,
    initialMatchesBuiltinReference: repositoryChecks.initialMatchesBuiltinReference === true,
    pricingFixedMatchesBuiltinReferenceBeforeProvider: repositoryChecks.pricingFixedMatchesBuiltinReferenceBeforeProvider === true,
    initialSnapshotRestoredBeforeProvider: repositoryChecks.initialSnapshotRestoredBeforeProvider === true,
    providerInputsGuardedByBuiltinHashes: repositoryChecks.providerInputsGuardedByBuiltinHashes === true,
    onlyDeclaredPricingSourceChanged: repositoryChecks.onlyDeclaredPricingSourceChanged === true,
    allConsumedSnapshotsVerified: stages.length === 3 && stages.every((stage) => stage.sourceSnapshotVerified === true),
    noFatalError: error === null,
  };
  return { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, stages: projected };
}

async function sourceSnapshot(repoRoot) {
  return Object.fromEntries(await Promise.all([...sourcePaths, 'review-tasks.json'].map(async (file) => [
    file, createHash('sha256').update(await readFile(path.join(repoRoot, file))).digest('hex'),
  ])));
}

function hashMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && equal(Object.keys(value).sort(), sourcePaths)
    && Object.values(value).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash));
}

/** Project only source hashes; reference findings never enter executor input or reports. */
export function builtinSourceReferences(reference) {
  const names = ['initial', 'pricingFixed'];
  if (reference?.schemaVersion !== 1 || !reference.snapshots || typeof reference.snapshots !== 'object'
    || Array.isArray(reference.snapshots) || !equal(Object.keys(reference.snapshots).sort(), names)) {
    throw fail('INVALID_BUILTIN_SOURCE_REFERENCE');
  }
  const projected = {};
  for (const name of names) {
    const files = reference.snapshots[name]?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || !equal(Object.keys(files).sort(), sourcePaths)) {
      throw fail('INVALID_BUILTIN_SOURCE_REFERENCE');
    }
    const hashes = {};
    for (const file of sourcePaths) {
      const item = files[file];
      if (!item || typeof item !== 'object' || Array.isArray(item) || !equal(Object.keys(item), ['sha256'])) {
        throw fail('INVALID_BUILTIN_SOURCE_REFERENCE');
      }
      hashes[file] = item.sha256;
    }
    if (!hashMap(hashes)) throw fail('INVALID_BUILTIN_SOURCE_REFERENCE');
    projected[name] = Object.freeze(hashes);
  }
  if (projected.initial['src/auth.js'] !== projected.pricingFixed['src/auth.js']
    || projected.initial['src/pagination.js'] !== projected.pricingFixed['src/pagination.js']
    || projected.initial['src/pricing.js'] === projected.pricingFixed['src/pricing.js']) {
    throw fail('INVALID_BUILTIN_SOURCE_REFERENCE');
  }
  return Object.freeze(projected);
}

/** Pure exact-path/hash validator; callers provide source hashes only, without manifest prose. */
export function validateBuiltinSourceHashes(actual, expected) {
  if (!hashMap(actual) || !hashMap(expected)) throw fail('INVALID_BUILTIN_SOURCE_HASHES');
  if (sourcePaths.some((file) => actual[file] !== expected[file])) throw fail('BUILTIN_SOURCE_HASH_MISMATCH');
  return true;
}

/** Check the exact immutable bytes about to reach the adapter, including drift after preflight. */
export function validateBuiltinTaskSources(input, expected) {
  if (!hashMap(expected) || !Array.isArray(input?.snapshot?.files) || !Array.isArray(input.snapshot.directories)
    || input.snapshot.directories.length !== 0 || !Array.isArray(input?.task?.inputs?.files)
    || !equal(input.snapshot.files.map((file) => file.path).sort(), [...input.task.inputs.files].sort())) {
    throw fail('BUILTIN_TASK_SOURCE_INVALID');
  }
  for (const file of input.snapshot.files) {
    if (!sourcePaths.includes(file.path) || file.sha256 !== expected[file.path] || typeof file.text !== 'string'
      || createHash('sha256').update(file.text, 'utf8').digest('hex') !== expected[file.path]) {
      throw fail('BUILTIN_SOURCE_HASH_MISMATCH');
    }
  }
  return true;
}

function sourceHashes(snapshot) {
  return Object.fromEntries(sourcePaths.map((file) => [file, snapshot[file]]));
}

/** Preflight only the fresh copy, restoring its initial bytes before constructing an executor. */
export async function verifyPreparedBuiltinExample({ repoRoot, groundTruthPath }) {
  const repository = await realpath(repoRoot), referencePath = await realpath(groundTruthPath);
  if (childOf(repository, referencePath) || referencePath === repository
    || path.relative(path.join(path.dirname(repository), 'ground-truth.json'), referencePath) !== '') {
    throw fail('BUILTIN_REFERENCE_PATH_INVALID');
  }
  let reference;
  try { reference = JSON.parse(await readFile(referencePath, 'utf8')); }
  catch { throw fail('INVALID_BUILTIN_SOURCE_REFERENCE'); }
  const references = builtinSourceReferences(reference);
  const initialSnapshot = await sourceSnapshot(repository);
  validateBuiltinSourceHashes(sourceHashes(initialSnapshot), references.initial);
  const pricingPath = path.join(repository, 'src', 'pricing.js');
  const pricingBytes = await readFile(pricingPath);
  try {
    await applyPricingChange(repository);
    validateBuiltinSourceHashes(sourceHashes(await sourceSnapshot(repository)), references.pricingFixed);
  } finally { await writeFile(pricingPath, pricingBytes); }
  const restoredSnapshot = await sourceSnapshot(repository);
  validateBuiltinSourceHashes(sourceHashes(restoredSnapshot), references.initial);
  if (!equal(initialSnapshot, restoredSnapshot)) throw fail('BUILTIN_PREFLIGHT_RESTORE_FAILED');
  return { references, initialSnapshot, checks: { builtinSourceReferenceValidated: true,
    initialMatchesBuiltinReference: true, pricingFixedMatchesBuiltinReferenceBeforeProvider: true,
    initialSnapshotRestoredBeforeProvider: true } };
}

/** Real-only entry point: neither executor factories nor permission attestations are injectable. */
export async function verifyCoreAcceptance({ credentialFile, runtimeRoot = defaultRuntimeRoot,
  outputRoot = path.join(checkoutRoot, 'artifacts', 'core-acceptance'), maxCalls = 10 } = {}) {
  if (typeof credentialFile !== 'string' || !credentialFile) throw fail('CREDENTIAL_FILE_REQUIRED');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10) throw fail('INVALID_CALL_BUDGET');
  if (!runtimeRoot) throw fail('EXISTING_DSH_RUNTIME_REQUIRED');
  const privateCredentialPath = await realpath(credentialFile);
  const credentialStat = await stat(privateCredentialPath);
  if (!credentialStat.isFile() || credentialStat.size < 1 || credentialStat.size > 4096) throw fail('INVALID_CREDENTIAL_FILE');
  const runtime = await inspectDshRuntime({ runtimeRoot: path.resolve(runtimeRoot) });
  if (!runtime.compatible || runtime.dshVersion !== '0.1.0-rc.6') throw fail('INCOMPATIBLE_EXISTING_DSH_RUNTIME');
  await mkdir(outputRoot, { recursive: true });
  const artifactDir = await mkdtemp(path.join(await realpath(outputRoot), 'run-'));
  const acceptancePath = path.join(artifactDir, 'acceptance.json');
  const ledgerPath = path.join(artifactDir, 'dispatch-ledger.jsonl');
  const ledger = await createDispatchLedger(ledgerPath, maxCalls);
  const budget = { max: maxCalls, used: 0 };
  const stages = [], repositoryChecks = {};
  let executor, stage = null, fatalError = null, disposed = false;
  const metadata = {
    schemaVersion: 1, evidenceType: 'real-provider-core-acceptance', startedAt: new Date().toISOString(),
    artifactDir, acceptancePath, runtime: { dshVersion: runtime.dshVersion, nodeVersion: runtime.nodeVersion },
    provider: 'deepseek-official', model: 'deepseek-flash',
    connection: { adapter: 'deepseek', baseURL: 'https://api.deepseek.com', thinking: 'disabled', reasoningEffort: 'off' },
    reusePolicy, acceptedRisks: ['model_revision_unverified', 'provider_update_undetectable'],
    controls: { maxTokens: 4096, timeoutMs: 120000, concurrency: 1, retries: 0,
      repository: 'Fresh builtin synthetic example only; no repository source program is executed.',
      credentials: 'Private file resolved in memory through the approved credential dependency; not persisted.',
      dispatchAccounting: 'Each execute attempt is fsynced before invocation; attempts conservatively include any pre-provider rejection.' },
    limitations: ['Passing demonstrates real cache reuse and selective invalidation on this small example only.',
      'It does not establish review correctness, immutable model identity, or performance on arbitrary repositories.',
      'The provider may change an immutable model revision behind the same visible model ID within the TTL.'],
  };
  async function persist(running = true) {
    const evaluated = evaluateCoreAcceptance({ stages, attempts: ledger.attempts, maxCalls, actualModelCalls: budget.used,
      repositoryChecks, error: fatalError });
    const result = { ...metadata, ...evaluated, ...(running ? { status: 'running' } : { finishedAt: new Date().toISOString() }),
      budget: { maxCalls, durableDispatchAttempts: ledger.attempts, executorDispatchedCalls: budget.used, ledger: 'dispatch-ledger.jsonl' },
      repositoryChecks, executorDisposed: disposed, errorCode: fatalError };
    await writeJson(acceptancePath, result);
    return result;
  }
  await persist();
  try {
    const example = await prepareExample({ outputDir: artifactDir });
    const stateDir = path.join(artifactDir, 'state');
    repositoryChecks.freshRepositoryOutsideCache = !childOf(example.repoRoot, stateDir) && !childOf(stateDir, example.repoRoot)
      && example.repoRoot !== stateDir && childOf(artifactDir, example.repoRoot) && childOf(artifactDir, stateDir);
    const { references, initialSnapshot, checks } = await verifyPreparedBuiltinExample(example);
    Object.assign(repositoryChecks, checks);
    const files = example.manifest.tasks.flatMap((task) => task.inputs.files).sort();
    if (!equal(files, sourcePaths) || !equal(example.manifest.tasks.map((task) => task.id).sort(), taskIds)
      || example.manifest.tasks.some((task) => task.inputs.directories.length)) throw fail('BUILTIN_EXAMPLE_SCOPE_CHANGED');
    // Persist known-sample preflight proof before prepareRun can request provider metadata.
    await persist();
    executor = await createDshExecutor({
      runtimeRoot: runtime.runtimeRoot, provider: metadata.provider, model: metadata.model, connection: metadata.connection,
      credentialEnv: credentialReference, approvedRepoRoot: example.repoRoot, allowRemote: true,
      maxTokens: 4096, timeoutMs: 120000, maxRequests: maxCalls, budget, reusePolicy,
    }, {
      async resolveCredential(reference) {
        if (reference !== credentialReference) throw fail('CREDENTIAL_REF_DENIED');
        const credential = (await readFile(privateCredentialPath, 'utf8')).trim();
        if (!/^sk-[A-Za-z0-9_-]+$/u.test(credential)) throw fail('INVALID_CREDENTIAL_FILE');
        return credential;
      },
    });
    if (executor.identity.kind !== 'dsh') throw fail('REAL_DSH_EXECUTOR_REQUIRED');
    const guarded = withDispatchLedger(executor, ledger, () => stage, (input) =>
      validateBuiltinTaskSources(input, stage === 'pricing-changed' ? references.pricingFixed : references.initial));
    repositoryChecks.providerInputsGuardedByBuiltinHashes = true;
    for (const definition of stageDefinitions) {
      stage = definition.id;
      let expectedSnapshot = initialSnapshot;
      if (stage === 'pricing-changed') {
        await applyPricingChange(example.repoRoot);
        const changedSnapshot = await sourceSnapshot(example.repoRoot);
        validateBuiltinSourceHashes(sourceHashes(changedSnapshot), references.pricingFixed);
        repositoryChecks.onlyDeclaredPricingSourceChanged = equal(Object.keys(initialSnapshot).filter((file) => initialSnapshot[file] !== changedSnapshot[file]), ['src/pricing.js']);
        if (!repositoryChecks.onlyDeclaredPricingSourceChanged) throw fail('UNEXPECTED_SOURCE_CHANGE');
        expectedSnapshot = changedSnapshot;
      } else {
        const currentSnapshot = await sourceSnapshot(example.repoRoot);
        validateBuiltinSourceHashes(sourceHashes(currentSnapshot), references.initial);
        if (!equal(currentSnapshot, initialSnapshot)) throw fail('UNEXPECTED_SOURCE_CHANGE');
      }
      const report = await runReview({ repoRoot: example.repoRoot, manifest: example.manifest, stateDir,
        executor: guarded, securityPolicy: { network: 'approved-official-deepseek', sourceExecution: 'denied' } });
      const reportPath = `${stage}.report.json`;
      await writeJson(path.join(artifactDir, reportPath), report);
      const consumed = report.tasks.flatMap((task) => task.inputSnapshot?.files ?? []);
      const sourceSnapshotVerified = equal(await sourceSnapshot(example.repoRoot), expectedSnapshot)
        && consumed.every((file) => expectedSnapshot[file.path] === file.sha256)
        && equal([...new Set(consumed.map((file) => file.path))].sort(), sourcePaths);
      stages.push({ stage, report, reportPath, sourceSnapshotVerified });
      await persist();
      if (!sourceSnapshotVerified) throw fail('CONSUMED_SOURCE_SNAPSHOT_MISMATCH');
      if (!Object.values(stageChecks(report, definition)).every(Boolean)) break;
    }
  } catch (error) { fatalError = errorCode(error); }
  finally {
    if (executor) {
      try { await executor.dispose(); disposed = true; }
      catch { fatalError ??= 'EXECUTOR_DISPOSAL_FAILED'; }
    }
  }
  return persist(false);
}

export function parseCoreArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = {}, names = { '--credential-file': 'credentialFile', '--runtime-root': 'runtimeRoot', '--output': 'outputRoot', '--max-calls': 'maxCalls' };
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(options, key)) throw fail('INVALID_ARGUMENTS');
    options[key] = key === 'maxCalls' ? Number(value) : path.resolve(value);
  }
  if (!options.credentialFile) throw fail('CREDENTIAL_FILE_REQUIRED');
  if (options.maxCalls !== undefined && (!/^\d+$/u.test(String(options.maxCalls)) || options.maxCalls < 1 || options.maxCalls > 10)) throw fail('INVALID_CALL_BUDGET');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCoreArguments(process.argv.slice(2));
    if (options.help) console.log(helpText);
    else {
      const result = await verifyCoreAcceptance(options);
      console.log(JSON.stringify({ status: result.status, acceptancePath: result.acceptancePath, budget: result.budget, checks: result.checks }, null, 2));
      if (result.status !== 'passed') process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', errorCode: errorCode(error), help: 'node tools/verify-core.mjs --help' }));
    process.exitCode = 1;
  }
}
