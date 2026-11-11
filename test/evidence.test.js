import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportEvidence, projectExperiment } from '../tools/export-evidence.mjs';
import { scoreReport } from '../src/benchmark.js';

const evidenceRoot = new URL('../docs/evidence/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, evidenceRoot), 'utf8'));
const files = ['fixture.json', 'real-baseline.json', 'real-numbered-followup.json'];
const experiments = await Promise.all(files.map(read));
const stages = experiment => experiment.trials.flatMap(trial => trial.stages);
const tasks = experiment => stages(experiment).flatMap(stage => stage.run.tasks);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const close = (actual, expected) => assert(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('portable evidence retains the separate experiments, full denominator, failures and call budget', async () => {
  const [fixture, baseline, followup] = experiments;
  assert.deepEqual(experiments.map(item => [item.repetitions, stages(item).length, item.totals.modelCalls]), [[3, 12, 0], [3, 12, 38], [1, 2, 8]]);
  assert.deepEqual(experiments.map(item => [item.totals.executed, item.totals.reused]), [[30, 18], [26, 0], [8, 0]]);
  assert.equal(stages(fixture).filter(stage => stage.status === 'completed').length, 12);
  assert.equal(stages(baseline).filter(stage => stage.status === 'completed').length, 2);
  assert.equal(stages(baseline).filter(stage => stage.status === 'partial').length, 10);
  const failed = tasks(baseline).filter(task => task.status === 'failed');
  assert.equal(failed.length, 12);
  assert.equal(tasks(baseline).filter(task => task.status === 'blocked').length, 10);
  for (const task of failed) {
    assert.equal(task.modelCalls, 1);
    assert.equal(task.output, null);
    assert.equal(task.error.code, 'RESULT_INVALID');
    assert.match(task.error.message, /Evidence does not match/);
    assert.equal(task.rejectedOutputAudit.available, false);
    assert.equal(task.rejectedOutputAudit.output, null);
    assert.match(task.rejectedOutputAudit.note, /did not retain/);
    assert(task.validation.some(item => item.name === 'output_schema' && item.status === 'passed'));
  }
  assert.equal(followup.protocol.id, 'supplemental-numbered-lines-pair-v1');
  assert.equal(followup.controls.seededIncrementalState, false);
  assert.equal(stages(followup).length, 2);
  const index = await read('index.json');
  assert.equal(index.totalRealModelCalls, 46);
  assert.equal(index.authorizedMaxModelCalls, 48);
  assert.deepEqual(index.experiments.map(item => item.path), files);
});

test('per-task actual call usage and phase timings reconcile with each retained stage', () => {
  for (const experiment of experiments) {
    close(stages(experiment).reduce((sum, stage) => sum + stage.totals.totalMs, 0), experiment.totals.totalMs);
    assert.equal(tasks(experiment).reduce((sum, task) => sum + task.modelCalls, 0), experiment.totals.modelCalls);
    for (const stage of stages(experiment)) {
      assert.equal(stage.run.tasks.length, 4);
      assert.equal(stage.run.tasks.reduce((sum, task) => sum + task.modelCalls, 0), stage.totals.modelCalls);
      for (const name of ['snapshotMs', 'executionMs', 'cacheMs']) close(stage.run.tasks.reduce((sum, task) => sum + task.timing[name], 0), stage.totals[name]);
      for (const task of stage.run.tasks) {
        for (const value of Object.values(task.timing)) assert(Number.isFinite(value) && value >= 0);
        if (task.usage === null) assert(experiment.id === 'fixture' || task.status === 'blocked');
        else for (const name of ['cacheWriteTokens', 'reasoningTokens', 'totalTokens']) assert.equal(task.usage[name], null);
      }
      if (experiment.id === 'fixture') assert.equal(stage.totals.usage, null);
      else for (const name of ['inputTokens', 'outputTokens', 'cacheReadTokens']) assert.equal(stage.run.tasks.reduce((sum, task) => sum + (task.usage?.[name] ?? 0), 0), stage.totals.usage[name]);
    }
    if (experiment.id === 'fixture') assert.equal(experiment.totals.usage, null);
    else for (const name of ['cacheWriteTokens', 'reasoningTokens', 'totalTokens']) assert.equal(experiment.totals.usage[name], null);
  }
});

test('shipped findings reproduce the fixed-reference scores without semantic correctness claims', async () => {
  const truth = JSON.parse(await readFile(new URL('../examples/ground-truth.json', import.meta.url), 'utf8'));
  for (const experiment of experiments) for (const stage of stages(experiment)) {
    assert.deepEqual(scoreReport({ tasks: stage.run.tasks }, truth.snapshots[stage.sourceSnapshot]), stage.score);
    for (const task of stage.run.tasks.filter(item => item.output !== null)) {
      assert(task.validation.some(item => item.name === 'conclusion_correctness' && item.status === 'not_performed'));
    }
  }
  const followup = experiments[2];
  assert.equal(stages(followup)[0].score.unmatchedFindings.length, 1);
  assert.equal(stages(followup)[1].score.unmatchedFindings.length, 0);
  assert.equal(followup.trials[0].comparison.exactSummaryEvidenceEqual, false);
});

test('declared and consumed hashes remain distinct, match synthetic source bytes, and label unavailable inputs', async () => {
  const sources = Object.fromEntries(await Promise.all(['auth', 'pricing', 'pagination'].map(async name => [`src/${name}.js`, await readFile(new URL(`../examples/demo-repo/src/${name}.js`, import.meta.url), 'utf8')])));
  for (const experiment of experiments) for (const trial of experiment.trials) {
    for (const [name, snapshot] of [['initial', trial.initialSnapshot], ['pricingFixed', trial.changedSnapshot]]) {
      if (!snapshot) continue;
      for (const [sourcePath, file] of Object.entries(snapshot.files)) {
        const bytes = name === 'pricingFixed' && sourcePath === 'src/pricing.js' ? sources[sourcePath].replace('if (!Number.isInteger(quantity)) {', 'if (!Number.isInteger(quantity) || quantity < 0) {') : sources[sourcePath];
        assert.equal(sha256(bytes), file.sha256);
      }
    }
    for (const stage of trial.stages) {
      const expected = stage.sourceSnapshot === 'initial' ? trial.initialSnapshot : trial.changedSnapshot;
      for (const task of stage.run.tasks) {
        if (task.inputSnapshot) {
          assert(['run-report', 'matching-successful-cache-provenance'].includes(task.inputSnapshotOrigin));
          for (const file of task.inputSnapshot.files) assert.equal(file.sha256, expected.files[file.path].sha256);
        } else {
          assert(['failed', 'blocked'].includes(task.status));
          assert.equal(task.inputSnapshotOrigin, 'not-retained-in-original-report');
        }
      }
    }
  }
  assert.equal(tasks(experiments[1]).filter(task => task.inputSnapshot !== null).length, 26);
  assert.equal(tasks(experiments[2]).filter(task => task.inputSnapshot !== null).length, 8);
});

test('published projections omit host identities, permission bodies, raw requests and cache objects', () => {
  for (const experiment of experiments) {
    const serialized = JSON.stringify(experiment);
    assert.doesNotMatch(serialized, /[a-z]:\\\\|\/(?:Users|home)\/[^/\s"]+|S-1-\d+(?:-\d+)+|Bearer\s|sk-[a-z0-9_-]{8,}/iu);
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        assert(!['owner', 'dacl', 'sid', 'sids', 'runtimeRoot', 'repoRoot', 'credentialEnv', 'request', 'permissions', 'components', 'apiKey'].includes(key), key);
        inspect(item);
      }
    }
    inspect(experiment);
    assert.equal(experiment.kind, 'dsh-incremental-portable-evidence');
    assert.match(experiment.projection.method, /allowlist/);
    assert.match(experiment.projection.semanticValidation, /do not establish/);
  }
});

test('allowlist projection discards unknown fields and redacts paths or credentials inside allowed text', () => {
  const sample = experiments[0], stage = stages(sample)[0];
  const sourceStage = { ...stage, rawReportPath: 'repetition-01/seed.report.json', owner: 'PRIVATE_OWNER', request: { apiKey: 'PRIVATE_SECRET' } };
  const raw = {
    status: stage.status, totals: stage.totals, repoRoot: 'C:\\Users\\Private Person\\repository',
    tasks: [{ taskId: 'auth', status: 'failed', reasons: [{ code: 'RESULT_INVALID', message: 'C:\\Users\\Private Person\\secret.txt' }], modelCalls: null, usage: { inputTokens: 5, privateCounter: 'PRIVATE_SECRET' }, timing: {}, error: { code: 'RESULT_INVALID', message: 'Bearer abcdefghijklmnop' },
      rejectedOutput: { summary: 'api_key=PRIVATE_SECRET', findings: [{ title: 'Retained rejection', path: 'src/auth.js', line: 1, evidence: 'source();', severity: 'low', owner: 'PRIVATE_OWNER' }], unknownDependencies: ['S-1-5-21-111-222-333'], limitations: ['Only synthetic text'] },
      failedAttempt: { fingerprint: 'a'.repeat(64), inputDigest: 'b'.repeat(64), request: { secret: 'PRIVATE_SECRET' } }, runtimeRoot: 'PRIVATE_RUNTIME', owner: 'PRIVATE_OWNER' }],
  };
  const benchmark = { ...sample, trials: [{ stages: [sourceStage] }], runtimeRoot: 'PRIVATE_RUNTIME', secret: 'PRIVATE_SECRET' };
  const projected = projectExperiment({ id: 'test', sourcePath: 'artifacts/synthetic/benchmark.json', benchmarkBytes: JSON.stringify(benchmark), stageRecords: [{ relativePath: sourceStage.rawReportPath, bytes: JSON.stringify(raw) }] });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /PRIVATE_SECRET|PRIVATE_OWNER|PRIVATE_RUNTIME|Private Person|secret\.txt|abcdefghijklmnop|S-1-5-21/);
  const task = stages(projected)[0].run.tasks[0];
  assert.equal(task.modelCalls, null);
  assert.equal(task.usage.outputTokens, null);
  assert.equal(task.rejectedOutputAudit.available, true);
  assert.equal(task.rejectedOutputAudit.output.findings[0].title, 'Retained rejection');
  assert.equal(task.rejectedOutputAudit.output.findings[0].owner, undefined);
  assert.equal(task.rejectedOutputAudit.failedAttempt.request, undefined);
  assert.match(task.rejectedOutputAudit.failedAttempt.requestSha256, /^[a-f0-9]{64}$/u);
});

test('temporary synthetic sources export deterministically without ignored artifacts or source mutations', async t => {
  const tempRoot = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(tempRoot, 'dsh-evidence-'));
  t.after(async () => {
    const relative = path.relative(tempRoot, path.resolve(root));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  const destination = path.join(root, 'exported'), localRawReports = {}, expected = [];
  const originals = [];
  for (const sample of experiments) {
    const stage = stages(sample)[0], relativePath = 'repetition-01/seed.report.json';
    const sourcePath = `artifacts/synthetic-${sample.id}/benchmark.json`;
    const bytes = JSON.stringify({ status: stage.status, totals: stage.totals, tasks: stage.run.tasks });
    const benchmarkBytes = JSON.stringify({ ...sample, trials: [{ ...sample.trials[0], stages: [{ ...stage, rawReportPath: relativePath }] }] });
    localRawReports[sample.id] = sourcePath;
    await mkdir(path.join(root, path.dirname(sourcePath), 'repetition-01'), { recursive: true });
    for (const [filename, contents] of [[sourcePath, benchmarkBytes], [path.join(path.dirname(sourcePath), relativePath), bytes]]) {
      await writeFile(path.join(root, filename), contents);
      originals.push([filename, sha256(contents)]);
    }
    expected.push(projectExperiment({ id: sample.id, sourcePath, benchmarkBytes, stageRecords: [{ relativePath, bytes }] }));
  }
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/measurement-summary.json'), JSON.stringify({ localRawReports, rawReports: { fixture: 'docs/evidence/fixture.json' }, authorizedMaxModelCalls: 48 }));
  const index = await exportEvidence({ root, destination });
  assert.equal(index.experiments.length, 3);
  for (const [i, filename] of files.entries()) assert.deepEqual(JSON.parse(await readFile(path.join(destination, filename), 'utf8')), expected[i]);
  const before = await Promise.all([...files, 'index.json'].map(filename => readFile(path.join(destination, filename), 'utf8')));
  await exportEvidence({ root, destination });
  assert.deepEqual(await Promise.all([...files, 'index.json'].map(filename => readFile(path.join(destination, filename), 'utf8'))), before);
  for (const [filename, before] of originals) assert.equal(sha256(await readFile(path.join(root, filename))), before);
});
