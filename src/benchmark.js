import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReview } from './engine.js';
import { createFixtureExecutor } from './fixture-executor.js';

const exampleRoot = fileURLToPath(new URL('../examples/', import.meta.url));
const exampleRepo = path.join(exampleRoot, 'demo-repo');
const sourcePaths = ['src/auth.js', 'src/pricing.js', 'src/pagination.js'];
const initialQuantityCheck = 'if (!Number.isInteger(quantity)) {';
const fixedQuantityCheck = 'if (!Number.isInteger(quantity) || quantity < 0) {';

export const exampleManifest = JSON.parse(await readFile(path.join(exampleRepo, 'review-tasks.json'), 'utf8'));

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Expected a child path inside ${parent}`);
  }
}

async function ensureAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite an existing example repository: ${target}`);
}

/** Copy only review inputs into a new repository; reference findings stay outside it. */
export async function prepareExample({ outputDir } = {}) {
  if (!outputDir) throw new TypeError('prepareExample requires outputDir');
  const artifactDir = path.resolve(outputDir);
  const repoRoot = path.join(artifactDir, 'repository');
  assertInside(artifactDir, repoRoot);
  await ensureAbsent(repoRoot);
  await mkdir(artifactDir, { recursive: true });
  await cp(exampleRepo, repoRoot, { recursive: true, errorOnExist: true, force: false });
  const groundTruthPath = path.join(artifactDir, 'ground-truth.json');
  await copyFile(path.join(exampleRoot, 'ground-truth.json'), groundTruthPath, constants.COPYFILE_EXCL);
  return {
    artifactDir,
    repoRoot,
    manifestPath: path.join(repoRoot, 'review-tasks.json'),
    manifest: structuredClone(exampleManifest),
    groundTruthPath,
  };
}

/** Change one source file. No repository program is executed. */
export async function applyPricingChange(repoRoot) {
  const target = path.join(path.resolve(repoRoot), 'src', 'pricing.js');
  assertInside(repoRoot, target);
  const original = await readFile(target, 'utf8');
  if (original.split(initialQuantityCheck).length !== 2 || original.includes(fixedQuantityCheck)) {
    throw new Error('The pricing source does not match the declared initial snapshot');
  }
  await writeFile(target, original.replace(initialQuantityCheck, fixedQuantityCheck));
}

async function captureSourceSnapshot(repoRoot) {
  const entries = await Promise.all(sourcePaths.map(async (relativePath) => {
    const bytes = await readFile(path.join(repoRoot, relativePath));
    return [relativePath, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
  }));
  const manifestBytes = await readFile(path.join(repoRoot, 'review-tasks.json'));
  return {
    files: Object.fromEntries(entries),
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

function verifyDeclaredSnapshot(actual, expected, label) {
  for (const [relativePath, expectedFile] of Object.entries(expected.files)) {
    if (actual.files[relativePath]?.sha256 !== expectedFile.sha256) {
      throw new Error(`Example ${label} snapshot mismatch: ${relativePath}`);
    }
  }
}

async function verifyStageSnapshot(example, expected, manifestSha256, label) {
  const actual = await captureSourceSnapshot(example.repoRoot);
  verifyDeclaredSnapshot(actual, expected, label);
  if (actual.manifestSha256 !== manifestSha256) throw new Error(`Example ${label} manifest snapshot mismatch`);
}

function verifyConsumedSnapshot(report, expected, label) {
  const consumed = new Map();
  for (const task of report.tasks) {
    if (['executed', 'reused'].includes(task.status) && !task.inputSnapshot) {
      throw new Error(`Example ${label} consumed snapshot missing: ${task.taskId}`);
    }
    for (const file of task.inputSnapshot?.files ?? []) {
      if (expected.files[file.path]?.sha256 !== file.sha256) {
        throw new Error(`Example ${label} consumed snapshot mismatch: ${file.path}`);
      }
      consumed.set(file.path, file.sha256);
    }
  }
  return {
    complete: Object.keys(expected.files).every((filePath) => consumed.has(filePath)),
    files: Object.fromEntries(consumed),
  };
}

function findingKey(finding) {
  return JSON.stringify([
    String(finding.path).replaceAll('\\', '/'),
    finding.line,
    typeof finding.evidence === 'string' ? finding.evidence.trim() : finding.evidence,
  ]);
}

/** This is a fixed source-location check, not semantic adjudication of all findings. */
export function scoreReport(report, expectedSnapshot) {
  const summary = report.tasks.find((task) => task.taskId === 'summary');
  const usable = summary?.currentSourceValid !== false && (!summary?.status || ['executed', 'reused'].includes(summary.status));
  const findings = usable ? summary?.output?.findings ?? [] : [];
  const expectedByKey = new Map(expectedSnapshot.findings.map((finding) => [findingKey(finding), finding]));
  const observedByKey = new Map(findings.map((finding) => [findingKey(finding), finding]));
  const matched = expectedSnapshot.findings.filter((finding) => observedByKey.has(findingKey(finding)));
  return {
    method: 'Exact normalized path, one-based line, and trimmed source-evidence equality; titles are not scored.',
    summaryAvailable: Array.isArray(summary?.output?.findings),
    summaryCurrentSourceValid: summary?.currentSourceValid ?? null,
    expectedCount: expectedSnapshot.findings.length,
    observedUniqueCount: observedByKey.size,
    matchedCount: matched.length,
    knownFindingCoverage: expectedSnapshot.findings.length ? matched.length / expectedSnapshot.findings.length : null,
    matchedIds: matched.map((finding) => finding.id),
    missingIds: expectedSnapshot.findings.filter((finding) => !observedByKey.has(findingKey(finding))).map((finding) => finding.id),
    unmatchedFindings: [...observedByKey].filter(([key]) => !expectedByKey.has(key)).map(([, finding]) => finding),
  };
}

function comparison(full, incremental) {
  if (!full || !incremental) return null;
  const summaryKeys = (report) => {
    const summary = report.tasks.find((task) => task.taskId === 'summary');
    if (!summary?.output || !['executed', 'reused'].includes(summary.status) || summary.currentSourceValid === false) return null;
    return [...new Set(summary.output.findings.map(findingKey))].sort();
  };
  const fullEvidence = summaryKeys(full), incrementalEvidence = summaryKeys(incremental);
  const fullCalls = full.totals.modelCalls, incrementalCalls = incremental.totals.modelCalls;
  const callsKnown = Number.isFinite(fullCalls) && Number.isFinite(incrementalCalls);
  return {
    exactSummaryEvidenceEqual: fullEvidence === null || incrementalEvidence === null ? null : JSON.stringify(fullEvidence) === JSON.stringify(incrementalEvidence),
    executedTaskReduction: full.totals.executed - incremental.totals.executed,
    modelCallReduction: callsKnown ? fullCalls - incrementalCalls : null,
    modelCallReductionFraction: callsKnown && fullCalls > 0 ? (fullCalls - incrementalCalls) / fullCalls : null,
    observedWallTimeDifferenceMs: full.totals.totalMs - incremental.totals.totalMs,
  };
}

async function newArtifactDirectory(outputDir, prefix) {
  const parent = path.resolve(outputDir ?? path.join(process.cwd(), 'artifacts'));
  await mkdir(parent, { recursive: true });
  const child = path.join(parent, `${prefix}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  assertInside(parent, child);
  await mkdir(child);
  return child;
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function getExecutor(executorFactory, context) {
  return executorFactory ? executorFactory(context) : createFixtureExecutor();
}

async function disposeExecutors(executors) {
  const results = await Promise.allSettled([...executors].map(async (executor) => executor.dispose?.()));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Benchmark executor cleanup failed');
}

function withDispatchBudget(executor, budget) {
  if (!executor || typeof executor.execute !== 'function') throw new TypeError('executorFactory must return an executor');
  return {
    identity: executor.identity,
    reuseEligibility: executor.reuseEligibility,
    async execute(input) {
      if (executor.identity?.kind !== 'fixture') {
        if (budget.dispatched >= budget.max) {
          const error = new Error(`Benchmark model-call dispatch budget exhausted (${budget.max})`);
          error.code = 'BENCHMARK_MODEL_CALL_BUDGET_EXHAUSTED';
          error.modelCalls = 0;
          throw error;
        }
        // Non-fixture executors must make at most one provider request per execute,
        // including failures, and must not retry internally.
        budget.dispatched += 1;
      }
      return executor.execute(input);
    },
  };
}

function sumUsage(reports) {
  if (reports.some((report) => report.totals.modelCalls !== 0 && report.totals.usage == null)) return null;
  const usages = reports.map((report) => report.totals.usage).filter((usage) => usage !== null && usage !== undefined);
  if (!usages.length) return null;
  function aggregate(objects) {
    return Object.fromEntries([...new Set(objects.flatMap(Object.keys))].map((key) => {
      const values = objects.map((object) => object[key]);
      if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return [key, values.reduce((sum, value) => sum + value, 0)];
      }
      if (values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
        return [key, aggregate(values)];
      }
      return [key, null];
    }));
  }
  return aggregate(usages);
}

function aggregateTotals(reports) {
  const unknownCallCounts = reports.reduce((sum, report) => sum + (report.totals.unknownCallCounts ?? (report.totals.modelCalls == null ? 1 : 0)), 0);
  const knownModelCalls = reports.reduce((sum, report) => sum + (report.totals.knownModelCalls ?? report.totals.modelCalls ?? 0), 0);
  return {
    runs: reports.length,
    modelCalls: unknownCallCounts > 0 || reports.some((report) => report.totals.modelCalls == null) ? null : knownModelCalls,
    knownModelCalls,
    unknownCallCounts,
    usage: sumUsage(reports),
    runsWithUsage: reports.filter((report) => report.totals.usage != null).length,
    totalMs: reports.reduce((sum, report) => sum + report.totals.totalMs, 0),
    executed: reports.reduce((sum, report) => sum + report.totals.executed, 0),
    reused: reports.reduce((sum, report) => sum + report.totals.reused, 0),
  };
}

function limitationText(mode, { pairedOnly = false } = {}) {
  const notes = [
    'The three-module synthetic repository and one pricing edit are a small mechanism experiment, not evidence of performance on arbitrary repositories.',
    'Only declared task inputs and declared dependency edges determine invalidation. Undeclared semantic dependencies require a broader manifest or an explicit full run.',
    'Finding scoring checks pre-fixed path/line/evidence references. Unmatched findings are retained for review and are not automatically false positives; the check is not a complete semantic adjudication.',
    `Wall times are observed locally without warm-up correction, confidence intervals, or claims about production speed. ${pairedOnly ? 'The single supplementary pair runs full review first, so ordering effects are not controlled.' : 'Pair order alternates to reduce a single ordering confound.'}`,
    'Usage is the executor/provider-reported usage only. Missing usage remains null; no cost or token estimates are invented.',
    'A real-model executor must make at most one provider call per execute and perform no retries. The benchmark also caps non-fixture execute dispatches centrally.',
  ];
  if (mode === 'fixture') {
    notes.unshift('Fixture mode uses a deterministic rule-based synthetic analyzer, not AI. Zero model calls and null token usage cannot establish model cost savings or AI review quality.');
  } else {
    notes.unshift('Strict real-model executors may disable cache reuse when their model/revision identity cannot be pinned. Zero reuse in that mode is the intended conservative behavior.');
  }
  return notes;
}

function renderBenchmarkMarkdown(report) {
  const lines = [
    '# Incremental review experiment', '',
    `Mode: **${report.mode}**. Repetitions: ${report.repetitions}. Concurrency: 1. Retries: 0.`, '',
    ...(report.protocol ? [`Protocol: **${report.protocol.id}**. ${report.protocol.description}`, ''] : []),
    report.mode === 'fixture' ? '**This is a deterministic synthetic mechanism test, not an AI benchmark.**' : 'Provider calls require the separately configured real executor and explicit provider/data approval.', '',
    '| Repetition | Stage | Executed | Reused | Failed/blocked | Model calls | Usage | Total ms | Known findings |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |',
  ];
  for (const trial of report.trials) {
    for (const stage of trial.stages) {
      const total = stage.totals;
      lines.push(`| ${trial.repetition} | ${stage.stage} | ${total.executed} | ${total.reused} | ${total.failed + total.blocked} | ${total.modelCalls ?? 'unknown'} | ${total.usage == null ? 'null' : 'recorded in JSON'} | ${Number(total.totalMs).toFixed(2)} | ${stage.score.matchedCount}/${stage.score.expectedCount} |`);
    }
  }
  lines.push('', `Reported model calls: ${report.totals.modelCalls ?? 'unknown'}. Known calls: ${report.totals.knownModelCalls}; tasks with unknown call counts: ${report.totals.unknownCallCounts}. Non-fixture dispatches: ${report.budget.dispatched}/${report.budget.max}.`, '',
    'Raw run reports, declared snapshots, stage executor identities, individual phase timings, provider usage, and fixed-reference scoring are retained in the JSON artifacts.', '',
    '## Limits', '', ...report.limitations.map((note) => `- ${note}`), '');
  return lines.join('\n');
}

/** Run paired full/incremental reviews on identical changed snapshots. No real model is selected implicitly. */
export async function runBenchmark({ outputDir, executorFactory, repetitions = 3, maxModelCalls = 48, signal, securityPolicy, permissionProvider } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new RangeError('repetitions must be a positive integer');
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 48) throw new RangeError('maxModelCalls must be an integer from 0 to 48');
  if (repetitions > 3 && executorFactory) throw new RangeError('Real-executor benchmark repetitions must not exceed 3');
  const artifactDir = await newArtifactDirectory(outputDir, 'benchmark');
  const budget = { max: maxModelCalls, dispatched: 0 };
  const executors = new Set();
  const rawReports = [];
  const trials = [];
  try {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      if (signal?.aborted) break;
      const trialDir = path.join(artifactDir, `repetition-${String(repetition).padStart(2, '0')}`);
      const example = await prepareExample({ outputDir: trialDir });
      const truth = JSON.parse(await readFile(example.groundTruthPath, 'utf8'));
      const initial = await captureSourceSnapshot(example.repoRoot);
      verifyDeclaredSnapshot(initial, truth.snapshots.initial, 'initial');
      const trial = { repetition, initialSnapshot: initial, changedSnapshot: null, stages: [], changedPairOrder: repetition % 2 ? ['modified-full', 'modified-incremental'] : ['modified-incremental', 'modified-full'] };
      trials.push(trial);
      const stageReports = new Map();
      async function stageRun(stage, snapshotName, full = false) {
        if (signal?.aborted) return;
        const executor = await getExecutor(executorFactory, { repetition, stage, repoRoot: example.repoRoot });
        executors.add(executor);
        if (signal?.aborted) return;
        await verifyStageSnapshot(example, truth.snapshots[snapshotName], initial.manifestSha256, stage);
        const report = await runReview({
          repoRoot: example.repoRoot,
          manifest: example.manifest,
          executor: withDispatchBudget(executor, budget),
          stateDir: path.join(trialDir, full ? 'full-state' : 'incremental-state'),
          full,
          signal,
          ...(permissionProvider === undefined ? {} : { permissionProvider }),
          ...(securityPolicy === undefined ? {} : { securityPolicy }),
        });
        const rawReportPath = path.join(trialDir, `${stage}.report.json`);
        await writeJson(rawReportPath, report);
        rawReports.push(report);
        stageReports.set(stage, report);
        const consumedSnapshot = verifyConsumedSnapshot(report, truth.snapshots[snapshotName], stage);
        await verifyStageSnapshot(example, truth.snapshots[snapshotName], initial.manifestSha256, stage);
        trial.stages.push({
          stage,
          full,
          sourceSnapshot: snapshotName,
          executorIdentity: executor.identity,
          reuseEligibility: executor.reuseEligibility,
          status: report.status,
          totals: report.totals,
          score: scoreReport(report, truth.snapshots[snapshotName]),
          consumedSnapshot,
          rawReportPath: path.relative(artifactDir, rawReportPath).replaceAll('\\', '/'),
        });
      }
      await stageRun('seed-incremental', 'initial');
      await stageRun('unchanged-incremental', 'initial');
      if (!signal?.aborted) {
        await applyPricingChange(example.repoRoot);
        trial.changedSnapshot = await captureSourceSnapshot(example.repoRoot);
        verifyDeclaredSnapshot(trial.changedSnapshot, truth.snapshots.pricingFixed, 'pricingFixed');
        for (const stage of trial.changedPairOrder) await stageRun(stage, 'pricingFixed', stage === 'modified-full');
      }
      trial.comparison = comparison(stageReports.get('modified-full'), stageReports.get('modified-incremental'));
    }
  } finally {
    await disposeExecutors(executors);
  }
  const modes = new Set(trials.flatMap((trial) => trial.stages.map((stage) => stage.executorIdentity?.kind === 'fixture' ? 'fixture' : 'real')));
  const mode = modes.size === 1 ? [...modes][0] : modes.size ? 'mixed' : 'unknown';
  const identities = trials.flatMap((trial) => trial.stages.map((stage) => JSON.stringify(stage.executorIdentity)));
  const report = {
    schemaVersion: 1,
    kind: 'dsh-incremental-benchmark',
    createdAt: new Date().toISOString(),
    mode,
    repetitions: trials.length,
    requestedRepetitions: repetitions,
    cancelled: Boolean(signal?.aborted),
    controls: {
      concurrency: 1,
      retries: 0,
      changedFiles: ['src/pricing.js'],
      changedPairOrder: 'alternate full/incremental order per repetition',
      fullAndIncrementalUseIdenticalChangedSnapshot: trials.length > 0 && trials.every((trial) => trial.stages.filter((stage) => stage.sourceSnapshot === 'pricingFixed' && stage.consumedSnapshot.complete).length === 2) ? true : null,
      separateFullAndIncrementalStateDirectories: true,
      executorIdentityConsistent: identities.length ? new Set(identities).size <= 1 : null,
      groundTruthOutsideReviewedRepository: true,
      permissionVerification: permissionProvider ? 'injected-provider' : 'native',
    },
    budget,
    totals: aggregateTotals(rawReports),
    trials,
    limitations: limitationText(mode),
  };
  const reportPath = path.join(artifactDir, 'benchmark.json');
  const markdownPath = path.join(artifactDir, 'benchmark.md');
  await writeJson(reportPath, report);
  await writeFile(markdownPath, renderBenchmarkMarkdown(report));
  return { artifactDir, reportPath, markdownPath, report };
}

/** A separate, unseeded full/incremental pair for the explicit-line-number request experiment. */
export async function runPairedBenchmark({ outputDir, executorFactory, signal, permissionProvider, securityPolicy, maxModelCalls = 8 } = {}) {
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 8) throw new RangeError('Supplementary maxModelCalls must be an integer from 0 to 8');
  const artifactDir = await newArtifactDirectory(outputDir, 'supplemental-numbered-lines-pair');
  const trialDir = path.join(artifactDir, 'repetition-01');
  const example = await prepareExample({ outputDir: trialDir });
  const truth = JSON.parse(await readFile(example.groundTruthPath, 'utf8'));
  const initial = await captureSourceSnapshot(example.repoRoot);
  verifyDeclaredSnapshot(initial, truth.snapshots.initial, 'initial');
  await applyPricingChange(example.repoRoot);
  const changed = await captureSourceSnapshot(example.repoRoot);
  verifyDeclaredSnapshot(changed, truth.snapshots.pricingFixed, 'pricingFixed');
  const budget = { max: maxModelCalls, dispatched: 0 };
  const executors = new Set(), rawReports = [];
  const trial = { repetition: 1, initialSnapshot: initial, changedSnapshot: changed, stages: [], changedPairOrder: ['modified-full', 'modified-incremental'] };
  try {
    for (const stage of trial.changedPairOrder) {
      if (signal?.aborted) break;
      const executor = await getExecutor(executorFactory, { repetition: 1, stage, repoRoot: example.repoRoot });
      executors.add(executor);
      if (signal?.aborted) break;
      await verifyStageSnapshot(example, truth.snapshots.pricingFixed, initial.manifestSha256, stage);
      const full = stage === 'modified-full';
      const report = await runReview({
        repoRoot: example.repoRoot,
        manifest: example.manifest,
        executor: withDispatchBudget(executor, budget),
        stateDir: path.join(trialDir, full ? 'full-state' : 'incremental-state'),
        full,
        signal,
        ...(permissionProvider === undefined ? {} : { permissionProvider }),
        ...(securityPolicy === undefined ? {} : { securityPolicy }),
      });
      const rawReportPath = path.join(trialDir, `${stage}.report.json`);
      await writeJson(rawReportPath, report);
      rawReports.push(report);
      const consumedSnapshot = verifyConsumedSnapshot(report, truth.snapshots.pricingFixed, stage);
      await verifyStageSnapshot(example, truth.snapshots.pricingFixed, initial.manifestSha256, stage);
      trial.stages.push({
        stage, full, sourceSnapshot: 'pricingFixed', executorIdentity: executor.identity,
        reuseEligibility: executor.reuseEligibility, status: report.status, totals: report.totals,
        score: scoreReport(report, truth.snapshots.pricingFixed),
        consumedSnapshot,
        rawReportPath: path.relative(artifactDir, rawReportPath).replaceAll('\\', '/'),
      });
    }
  } finally {
    await disposeExecutors(executors);
  }
  trial.comparison = comparison(rawReports[0], rawReports[1]);
  const modes = new Set(trial.stages.map((stage) => stage.executorIdentity?.kind === 'fixture' ? 'fixture' : 'real'));
  const mode = modes.size === 1 ? [...modes][0] : modes.size ? 'mixed' : 'unknown';
  const report = {
    schemaVersion: 1,
    kind: 'dsh-incremental-benchmark',
    protocol: {
      id: 'supplemental-numbered-lines-pair-v1',
      description: 'Single independent-state pair on the modified snapshot, using explicit source line numbers in requests.',
      supplementary: true,
      seededIncrementalState: false,
      relationshipToBaseline: 'Separate follow-up protocol; do not pool with baseline measurements or infer seeded cache savings.',
    },
    createdAt: new Date().toISOString(), mode, repetitions: trial.stages.length ? 1 : 0, requestedRepetitions: 1,
    cancelled: Boolean(signal?.aborted),
    controls: {
      concurrency: 1, retries: 0, changedFiles: ['src/pricing.js'],
      changedPairOrder: 'full then incremental; a single supplementary pair',
      fullAndIncrementalUseIdenticalChangedSnapshot: trial.stages.length === 2 && trial.stages.every((stage) => stage.consumedSnapshot.complete) ? true : null,
      separateFullAndIncrementalStateDirectories: true,
      seededIncrementalState: false,
      requestPresentation: 'explicit source line numbers',
      executorIdentityConsistent: trial.stages.length ? new Set(trial.stages.map((stage) => JSON.stringify(stage.executorIdentity))).size <= 1 : null,
      groundTruthOutsideReviewedRepository: true,
      permissionVerification: permissionProvider ? 'injected-provider' : 'native',
    },
    budget, totals: aggregateTotals(rawReports), trials: trial.stages.length ? [trial] : [],
    limitations: [
      'This supplementary protocol has no seed or unchanged stage. Both independent state directories begin empty, so it does not measure incremental reuse benefit.',
      'The request presentation changed to expose explicit source line numbers. This single pair is reported separately from any prior baseline and does not replace failed baseline results.',
      ...limitationText(mode, { pairedOnly: true }),
    ],
  };
  const reportPath = path.join(artifactDir, 'benchmark.json'), markdownPath = path.join(artifactDir, 'benchmark.md');
  await writeJson(reportPath, report);
  await writeFile(markdownPath, renderBenchmarkMarkdown(report));
  return { artifactDir, reportPath, markdownPath, report };
}

/** Show a seed run, an unchanged run, and a pricing-only edit using the synthetic fixture. */
export async function runDemo({ outputDir, signal, securityPolicy, permissionProvider } = {}) {
  const artifactDir = await newArtifactDirectory(outputDir, 'demo');
  const example = await prepareExample({ outputDir: artifactDir });
  const truth = JSON.parse(await readFile(example.groundTruthPath, 'utf8'));
  const executor = createFixtureExecutor();
  const runs = [];
  for (const [stage, snapshotName] of [['initial', 'initial'], ['unchanged', 'initial'], ['pricing-changed', 'pricingFixed']]) {
    if (signal?.aborted) break;
    if (stage === 'pricing-changed') await applyPricingChange(example.repoRoot);
    verifyDeclaredSnapshot(await captureSourceSnapshot(example.repoRoot), truth.snapshots[snapshotName], snapshotName);
    const report = await runReview({
      repoRoot: example.repoRoot,
      manifest: example.manifest,
      executor,
      stateDir: path.join(artifactDir, 'state'),
      signal,
      ...(permissionProvider === undefined ? {} : { permissionProvider }),
      ...(securityPolicy === undefined ? {} : { securityPolicy }),
    });
    await writeJson(path.join(artifactDir, `${stage}.report.json`), report);
    runs.push({ stage, report, score: scoreReport(report, truth.snapshots[snapshotName]) });
  }
  const report = {
    schemaVersion: 1,
    kind: 'dsh-incremental-demo',
    mode: 'fixture',
    notice: 'Deterministic rule-based synthetic demonstration, not an AI review.',
    cancelled: Boolean(signal?.aborted),
    expected: [
      { stage: 'initial', executed: 4, reused: 0 },
      { stage: 'unchanged', executed: 0, reused: 4 },
      { stage: 'pricing-changed', executed: 2, reused: 2 },
    ],
    runs,
    limitations: limitationText('fixture'),
  };
  const reportPath = path.join(artifactDir, 'demo.json');
  const markdownPath = path.join(artifactDir, 'demo.md');
  await writeJson(reportPath, report);
  await writeFile(markdownPath, [
    '# Incremental review demonstration', '',
    report.notice, '',
    '| Stage | Executed | Reused | Known findings |', '| --- | ---: | ---: | --- |',
    ...runs.map(({ stage, report: run, score }) => `| ${stage} | ${run.totals.executed} | ${run.totals.reused} | ${score.matchedCount}/${score.expectedCount} |`),
    '', 'Only the pricing file changes. The dependency edge invalidates the aggregate summary.', '',
    ...report.limitations.map((note) => `- ${note}`), '',
  ].join('\n'));
  return { artifactDir, reportPath, markdownPath, report };
}
