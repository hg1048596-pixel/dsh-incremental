import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareExample, runBenchmark, runPairedBenchmark, runDemo, scoreReport } from '../src/benchmark.js';
import { createFixtureExecutor } from '../src/fixture-executor.js';

const permissions = async (paths) => ({
  verified: true,
  entries: paths.map((itemPath) => ({ path: itemPath, owner: 'test', dacl: 'read' })),
  reasons: [],
});

async function temporaryOutput(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'dsh-incremental-benchmark-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const relative = path.relative(tempRoot, resolved);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('demo retains fixed findings and invalidates only pricing plus its aggregate', async (t) => {
  const result = await runDemo({ outputDir: await temporaryOutput(t), permissionProvider: permissions });
  assert.equal(result.report.mode, 'fixture');
  assert.deepEqual(result.report.runs.map(({ report }) => [report.totals.executed, report.totals.reused]), [[4, 0], [0, 4], [2, 2]]);
  assert.deepEqual(result.report.runs.map(({ score }) => score.matchedCount), [3, 3, 2]);
  for (const { report, score } of result.report.runs) {
    assert.equal(report.status, 'completed');
    assert.equal(report.totals.modelCalls, 0);
    assert.equal(report.totals.usage, null);
    assert.deepEqual(score.missingIds, []);
    assert.deepEqual(score.unmatchedFindings, []);
  }
  assert.deepEqual(result.report.runs[2].report.tasks.filter((task) => task.status === 'executed').map((task) => task.taskId).sort(), ['pricing', 'summary']);
  assert.match(await fs.readFile(result.markdownPath, 'utf8'), /not an AI review/);
  assert.equal(JSON.parse(await fs.readFile(result.reportPath, 'utf8')).runs.length, 3);
});

test('benchmark uses three copied repositories, paired snapshots, alternating order, and raw reports', async (t) => {
  const { report, artifactDir } = await runBenchmark({ outputDir: await temporaryOutput(t), permissionProvider: permissions });
  assert.equal(report.repetitions, 3);
  assert.equal(report.mode, 'fixture');
  assert.equal(report.totals.runs, 12);
  assert.equal(report.totals.executed, 30);
  assert.equal(report.totals.reused, 18);
  assert.equal(report.totals.modelCalls, 0);
  assert.equal(report.totals.usage, null);
  assert.equal(report.budget.dispatched, 0);
  assert.equal(report.controls.executorIdentityConsistent, true);
  assert.equal(report.controls.permissionVerification, 'injected-provider');
  assert.deepEqual(report.trials.map((trial) => trial.changedPairOrder[0]), ['modified-full', 'modified-incremental', 'modified-full']);
  const repositories = new Set();
  for (const trial of report.trials) {
    assert.deepEqual(trial.stages.map((stage) => stage.totals.executed), [4, 0, ...(trial.repetition % 2 ? [4, 2] : [2, 4])]);
    assert.equal(trial.initialSnapshot.files['src/auth.js'].sha256, trial.changedSnapshot.files['src/auth.js'].sha256);
    assert.equal(trial.initialSnapshot.files['src/pagination.js'].sha256, trial.changedSnapshot.files['src/pagination.js'].sha256);
    assert.notEqual(trial.initialSnapshot.files['src/pricing.js'].sha256, trial.changedSnapshot.files['src/pricing.js'].sha256);
    assert.equal(trial.initialSnapshot.manifestSha256, trial.changedSnapshot.manifestSha256);
    assert.equal(trial.comparison.exactSummaryEvidenceEqual, true);
    assert.equal(trial.comparison.executedTaskReduction, 2);
    assert.equal(trial.comparison.modelCallReductionFraction, null);
    for (const stage of trial.stages) {
      const raw = JSON.parse(await fs.readFile(path.join(artifactDir, stage.rawReportPath), 'utf8'));
      assert.equal(raw.status, 'completed');
      assert.equal(stage.score.knownFindingCoverage, 1);
      assert.equal(stage.score.unmatchedFindings.length, 0);
      assert.equal(stage.consumedSnapshot.complete, true);
      assert.deepEqual(stage.consumedSnapshot.files, Object.fromEntries(Object.entries(trial[stage.sourceSnapshot === 'initial' ? 'initialSnapshot' : 'changedSnapshot'].files).map(([filePath,file]) => [filePath,file.sha256])));
      assert(raw.tasks.every((task) => typeof task.timing.snapshotMs === 'number'));
      repositories.add(raw.repoRoot);
    }
  }
  assert.equal(repositories.size, 3);
});

function strictMockFactory(counter) {
  return () => {
    const fixture = createFixtureExecutor();
    return {
      identity: { kind: 'mock-real', model: 'test-only-no-network', revision: 'unpinned' },
      reuseEligibility: { eligible: false, reasons: [{ code: 'model_revision_unpinned', message: 'Mock strict policy: no pinned revision' }] },
      async execute(input) {
        counter.calls += 1;
        return { ...(await fixture.execute(input)), modelCalls: 1, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
      },
    };
  };
}

test('strict unpinned executor makes 48 mocked calls with no reuse and preserves unknown usage counters', async (t) => {
  const counter = { calls: 0 };
  const { report } = await runBenchmark({
    outputDir: await temporaryOutput(t), executorFactory: strictMockFactory(counter), permissionProvider: permissions,
  });
  assert.equal(counter.calls, 48);
  assert.equal(report.budget.dispatched, 48);
  assert.equal(report.totals.modelCalls, 48);
  assert.equal(report.totals.reused, 0);
  assert.equal(report.totals.executed, 48);
  assert.equal(report.totals.usage.inputTokens, 480);
  assert.equal(report.totals.usage.outputTokens, 192);
  assert.equal(report.totals.usage.totalTokens, 672);
  assert.equal(report.totals.usage.cacheReadTokens, null);
  assert(report.trials.every((trial) => trial.stages.every((stage) => stage.totals.executed === 4 && stage.totals.reused === 0)));
});

test('central dispatch budget survives factory recreation and blocks calls before an executor runs', async (t) => {
  const counter = { calls: 0 };
  const { report, artifactDir } = await runBenchmark({
    outputDir: await temporaryOutput(t), executorFactory: strictMockFactory(counter), repetitions: 1,
    maxModelCalls: 5, permissionProvider: permissions,
  });
  assert.equal(counter.calls, 5);
  assert.equal(report.budget.dispatched, 5);
  assert.equal(report.totals.modelCalls, 5);
  const rawReports = await Promise.all(report.trials[0].stages.map(async (stage) => JSON.parse(await fs.readFile(path.join(artifactDir, stage.rawReportPath), 'utf8'))));
  const exhausted = rawReports.flatMap((raw) => raw.tasks).filter((task) => task.reasons.some((reason) => reason.code === 'BENCHMARK_MODEL_CALL_BUDGET_EXHAUSTED'));
  assert(exhausted.length > 0);
  assert(exhausted.every((task) => task.modelCalls === 0 && task.status === 'failed'));
  assert.equal(report.trials[0].comparison.exactSummaryEvidenceEqual, null);
});

test('prepared run views retain cache policy and cannot bypass the central dispatch budget',async t=>{
  let calls=0,preparations=0;
  const executorFactory=()=>{
    const fixture=createFixtureExecutor();
    const identity={kind:'mock-real',model:'offline-prepared-route'};
    return {
      identity,cachePolicy:{mode:'visible-model',maxAgeMs:86400000},
      reuseEligibility:{eligible:false,reasons:['not_prepared']},
      async execute(input){calls++;return {...await fixture.execute(input),modelCalls:1,usage:null};},
      async prepareRun(){
        preparations++;
        return {identity:{...identity,advertisedModel:{id:'route-model',name:'Observed model'}},cachePolicy:this.cachePolicy,reuseEligibility:{eligible:true,reasons:[],risks:['model_revision_unverified']},execute:this.execute.bind(this)};
      },
    };
  };
  const {report,artifactDir}=await runBenchmark({outputDir:await temporaryOutput(t),executorFactory,repetitions:1,maxModelCalls:5,permissionProvider:permissions});
  assert.equal(preparations,4);assert.equal(calls,5);assert.equal(report.budget.dispatched,5);
  const unchanged=report.trials[0].stages.find(stage=>stage.stage==='unchanged-incremental');
  assert.equal(unchanged.totals.reused,4);assert.equal(unchanged.totals.modelCalls,0);
  assert.equal(unchanged.executorIdentity.advertisedModel.name,'Observed model');
  assert.equal(unchanged.reuseEligibility.eligible,true);
  const raw=JSON.parse(await fs.readFile(path.join(artifactDir,unchanged.rawReportPath),'utf8'));
  assert.equal(raw.reusePolicy.mode,'visible-model');
  assert(raw.tasks.every(task=>task.cacheCheck.status==='within_window'));
});

test('supplementary pair preserves separate empty states and records its changed protocol', async (t) => {
  const counter = { calls: 0 };
  const { report, artifactDir } = await runPairedBenchmark({
    outputDir: await temporaryOutput(t), executorFactory: strictMockFactory(counter), permissionProvider: permissions,
  });
  assert.equal(counter.calls, 8);
  assert.equal(report.totals.modelCalls, 8);
  assert.equal(report.totals.knownModelCalls, 8);
  assert.equal(report.totals.unknownCallCounts, 0);
  assert.equal(report.protocol.id, 'supplemental-numbered-lines-pair-v1');
  assert.equal(report.controls.seededIncrementalState, false);
  assert.equal(report.totals.executed, 8);
  assert.equal(report.totals.reused, 0);
  assert.deepEqual(report.trials[0].stages.map((stage) => stage.stage), ['modified-full', 'modified-incremental']);
  for (const stage of report.trials[0].stages) {
    const raw = JSON.parse(await fs.readFile(path.join(artifactDir, stage.rawReportPath), 'utf8'));
    assert.equal(raw.status, 'completed');
    assert.equal(stage.score.matchedCount, 2);
  }
  assert.equal(report.trials[0].comparison.exactSummaryEvidenceEqual, true);
});

test('benchmark retains unknown model-call totals instead of converting missing measurements to zero', async (t) => {
  let invocations = 0;
  const executorFactory = () => {
    const fixture = createFixtureExecutor();
    return {
      identity: { kind: 'mock-unknown-count', model: 'test-only-no-network' },
      reuseEligibility: { eligible: false, reasons: ['model_revision_unpinned'] },
      async execute(input) {
        invocations += 1;
        return { ...(await fixture.execute(input)), modelCalls: input.task.id === 'auth' ? null : 1, usage: null };
      },
    };
  };
  const { report, markdownPath } = await runPairedBenchmark({
    outputDir: await temporaryOutput(t), executorFactory, permissionProvider: permissions,
  });
  assert.equal(invocations, 8);
  assert.equal(report.budget.dispatched, 8);
  assert.equal(report.totals.modelCalls, null);
  assert.equal(report.totals.knownModelCalls, 6);
  assert.equal(report.totals.unknownCallCounts, 2);
  assert.equal(report.totals.usage.inputTokens, null);
  assert.equal(report.trials[0].comparison.modelCallReduction, null);
  assert.equal(report.trials[0].comparison.modelCallReductionFraction, null);
  assert.match(await fs.readFile(markdownPath, 'utf8'), /Reported model calls: unknown/);
});

test('fixed-reference scoring requires source location and evidence while preserving unmatched findings', () => {
  const expected = { findings: [{ id: 'known', title: 'Original', path: 'src/x.js', line: 3, evidence: 'danger();' }] };
  const result = (finding) => ({ tasks: [{ taskId: 'summary', output: { findings: [finding] } }] });
  const correct = { title: 'Different title', path: 'src\\x.js', line: 3, evidence: '  danger();  ', severity: 'high' };
  assert.equal(scoreReport(result(correct), expected).matchedCount, 1);
  for (const finding of [{ ...correct, line: 4 }, { ...correct, evidence: 'safe();' }, { ...correct, path: 'src/y.js' }]) {
    const score = scoreReport(result(finding), expected);
    assert.equal(score.matchedCount, 0);
    assert.deepEqual(score.missingIds, ['known']);
    assert.equal(score.unmatchedFindings.length, 1);
  }
  const stale = result(correct);
  stale.tasks[0].status = 'executed';
  stale.tasks[0].currentSourceValid = false;
  assert.equal(scoreReport(stale, expected).matchedCount, 0);
});

test('preparation keeps the reference outside review inputs and refuses overwrites', async (t) => {
  const directory = await temporaryOutput(t);
  const example = await prepareExample({ outputDir: path.join(directory, 'case') });
  assert.equal(path.dirname(example.groundTruthPath), path.dirname(example.repoRoot));
  await assert.rejects(fs.stat(path.join(example.repoRoot, 'ground-truth.json')), { code: 'ENOENT' });
  const promptText = JSON.stringify(example.manifest);
  assert.doesNotMatch(promptText, /ground[._ -]?truth|answer[._ -]?key|preset[ _-]?defects?|expected[ _-]?findings/i);
  const reference=JSON.parse(await fs.readFile(example.groundTruthPath,'utf8'));
  const taskText=example.manifest.tasks.flatMap(task=>[task.description,...task.acceptance]).join('\n');
  // Local business contracts are legitimate inputs; reference answer IDs,
  // finding titles and defective source-line answers must remain separate.
  for(const finding of reference.snapshots.initial.findings) {
    assert(!taskText.includes(finding.id));assert(!taskText.includes(finding.title));assert(!taskText.includes(finding.evidence));
  }
  assert.deepEqual(example.manifest.tasks.flatMap(task=>task.inputs.files).sort(),Object.keys(reference.snapshots.initial.files).sort());
  assert(example.manifest.tasks.every(task=>task.inputs.directories.length===0));
  await assert.rejects(prepareExample({ outputDir: path.join(directory, 'case') }), /Refusing to overwrite/);
});

test('pre-cancelled experiments dispatch no work and mark the incomplete pair as unknown', async (t) => {
  const controller = new AbortController();controller.abort();
  let factories = 0;
  const executorFactory = () => {factories += 1;return createFixtureExecutor();};
  for (const run of [runBenchmark, runPairedBenchmark]) {
    const { report } = await run({ outputDir: await temporaryOutput(t), executorFactory, signal: controller.signal, permissionProvider: permissions });
    assert.equal(report.cancelled,true);
    assert.equal(report.repetitions,0);
    assert.deepEqual(report.trials,[]);
    assert.equal(report.totals.runs,0);
    assert.equal(report.totals.modelCalls,0);
    assert.equal(report.controls.fullAndIncrementalUseIdenticalChangedSnapshot,null);
  }
  const { report: demo } = await runDemo({ outputDir: await temporaryOutput(t), signal: controller.signal, permissionProvider: permissions });
  assert.equal(demo.cancelled,true);assert.deepEqual(demo.runs,[]);
  assert.equal(factories,0);
});

test('cancellation retains the current report and stops later stages, edits, and factories', async (t) => {
  const controller = new AbortController();
  let factories = 0, disposals = 0, repository;
  const executorFactory = ({ repoRoot }) => {
    factories += 1;repository = repoRoot;
    const fixture = createFixtureExecutor();
    return {
      ...fixture,
      async execute(input) {
        const response = await fixture.execute(input);
        controller.abort();return response;
      },
      async dispose() {disposals += 1;},
    };
  };
  const { report } = await runBenchmark({ outputDir: await temporaryOutput(t), executorFactory, signal: controller.signal, permissionProvider: permissions });
  assert.equal(report.cancelled,true);
  assert.equal(factories,1);assert.equal(disposals,1);
  assert.deepEqual(report.trials[0].stages.map(stage=>stage.stage),['seed-incremental']);
  assert.equal(report.trials[0].stages[0].status,'cancelled');
  assert.equal(report.trials[0].changedSnapshot,null);
  assert.equal(report.trials[0].comparison,null);
  assert.match(await fs.readFile(path.join(repository,'src/pricing.js'),'utf8'),/if \(!Number\.isInteger\(quantity\)\) \{/);
});

test('benchmark refuses to score factory-mutated source or manifest snapshots', async (t) => {
  for (const relativePath of ['src/auth.js','review-tasks.json']) {
    let disposed = false;
    const executorFactory = async ({ repoRoot }) => {
      await fs.appendFile(path.join(repoRoot,relativePath),'\n');
      return {...createFixtureExecutor(),async dispose() {disposed = true;}};
    };
    await assert.rejects(runBenchmark({ outputDir: await temporaryOutput(t), executorFactory, repetitions: 1, permissionProvider: permissions }),/snapshot mismatch/);
    assert.equal(disposed,true);
  }
});

test('benchmark verifies the consumed input hashes even after the stage precheck', async (t) => {
  let changed = false;
  const executorFactory = ({ repoRoot }) => {
    const fixture = createFixtureExecutor(), identity = fixture.identity;
    return {
      ...fixture,
      get identity() {
        if (!changed) {changed = true;writeFileSync(path.join(repoRoot,'src/auth.js'),'export function canManageAccounts() { return false; }\n');}
        return identity;
      },
    };
  };
  await assert.rejects(runBenchmark({ outputDir: await temporaryOutput(t), executorFactory, repetitions: 1, permissionProvider: permissions }),/consumed snapshot mismatch: src\/auth.js/);
});

test('executor cleanup attempts every disposal even when an earlier disposal fails', async (t) => {
  const disposed = [];
  const executorFactory = ({ stage }) => ({
    ...createFixtureExecutor(),
    async dispose() {
      disposed.push(stage);
      if (stage === 'modified-full') throw new Error('Mock cleanup failure');
    },
  });
  await assert.rejects(runPairedBenchmark({ outputDir: await temporaryOutput(t), executorFactory, permissionProvider: permissions }),/Benchmark executor cleanup failed/);
  assert.deepEqual(disposed.sort(),['modified-full','modified-incremental']);
});
