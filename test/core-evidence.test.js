import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreReport } from '../src/benchmark.js';
import { projectCoreTask } from '../tools/export-core-evidence.mjs';

const evidence = JSON.parse(await readFile(new URL('../docs/evidence/core-acceptance.json', import.meta.url), 'utf8'));
const truth = JSON.parse(await readFile(new URL('../examples/ground-truth.json', import.meta.url), 'utf8'));
const [failed, passed] = evidence.attempts;
const reports = attempt => attempt.stages.flatMap(stage => stage.report ? [stage.report] : []);
const tasks = report => Object.fromEntries(report.tasks.map(task => [task.taskId, task]));
const close = (actual, expected) => assert(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('real core evidence retains the failed attempt and the subsequent 4/0/2-call acceptance', () => {
  assert.equal(evidence.kind, 'dsh-incremental-core-acceptance-evidence');
  assert.deepEqual(evidence.attempts.map(attempt => [attempt.id, attempt.status, attempt.accounting.modelCalls]), [['run-6gQjkT', 'failed', 4], ['run-02FG6R', 'passed', 6]]);
  assert.deepEqual(passed.stages.map(stage => [stage.stage, stage.status, stage.report.status, stage.report.totals.executed, stage.report.totals.reused, stage.report.totals.modelCalls]), [['initial', 'passed', 'completed', 4, 0, 4], ['unchanged', 'passed', 'completed', 0, 4, 0], ['pricing-changed', 'passed', 'completed', 2, 2, 2]]);
  assert.deepEqual(failed.stages.map(stage => stage.status), ['failed', 'not-run', 'not-run']);
  for (const stage of failed.stages.slice(1)) {
    assert.equal(stage.report, null);
    assert.equal(stage.score, null);
    assert.equal(stage.source, null);
  }
  const auth = tasks(failed.stages[0].report).auth;
  assert.equal(auth.status, 'executed');
  assert.equal(auth.modelCalls, 1);
  assert.equal(auth.reuseEligibility.eligible, false);
  assert(auth.reuseEligibility.reasons.some(reason => reason.code === 'unknown_dependencies'));
  assert.match(auth.output.unknownDependencies.join(' '), /role-assignment system/);
  assert(auth.validation.some(item => item.name === 'reported_dependency_gaps' && item.status === 'failed'));
  assert.equal(failed.checks.allStagesPassed, false);
  assert.equal(passed.checks.allStagesPassed, true);
  assert.equal(evidence.accounting.modelCallsInRetainedAttempts, 10);
  assert.equal(evidence.accounting.historicalExperimentModelCalls + evidence.accounting.earlierSmokeModelCalls + evidence.accounting.modelCallsInRetainedAttempts, evidence.accounting.cumulativeModelCalls);
  assert.equal(evidence.accounting.cumulativeModelCalls, 58);
  assert.equal(evidence.accounting.authorizedCumulativeMaxModelCalls, 58);
});

test('retained result versions and upstream versions demonstrate unchanged reuse and selective invalidation', () => {
  const [initial, unchanged, changed] = reports(passed).map(tasks);
  for (const id of ['auth', 'pricing', 'pagination', 'summary']) {
    assert.equal(unchanged[id].status, 'reused');
    assert.equal(unchanged[id].resultVersion, initial[id].resultVersion);
    assert.equal(unchanged[id].reusedFrom.resultVersion, initial[id].resultVersion);
    assert.deepEqual(unchanged[id].output, initial[id].output);
  }
  for (const id of ['auth', 'pagination']) {
    assert.equal(changed[id].status, 'reused');
    assert.equal(changed[id].resultVersion, initial[id].resultVersion);
    assert.deepEqual(changed[id].output, initial[id].output);
  }
  for (const id of ['pricing', 'summary']) {
    assert.equal(changed[id].status, 'executed');
    assert.notEqual(changed[id].resultVersion, initial[id].resultVersion);
  }
  assert(changed.pricing.reasons.some(reason => reason.code === 'file_content_or_membership_changed'));
  assert(changed.summary.reasons.some(reason => reason.code === 'upstream_reran' && reason.sourceTaskId === 'pricing'));
  assert(changed.summary.reasons.some(reason => reason.code === 'upstream_result_changed'));
  for (const report of reports(passed)) {
    const stageTasks = tasks(report);
    assert.deepEqual(stageTasks.summary.upstreamVersions, Object.fromEntries(['auth', 'pricing', 'pagination'].map(id => [id, stageTasks[id].resultVersion])));
  }
});

test('consumed snapshots match the appropriate external source reference and retain TTL risk limits', () => {
  for (const attempt of evidence.attempts) for (const stage of attempt.stages.filter(item => item.report)) {
    const report = stage.report;
    assert.equal(attempt.sourceReference.outsideReviewedRepository, true);
    assert.equal(report.reusePolicy.mode, 'visible-model');
    assert.equal(report.reusePolicy.maxAgeMs, 86400000);
    assert.equal(report.executor.model.immutableRevision, null);
    assert.equal(report.executor.model.id, 'deepseek-flash');
    assert.equal(report.executor.advertisedModel.name, 'DeepSeek-V4.1-Flash');
    assert.equal(report.identityObservation.kind, 'advertised_route');
    for (const task of report.tasks) {
      assert.match(task.inputSnapshot.digest, /^[a-f0-9]{64}$/u);
      for (const file of task.inputSnapshot.files) assert.equal(file.sha256, truth.snapshots[stage.sourceSnapshot].files[file.path].sha256);
      assert.deepEqual(task.reuseEligibility.risks, ['model_revision_unverified', 'provider_update_undetectable']);
      assert.equal(task.currentSourceValid, true);
      if (task.status === 'reused') {
        assert.equal(task.cacheCheck.status, 'within_window');
        assert(task.cacheCheck.ageMs >= 0 && task.cacheCheck.ageMs <= task.cacheCheck.maxAgeMs);
        assert.equal(task.cacheCheck.maxAgeMs, 86400000);
      }
    }
  }
  for (const attempt of evidence.attempts) {
    for (const source of [attempt.source, attempt.sourceReference, attempt.dispatchLedger, ...attempt.stages.flatMap(stage => stage.source ? [stage.source] : [])]) {
      assert.match(source.path, /^artifacts\/core-acceptance\/run-[a-z0-9]+\/[a-z.-]+$/iu);
      assert.match(source.sha256, /^[a-f0-9]{64}$/u);
    }
  }
});

test('actual task calls, usage and timings reconcile; metadata requests remain separate', () => {
  let metadataRequests = 0;
  for (const attempt of evidence.attempts) {
    assert.equal(attempt.dispatchLedger.durableDispatchAttempts, attempt.accounting.modelCalls);
    assert.equal(reports(attempt).reduce((sum, report) => sum + report.totals.modelCalls, 0), attempt.accounting.modelCalls);
    for (const report of reports(attempt)) {
      assert.equal(report.tasks.reduce((sum, task) => sum + task.modelCalls, 0), report.totals.modelCalls);
      metadataRequests += report.identityObservation.requestCount;
      for (const name of ['snapshotMs', 'executionMs', 'cacheMs']) close(report.tasks.reduce((sum, task) => sum + task.timing[name], 0), report.totals[name]);
      assert(report.totals.totalMs >= report.totals.executionMs);
      for (const task of report.tasks) {
        for (const value of Object.values(task.timing)) assert(Number.isFinite(value) && value >= 0);
        if (task.status === 'reused') {
          assert.equal(task.modelCalls, 0);
          assert.equal(task.usage, null);
          assert.equal(task.timing.executionMs, 0);
        } else {
          assert.equal(task.modelCalls, 1);
          for (const name of ['cacheWriteTokens', 'reasoningTokens', 'totalTokens']) assert.equal(task.usage[name], null);
        }
      }
      if (report.totals.modelCalls === 0) assert.equal(report.totals.usage, null);
      else for (const name of ['inputTokens', 'outputTokens', 'cacheReadTokens']) assert.equal(report.tasks.reduce((sum, task) => sum + (task.usage?.[name] ?? 0), 0), report.totals.usage[name]);
    }
  }
  assert.equal(metadataRequests, 4);
  assert.equal(evidence.accounting.advertisedRouteMetadataRequests, 4);
  assert.deepEqual(passed.stages.map(stage => stage.report.identityObservation.requestCount), [1, 1, 1]);
  assert.match(evidence.projection.metadataAccounting, /separately/);
});

test('actual outputs reproduce fixed-source scores with no unmatched findings or correctness certification', () => {
  for (const attempt of evidence.attempts) for (const stage of attempt.stages.filter(item => item.report)) {
    assert.deepEqual(scoreReport(stage.report, truth.snapshots[stage.sourceSnapshot]), stage.score);
    assert.equal(stage.score.matchedCount, stage.sourceSnapshot === 'pricingFixed' ? 2 : 3);
    assert.deepEqual(stage.score.missingIds, []);
    assert.deepEqual(stage.score.unmatchedFindings, []);
    for (const task of stage.report.tasks) assert(task.validation.some(item => item.name === 'conclusion_correctness' && item.status === 'not_performed'));
  }
  assert.match(evidence.projection.semanticValidation, /do not establish conclusion correctness/);
});

test('allowlist omits host and credential details and redacts sensitive text without copying unknown objects', () => {
  const forbiddenKeys = ['owner', 'acl', 'dacl', 'sid', 'sids', 'repoRoot', 'runtimeRoot', 'credentialEnv', 'credentialRef', 'request', 'prompt', 'securityPolicy', 'components', 'apiKey'];
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert(!forbiddenKeys.includes(key), key);
      inspect(item);
    }
  };
  inspect(evidence);
  assert.doesNotMatch(JSON.stringify(evidence), /[a-z]:\\|\/(?:Users|home|root)\/[^/\s"]+|S-1-\d+(?:-\d+)+|Bearer\s|\bsk-[a-z0-9_-]{8,}/iu);
  const projected = projectCoreTask({
    taskId: 'auth', status: 'executed', owner: 'PRIVATE_OWNER', securityPolicy: { private: 'PRIVATE_POLICY' },
    request: { apiKey: 'PRIVATE_KEY' }, credentialRef: 'PRIVATE_CREDENTIAL_REF',
    output: { summary: 'C:\\Users\\Private Person\\secret.txt', findings: [{ title: 'api_key=PRIVATE_KEY', path: '../../secret.txt', line: 1, evidence: 'Bearer PRIVATE_TOKEN', owner: 'PRIVATE_OWNER' }], unknownDependencies: ['S-1-5-21-111-222-333'], limitations: ['/home/private/secret.txt'] },
    inputSnapshot: { files: [{ path: 'C:\\Private\\secret.txt', sha256: 'a'.repeat(64), bytes: 1, owner: 'PRIVATE_OWNER' }] },
    upstreamVersions: { pricing: 'retained-version', PRIVATE_CREDENTIAL_REF: 'PRIVATE_KEY' },
  });
  inspect(projected);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|Private Person|secret\.txt|S-1-5-21/);
  assert.equal(projected.output.findings[0].path, '[REDACTED_HOST_PATH]');
  assert.deepEqual(projected.upstreamVersions, { pricing: 'retained-version' });
});
