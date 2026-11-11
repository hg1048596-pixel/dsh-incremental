import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDshExecutor, loadDshModules, validateDshConfiguration, validateReviewOutput } from '../src/dsh-executor.js';
import { inspectDshRuntime } from '../src/doctor.js';
import { apply as applyPlugin, resolveHostSecurityPolicy } from '../src/plugin.js';
import { runReview } from '../src/engine.js';
import { CacheStore } from '../src/cache.js';

const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'Programs/DeepSeek Harness/resources/dsh-app');
let installed = true;
try { await access(path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-llm/package.json')); } catch { installed = false; }
const repoRoot = process.cwd();
const request = { system: 'Review supplied text. Return JSON only.', messages: [{ role: 'user', content: [{ type: 'text', text: 'snapshot only' }] }], tools: [] };
const output = { summary: 'Reviewed', findings: [], unknownDependencies: [], limitations: [] };
const config = (overrides = {}) => ({
  runtimeRoot, provider: 'deepseek-official', model: 'fixture-model',
  connection: { adapter: 'deepseek', baseURL: 'https://api.deepseek.com' },
  credentialEnv: 'DSH_INCREMENTAL_TEST_KEY', approvedRepoRoot: repoRoot, allowRemote: true, ...overrides,
});
function chunks(value = output, reason = { kind: 'stop' }, usage) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage ? [{ type: 'usage', usage }] : []),
    { type: 'finish', reason },
  ];
}
async function fakeExecutor(sequence = chunks(), overrides = {}, observe = () => {}, dependencies = {}) {
  return createDshExecutor(config(overrides), {
    ...dependencies,
    createAdapter: ({ modules, resolveCredential, config: frozen }) => new class extends modules['@deepseek-ai/dsh-llm'].exports.LlmAdapter {
      async *stream(options) {
        observe(options, resolveCredential, frozen);
        for (const chunk of sequence) yield chunk;
      }
    }(),
  });
}
const runtimeTest = (name, fn) => test(name, { skip: !installed && 'Existing DSH runtime is not present' }, fn);

test('strict review schema rejects wrong fields and invalid finding locations', () => {
  assert.equal(validateReviewOutput(output), output);
  assert.throws(() => validateReviewOutput({ ...output, command: 'ignored' }), { code: 'INVALID_OUTPUT' });
  assert.throws(() => validateReviewOutput({ ...output, findings: [{ title: 'x', path: 'a.js', line: 0, evidence: 'x', severity: 'high' }] }), { code: 'INVALID_OUTPUT' });
});

test('reuse policies default to strict and require a bounded positive TTL', () => {
  assert.deepEqual(validateDshConfiguration(config()).reusePolicy, { mode: 'strict', maxAgeMs: 86400000 });
  assert.deepEqual(validateDshConfiguration(config({ reusePolicy: { mode: 'visible-model' } })).reusePolicy,
    { mode: 'visible-model', maxAgeMs: 86400000 });
  assert.equal(validateDshConfiguration(config({ reusePolicy: { mode: 'visible-model', maxAgeMs: 2592000000 } })).reusePolicy.maxAgeMs, 2592000000);
  for (const maxAgeMs of [null, 0, -1, 0.5, Infinity, 2592000001, '1000']) {
    assert.throws(() => validateDshConfiguration(config({ reusePolicy: { mode: 'visible-model', maxAgeMs } })), /reusePolicy maxAgeMs/);
  }
  for (const reusePolicy of [null, [], 'visible-model', { mode: 'verified' }, { mode: 'visible-model', immutableRevision: 'fake' }]) {
    assert.throws(() => validateDshConfiguration(config({ reusePolicy })), /reusePolicy/);
  }
  assert.throws(() => validateDshConfiguration(config({
    connection: { adapter: 'pi-ai', baseURL: 'https://example.invalid', api: 'openai-completions' },
    reusePolicy: { mode: 'visible-model' },
  })), /direct DeepSeek adapter/);
});

test('unconfigured plugin stays dormant and partial host configuration fails', async () => {
  const warnings = [];
  const ctx = { logger: { warn: (message) => warnings.push(message) }, tools: { register: () => assert.fail('dormant plugin must not register tools') } };
  await applyPlugin(ctx);
  await applyPlugin(ctx, {});
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((message) => /dormant/.test(message)));
  await assert.rejects(applyPlugin(ctx, { repoRoot }), /manifestPath/);
  await assert.rejects(applyPlugin(ctx, {
    runtimeRoot, repoRoot, manifestPath: path.join(repoRoot, 'not-opened.json'), stateDir: path.dirname(repoRoot),
  }), /Missing DSH configuration: provider/);
});

test('host policy snapshot uses public session-aware sandbox and approval APIs only', async () => {
  const session = { id: 'policy-session' };
  let sandboxRequest;
  let approvalSession;
  const services = {
    sandboxPolicy: { resolve: (value) => { sandboxRequest = value; return { mode: 'workspace-write', workspaceRoot: repoRoot, sessionId: 'policy-session', ignored: 'not copied' }; } },
    approval: { config: { policy: 'ask' }, overrideOf: (value) => { approvalSession = value; return 'never'; } },
  };
  const result = await resolveHostSecurityPolicy({ get: (name) => services[name] }, { repoRoot, allowRemote: false }, { agent: { session } });
  assert.equal(sandboxRequest.session, session);
  assert.equal(approvalSession, session);
  assert.deepEqual(result.sandbox, { status: 'known', mode: 'workspace-write', workspaceRoot: repoRoot, sessionBound: true, sessionId: 'policy-session' });
  assert.deepEqual(result.approval, { status: 'known', effectivePolicy: 'never', source: 'session_override' });
  assert.equal(result.allowRemote, false);
  assert.equal(result.authorizationSource, 'fixed_host_configuration');
});

test('unavailable policy facts remain unknown; approval defaults do not hide session uncertainty', async () => {
  const config = { repoRoot, allowRemote: true };
  const missing = await resolveHostSecurityPolicy({}, config);
  assert.equal(missing.sandbox.status, 'unknown');
  assert.equal(missing.approval.status, 'unknown');
  const unavailable = await resolveHostSecurityPolicy({ get: (name) => name === 'sandboxPolicy'
    ? { resolve: () => { throw new Error('not copied'); } } : { config: { policy: 'ask' } } }, config, { agent: { session: {} } });
  assert.equal(unavailable.sandbox.reason, 'sandbox_policy_resolution_failed');
  assert.equal(unavailable.approval.reason, 'approval_session_policy_unavailable');
  assert.equal(JSON.stringify(unavailable).includes('not copied'), false);
  const agentless = await resolveHostSecurityPolicy({ get: (name) => name === 'approval' ? { config: { policy: 'ask' } } : undefined }, config);
  assert.deepEqual(agentless.approval, { status: 'known', effectivePolicy: 'ask', source: 'configured_default' });
});

runtimeTest('doctor inspects actual public APIs without a credential or model call', async () => {
  const report = await inspectDshRuntime({ runtimeRoot });
  assert.equal(report.compatible, true);
  assert.equal(report.capabilities.modelCalls, 0);
  assert.equal(report.capabilities.credentialResolution, false);
  for (const item of report.packages) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.equal(item.modificationStatus, 'unknown_no_trusted_baseline');
  }
});

runtimeTest('real adapter initialization does not resolve credentials; configured identity cannot enable reuse', async () => {
  let resolutions = 0;
  const executor = await createDshExecutor(config(), { resolveCredential: async () => { resolutions++; throw new Error('must not run'); } });
  try {
    assert.equal(resolutions, 0);
    assert.equal(executor.identity.model.immutableRevision, null);
    assert.equal(executor.identity.model.assurance, 'config_only');
    assert.deepEqual(executor.reuseEligibility, { eligible: false, reasons: ['model_revision_unknown'] });
    assert.deepEqual(JSON.parse(JSON.stringify(executor.identity)), executor.identity);
    assert.match(executor.identity.runnerHash, /^[a-f0-9]{64}$/);
  } finally { await executor.dispose(); }
});

runtimeTest('strict run preparation performs no model metadata request or credential resolution', async () => {
  let observed = 0;
  const executor = await fakeExecutor(chunks(), {}, () => {}, {
    resolveCredential: async () => { assert.fail('strict preparation must not resolve a key'); },
    observeModel: async () => { observed++; assert.fail('strict preparation must not request model metadata'); },
  });
  try {
    const first = await executor.prepareRun({ repoRoot });
    const second = await executor.prepareRun({ repoRoot });
    assert.equal(observed, 0);
    assert.equal(first.reuseEligibility.eligible, false);
    assert.equal(first.identity.model.immutableRevision, null);
    assert.deepEqual(first.identity, second.identity);
    assert.equal(first.identityObservation.status, 'not_requested');
    assert.equal(first.identityObservation.requestCount, 0);
    assert.equal(Object.isFrozen(first), true);
  } finally { await executor.dispose(); }
});

runtimeTest('visible-model preparation refreshes selected metadata in independent immutable run views', async () => {
  let metadata = { data: [{ id: 'fixture-model', name: 'Visible Model', owned_by: 'fixture-provider', revision: 'not-a-trusted-revision' }] };
  let observations = 0;
  let sent = 0;
  const executor = await fakeExecutor(chunks(), { reusePolicy: { mode: 'visible-model', maxAgeMs: 1000 }, immutableRevision: 'host-cannot-attest' },
    () => { sent++; }, { observeModel: async ({ config: fixed }) => { observations++; assert.equal(Object.isFrozen(fixed), true); return structuredClone(metadata); } });
  try {
    assert.deepEqual(executor.cachePolicy, { mode: 'visible-model', maxAgeMs: 1000 });
    assert.equal(executor.reuseEligibility.eligible, false);
    assert.deepEqual(executor.reuseEligibility.reasons, ['model_metadata_not_observed']);
    const first = await executor.prepareRun({ repoRoot });
    assert.equal(first.reuseEligibility.eligible, true);
    assert.equal(executor.reuseEligibility.eligible, false, 'preparing a run must not mutate the base eligibility');
    metadata.data.push({ id: 'unrelated-model', name: 'New unrelated model' });
    const second = await executor.prepareRun({ repoRoot });
    assert.equal(observations, 2);
    assert.notEqual(first, second);
    assert.notEqual(first.identityObservation, second.identityObservation);
    assert.deepEqual(first.identity, second.identity, 'unrelated catalog entries and observation times must not invalidate selected identity');
    assert.deepEqual(first.identity.advertisedModel, { id: 'fixture-model', name: 'Visible Model', owned_by: 'fixture-provider' });
    assert.equal(first.identity.model.immutableRevision, null);
    assert.equal(first.identity.model.assurance, 'configured-visible-route');
    assert.deepEqual(first.identityObservation.risks, ['model_revision_unverified', 'provider_update_undetectable']);
    assert.equal(first.identityObservation.kind, 'advertised_route');
    assert.equal(first.identityObservation.requestCount, 1);
    assert.equal(Object.hasOwn(first.identity, 'observedAt'), false);
    assert.equal(Object.hasOwn(executor.identity, 'advertisedModel'), false);
    assert.equal(JSON.stringify(first.identity).includes('not-a-trusted-revision'), false);
    assert.equal(Object.isFrozen(first.identity.advertisedModel), true);
    assert.throws(() => { first.identity.advertisedModel.name = 'mutation'; }, TypeError);
    metadata.data[0].name = 'Changed Visible Model';
    const third = await executor.prepareRun({ repoRoot });
    assert.equal(observations, 3);
    assert.notDeepEqual(first.identity, third.identity);
    assert.equal(first.identity.advertisedModel.name, 'Visible Model');
    assert.equal(third.identity.advertisedModel.name, 'Changed Visible Model');
    assert.deepEqual((await first.execute({ request, repoRoot })).output, output);
    assert.equal(sent, 1);
  } finally { await executor.dispose(); }
});

runtimeTest('missing, malformed and failed advertised-model observations disable reuse without leaking provider detail', async () => {
  const cases = [
    { metadata: { data: [{ id: 'other-model' }] }, reason: 'model_not_advertised' },
    { metadata: { data: [{ id: 'fixture-model' }, { id: 'fixture-model' }] }, reason: 'model_metadata_invalid' },
    { metadata: { unrelated: 'raw-provider-detail' }, reason: 'model_metadata_invalid' },
    { error: new Error('raw-provider-detail'), reason: 'model_metadata_unavailable' },
  ];
  for (const item of cases) {
    const executor = await fakeExecutor(chunks(), { reusePolicy: { mode: 'visible-model' } }, () => {}, {
      observeModel: async () => { if (item.error) throw item.error; return item.metadata; },
    });
    try {
      const view = await executor.prepareRun({ repoRoot });
      assert.equal(view.reuseEligibility.eligible, false);
      assert.deepEqual(view.reuseEligibility.reasons, [item.reason]);
      assert.equal(view.identityObservation.reason, item.reason);
      assert.equal(Object.hasOwn(view.identity, 'advertisedModel'), false);
      assert.equal(JSON.stringify(view).includes('raw-provider-detail'), false);
      assert.deepEqual((await view.execute({ request, repoRoot })).output, output);
    } finally { await executor.dispose(); }
  }
});

runtimeTest('overlapping preparations keep their own advertised-model snapshots', async () => {
  const waiting = [];
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  let bothStarted;
  const ready = new Promise((resolve) => { bothStarted = resolve; });
  const executor = await fakeExecutor(chunks(), { reusePolicy: { mode: 'visible-model' } }, () => {}, {
    observeModel: async () => new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 1) firstStarted();
      if (waiting.length === 2) bothStarted();
    }),
  });
  try {
    const firstPending = executor.prepareRun({ repoRoot });
    await firstReady;
    const secondPending = executor.prepareRun({ repoRoot });
    await ready;
    waiting[1]({ data: [{ id: 'fixture-model', name: 'Second observation' }] });
    const second = await secondPending;
    waiting[0]({ data: [{ id: 'fixture-model', name: 'First observation' }] });
    const first = await firstPending;
    assert.equal(first.identity.advertisedModel.name, 'First observation');
    assert.equal(second.identity.advertisedModel.name, 'Second observation');
    assert.equal(Object.hasOwn(executor.identity, 'advertisedModel'), false);
  } finally { await executor.dispose(); }
});

runtimeTest('advertised model fields discard controls and unrelated metadata', async () => {
  const executor = await fakeExecutor(chunks(), { reusePolicy: { mode: 'visible-model' } }, () => {}, {
    observeModel: async () => ({ data: [{ id: 'fixture-model', name: 'bad\u001b[31mname', owned_by: 'x'.repeat(257), secret: 'not-copied' }] }),
  });
  try {
    const view = await executor.prepareRun({ repoRoot });
    assert.deepEqual(view.identity.advertisedModel, { id: 'fixture-model' });
    assert.equal(JSON.stringify(view).includes('not-copied'), false);
  } finally { await executor.dispose(); }
});

runtimeTest('metadata preparation respects remote authorization, caller cancellation and disposal', async () => {
  let observations = 0;
  const disabled = await fakeExecutor(chunks(), { allowRemote: false, reusePolicy: { mode: 'visible-model' } }, () => {}, {
    observeModel: async () => { observations++; return { data: [{ id: 'fixture-model' }] }; },
  });
  try {
    const view = await disabled.prepareRun({ repoRoot });
    assert.equal(view.reuseEligibility.eligible, false);
    assert.equal(view.identityObservation.reason, 'remote_not_approved');
    await assert.rejects(disabled.prepareRun({ repoRoot: path.dirname(repoRoot) }), { code: 'REPOSITORY_NOT_APPROVED' });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(disabled.prepareRun({ repoRoot, signal: aborted.signal }), { code: 'ABORTED' });
    assert.equal(observations, 0);
  } finally { await disabled.dispose(); }
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const executor = await fakeExecutor(chunks(), { reusePolicy: { mode: 'visible-model' } }, () => {}, {
    observeModel: async ({ signal }) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('private observer cancellation detail');
    },
  });
  const preparing = executor.prepareRun({ repoRoot });
  const rejected = assert.rejects(preparing, { code: 'EXECUTOR_DISPOSED' });
  await pending;
  await executor.dispose();
  await rejected;
  await assert.rejects(executor.prepareRun({ repoRoot }), { code: 'EXECUTOR_DISPOSED' });
});

runtimeTest('official pi-ai adapter initializes one explicit profile without ambient auth or discovery', async () => {
  let resolutions = 0;
  const executor = await createDshExecutor(config({
    provider: 'incremental-offline', connection: { adapter: 'pi-ai', baseURL: 'https://example.invalid/v1', api: 'openai-completions' },
  }), { resolveCredential: async () => { resolutions++; throw new Error('must not run'); } });
  try {
    assert.equal(resolutions, 0);
    assert.equal(executor.identity.adapter, 'pi-ai');
    assert.equal(executor.identity.model.id, 'fixture-model');
    assert.equal(executor.reuseEligibility.eligible, false);
  } finally { await executor.dispose(); }
});

runtimeTest('private runtime sends only frozen supplied user text with tools empty and caps output', async () => {
  let sent;
  const executor = await fakeExecutor(chunks(output, { kind: 'stop' }, { inputTokens: 9, outputTokens: 4 }), {}, (value) => { sent = value; });
  try {
    const result = await executor.execute({ request, repoRoot });
    assert.deepEqual(result.output, output);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.usage.inputTokens, 9);
    assert.equal(result.usage.cacheReadTokens, null);
    assert.equal(sent.maxTokens, 4096);
    assert.equal(sent.model, 'fixture-model');
    assert.deepEqual(sent.tools, []);
    assert.equal(sent.messages.length, 1);
    assert.equal(Object.isFrozen(sent.messages[0]), true);
    assert.equal(Object.isFrozen(sent.messages[0].content), true);
    assert.equal(sent.messages[0].content[0].text, 'snapshot only');
    assert.equal(sent.sessionId, undefined);
  } finally { await executor.dispose(); }
});

runtimeTest('usage absent from successful provider output remains null', async () => {
  const executor = await fakeExecutor();
  try { assert.equal((await executor.execute({ request, repoRoot })).usage, null); }
  finally { await executor.dispose(); }
});

runtimeTest('installed LLM executor completes engine runs while unknown model revisions prevent reuse', async () => {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), 'dsh-incremental-integration-'));
  const fixtureRoot = path.join(temporary, 'repo');
  await mkdir(fixtureRoot);
  const executor = await fakeExecutor(chunks(), { approvedRepoRoot: fixtureRoot });
  try {
    const options = {
      repoRoot: fixtureRoot, stateDir: path.join(temporary, 'state'), executor,
      manifest: { schemaVersion: 1, tasks: [{
        id: 'review', description: 'Review the supplied empty input only.', inputs: { files: [], directories: [] },
        dependsOn: [], acceptance: ['Return a structured scoped review.'],
      }] },
      // Deterministic permissions isolate the actual DSH-to-engine protocol contract.
      permissionProvider: async (paths) => ({ verified: true, entries: paths.map((path) => ({ path, owner: 'fixture', dacl: 'read' })), reasons: [] }),
    };
    const first = await runReview(options);
    assert.equal(first.status, 'completed');
    assert.equal(first.tasks[0].status, 'executed');
    assert.deepEqual(first.tasks[0].output, output);
    assert.equal(first.totals.modelCalls, 1);
    assert.equal(first.tasks[0].reuseEligibility.eligible, false);
    assert.ok(first.tasks[0].reuseEligibility.reasons.some(({ code }) => code === 'model_revision_unknown'));
    const saved = await new CacheStore(options.stateDir, fixtureRoot).readHead('review');
    assert.deepEqual(saved.record.provenance.finishReason, { kind: 'stop' });
    const second = await runReview(options);
    assert.equal(second.status, 'completed');
    assert.equal(second.totals.executed, 1);
    assert.equal(second.totals.reused, 0);
    assert.equal(second.totals.modelCalls, 1);
  } finally {
    await executor.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

runtimeTest('malformed JSON is rejected and known billed usage survives failure', async () => {
  const executor = await fakeExecutor(chunks('```json\n{}\n```', { kind: 'stop' }, { inputTokens: 10, outputTokens: 6 }));
  try {
    await assert.rejects(executor.execute({ request, repoRoot }), (error) => error.code === 'INVALID_JSON'
      && error.usage.inputTokens === 10 && error.usage.outputTokens === 6 && error.modelCalls === 1);
  } finally { await executor.dispose(); }
});

runtimeTest('truncation, tool finishes, unknown blocks and missing finish fail closed', async () => {
  const sequences = [
    chunks(output, { kind: 'max-tokens' }), chunks(output, { kind: 'tool-calls' }),
    [{ type: 'block-start', index: 0, blockType: 'tool-call' }],
    [{ type: 'new-unknown-block' }], chunks().slice(0, -1),
    [...chunks(), { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }],
  ];
  for (const sequence of sequences) {
    const executor = await fakeExecutor(sequence);
    try { await assert.rejects(executor.execute({ request, repoRoot }), (error) => error.modelCalls === 1 && error.usage === null); }
    finally { await executor.dispose(); }
  }
});

runtimeTest('known reasoning is ignored without entering visible JSON', async () => {
  const sequence = [
    { type: 'block-start', index: 3, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 3, text: 'private reasoning' },
    { type: 'block-end', index: 3, block: { type: 'reasoning', text: 'private reasoning' } }, ...chunks(),
  ];
  const executor = await fakeExecutor(sequence);
  try { assert.deepEqual((await executor.execute({ request, repoRoot })).output, output); }
  finally { await executor.dispose(); }
});

runtimeTest('approval, repository, user-only messages and tools are enforced before dispatch', async () => {
  let sent = 0;
  const executor = await fakeExecutor(chunks(), {}, () => { sent++; });
  try {
    await assert.rejects(executor.execute({ request, repoRoot: path.dirname(repoRoot) }), { code: 'REPOSITORY_NOT_APPROVED', modelCalls: 0 });
    await assert.rejects(executor.execute({ request: { ...request, tools: [{ name: 'shell' }] }, repoRoot }), { code: 'INVALID_REQUEST', modelCalls: 0 });
    await assert.rejects(executor.execute({ request: { ...request, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'history' }] }] }, repoRoot }), { code: 'INVALID_REQUEST' });
    assert.equal(sent, 0);
  } finally { await executor.dispose(); }
  const unapproved = await fakeExecutor(chunks(), { allowRemote: false });
  try { await assert.rejects(unapproved.execute({ request, repoRoot }), { code: 'REMOTE_NOT_APPROVED', modelCalls: 0 }); }
  finally { await unapproved.dispose(); }
});

runtimeTest('shared and per-executor request budgets consume failures without retrying', async () => {
  const budget = { used: 0, max: 2 };
  const executor = await fakeExecutor(chunks('{}'), { budget, maxRequests: 1 });
  try {
    await assert.rejects(executor.execute({ request, repoRoot }), { code: 'INVALID_OUTPUT', modelCalls: 1 });
    assert.equal(budget.used, 1);
    await assert.rejects(executor.execute({ request, repoRoot }), { code: 'REQUEST_BUDGET_EXHAUSTED', modelCalls: 0 });
    assert.equal(budget.used, 1);
  } finally { await executor.dispose(); }
  budget.used = 2;
  const second = await fakeExecutor(chunks(), { budget });
  try { await assert.rejects(second.execute({ request, repoRoot }), { code: 'REQUEST_BUDGET_EXHAUSTED', modelCalls: 0 }); }
  finally { await second.dispose(); }
});

runtimeTest('only the approved credential reference can resolve and secrets never enter identity', async () => {
  let resolver;
  let references = [];
  const secret = 'offline-fixture-key';
  const executor = await createDshExecutor(config(), {
    resolveCredential: async (reference) => { references.push(reference); return secret; },
    createAdapter: ({ modules, resolveCredential }) => {
      resolver = resolveCredential;
      return new class extends modules['@deepseek-ai/dsh-llm'].exports.LlmAdapter { async *stream() { yield* chunks(); } }();
    },
  });
  try {
    assert.deepEqual(references, []);
    await assert.rejects(resolver('OTHER_KEY'), { code: 'CREDENTIAL_REF_DENIED' });
    assert.equal(await resolver('DSH_INCREMENTAL_TEST_KEY'), secret);
    assert.deepEqual(references, ['DSH_INCREMENTAL_TEST_KEY']);
    assert.equal(JSON.stringify(executor.identity).includes(secret), false);
  } finally { await executor.dispose(); }
});

runtimeTest('pre-abort and disposal prevent extra calls; initialization identity is stable', async () => {
  const first = await fakeExecutor();
  const second = await fakeExecutor(chunks(), { maxRequests: 1, approvedRepoRoot: path.dirname(repoRoot) });
  assert.deepEqual(first.identity, second.identity);
  const controller = new AbortController(); controller.abort();
  try { await assert.rejects(first.execute({ request, repoRoot, signal: controller.signal }), { code: 'ABORTED', modelCalls: 0 }); }
  finally { await first.dispose(); await second.dispose(); }
  await assert.rejects(first.execute({ request, repoRoot }), { code: 'EXECUTOR_DISPOSED', modelCalls: 0 });
});

runtimeTest('disposal during repository validation prevents dispatch', async () => {
  let sent = 0;
  const executor = await fakeExecutor(chunks(), {}, () => { sent++; });
  const execution = executor.execute({ request, repoRoot });
  const rejected = assert.rejects(execution, { code: 'EXECUTOR_DISPOSED', modelCalls: 0 });
  await executor.dispose();
  await rejected;
  assert.equal(sent, 0);
});

runtimeTest('unknown provider finish labels are never copied into report errors', async () => {
  const providerDetail = 'offline_fixture_sensitive_detail';
  const executor = await fakeExecutor(chunks(output, { kind: providerDetail }));
  try {
    await assert.rejects(executor.execute({ request, repoRoot }), (error) => error.code === 'FINISH_UNKNOWN'
      && !JSON.stringify({ message: error.message, code: error.code }).toLowerCase().includes(providerDetail));
  } finally { await executor.dispose(); }
});

runtimeTest('timeout cancels the cooperative provider and preserves the consumed call', async () => {
  const executor = await createDshExecutor(config({ timeoutMs: 30 }), {
    createAdapter: ({ modules }) => new class extends modules['@deepseek-ai/dsh-llm'].exports.LlmAdapter {
      async *stream({ signal }) {
        await new Promise((resolve) => {
          const keepAlive = setTimeout(resolve, 200);
          signal.addEventListener('abort', () => { clearTimeout(keepAlive); resolve(); }, { once: true });
        });
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }(),
  });
  try { await assert.rejects(executor.execute({ request, repoRoot }), { code: 'ABORTED', usage: null, modelCalls: 1 }); }
  finally { await executor.dispose(); }
});

runtimeTest('actual old tool registry validates canonical outputs and renders JSON content', async () => {
  const modules = await loadDshModules(runtimeRoot);
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const tools = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const system = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href);
  const root = new modules['@deepseek-ai/cordis'].exports.Context();
  try {
    await root.plugin(system.default);
    await root.plugin(tools.ToolRuntime);
    root.tools.register(tools.defineTool({
      name: 'incremental_fixture', description: 'Offline canonical-output contract test', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ summary: 'canonical' }),
    }));
    const result = await root.tools.execute({ name: 'incremental_fixture', arguments: {}, callId: 'offline-fixture', signal: new AbortController().signal });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { summary: 'canonical' });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"summary":"canonical"}' }]);
  } finally { await root.fiber.dispose(); }
});

runtimeTest('advertised-route wire uses one fixed authenticated bounded GET with redirects forbidden', async () => {
  // Transport replacement is contained in a child process; no network request occurs.
  const script = `
    import { createDshExecutor } from ${JSON.stringify(new URL('../src/dsh-executor.js', import.meta.url).href)};
    let calls = 0, references = [], requests = [];
    const key = 'offline-metadata-fixture-key';
    globalThis.fetch = async (url, options) => {
      calls++;
      requests.push({ url: String(url), method: options.method, redirect: options.redirect,
        approvedCredential: new Headers(options.headers).get('authorization') === 'Bearer ' + key,
        bodyAbsent: options.body === undefined });
      if (calls === 1) return Response.json({ data: [{ id: 'fixture-model', name: 'Visible Fixture', owned_by: 'fixture-provider', revision: 'ignored-revision' },
        { id: 'unrelated', privateDetail: 'ignored-detail' }] });
      if (calls === 2) return Response.json({ data: [{ id: 'fixture-model', name: key, owned_by: 'bad\\u001bowner' }] });
      if (calls === 3) return Response.json({ data: [] });
      if (calls === 4) return new Response('x'.repeat(256 * 1024 + 1));
      return new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error(key)), 500);
        options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error(key)); }, { once: true });
      });
    };
    const executor = await createDshExecutor({
      runtimeRoot: ${JSON.stringify(runtimeRoot)}, provider: 'deepseek-official', model: 'fixture-model',
      connection: { adapter: 'deepseek', baseURL: 'https://example.invalid/fixed' },
      credentialEnv: 'OFFLINE_METADATA_ONLY', allowRemote: true, approvedRepoRoot: process.cwd(), timeoutMs: 30,
      reusePolicy: { mode: 'visible-model' },
    }, { resolveCredential: async (reference) => { references.push(reference); return key; } });
    try {
      const initialResolutions = references.length;
      const views = [];
      for (let i = 0; i < 5; i++) views.push(await executor.prepareRun({ repoRoot: process.cwd() }));
      process.stdout.write(JSON.stringify({ calls, requests, references, initialResolutions,
        firstIdentity: views[0].identity, secondModel: views[1].identity.advertisedModel,
        observations: views.map((view) => view.identityObservation), eligible: views.map((view) => view.reuseEligibility.eligible),
        containsCredential: JSON.stringify(views).includes(key),
      }));
    } finally { await executor.dispose(); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, timeout: 30000, windowsHide: true,
  });
  assert.equal(stderr, '');
  const observed = JSON.parse(stdout);
  assert.equal(observed.initialResolutions, 0);
  assert.equal(observed.calls, 5);
  assert.deepEqual(observed.references, Array(5).fill('OFFLINE_METADATA_ONLY'));
  for (const sent of observed.requests) assert.deepEqual(sent, {
    url: 'https://example.invalid/fixed/models', method: 'GET', redirect: 'error', approvedCredential: true, bodyAbsent: true,
  });
  assert.deepEqual(observed.firstIdentity.advertisedModel, { id: 'fixture-model', name: 'Visible Fixture', owned_by: 'fixture-provider' });
  assert.equal(observed.firstIdentity.model.immutableRevision, null);
  assert.equal(JSON.stringify(observed.firstIdentity).includes('ignored'), false);
  assert.deepEqual(observed.secondModel, { id: 'fixture-model' });
  assert.deepEqual(observed.eligible, [true, true, false, false, false]);
  assert.deepEqual(observed.observations.slice(2).map(({ reason }) => reason),
    ['model_not_advertised', 'model_metadata_too_large', 'model_metadata_timeout']);
  assert.ok(observed.observations.every(({ requestCount }) => requestCount === 1));
  assert.equal(observed.containsCredential, false);
});

runtimeTest('official DeepSeek wire excludes message metadata and cancels HTTP body after rejected tool calls', async () => {
  // A separate process contains the fetch replacement, even if the assertion fails.
  // The installed official adapter is used; no request reaches a network transport.
  const script = `
    import { createDshExecutor } from ${JSON.stringify(new URL('../src/dsh-executor.js', import.meta.url).href)};
    const originalFetch = globalThis.fetch;
    let requestCount = 0, abortObserved = false, cancelObserved = false, payload, requestUrl, approvedCredential;
    globalThis.fetch = async (url, options) => {
      requestCount += 1;
      requestUrl = String(url);
      approvedCredential = new Headers(options.headers).get('authorization') === 'Bearer offline-fixture-key';
      payload = JSON.parse(options.body);
      options.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
      const body = new ReadableStream({
        start(controller) {
          const frame = { choices: [{ delta: { tool_calls: [{
            index: 0, id: 'offline-call', function: { name: 'forbidden', arguments: '{}' },
          }] } }] };
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\\n\\n'));
        },
        cancel() { cancelObserved = true; },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    let executor, failure;
    try {
      executor = await createDshExecutor({
        runtimeRoot: ${JSON.stringify(runtimeRoot)}, provider: 'deepseek-official', model: 'offline-wire-audit',
        connection: { adapter: 'deepseek', baseURL: 'https://example.invalid', thinking: 'disabled', reasoningEffort: 'off' },
        credentialEnv: 'OFFLINE_WIRE_AUDIT_ONLY', allowRemote: true,
        approvedRepoRoot: process.cwd(), timeoutMs: 1500,
      }, { resolveCredential: async () => 'offline-fixture-key' });
      try {
        await executor.execute({
          repoRoot: process.cwd(), request: {
            system: 'frozen system',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'frozen input' }] }], tools: [],
          },
        });
      } catch (error) { failure = { code: error.code, modelCalls: error.modelCalls }; }
      process.stdout.write(JSON.stringify({
        failure, requestCount, abortObserved, cancelObserved, requestUrl, approvedCredential,
        messages: payload?.messages, toolCount: payload?.tools?.length ?? 0,
        maxTokens: payload?.max_tokens, thinking: payload?.thinking,
      }));
    } finally {
      await executor?.dispose();
      globalThis.fetch = originalFetch;
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, timeout: 30000, windowsHide: true,
  });
  assert.equal(stderr, '');
  const observed = JSON.parse(stdout);
  assert.deepEqual(observed.failure, { code: 'UNEXPECTED_BLOCK', modelCalls: 1 });
  assert.equal(observed.requestCount, 1);
  assert.equal(observed.requestUrl, 'https://example.invalid/chat/completions');
  assert.equal(observed.approvedCredential, true);
  assert.equal(observed.abortObserved, true);
  assert.equal(observed.cancelObserved, true);
  assert.deepEqual(observed.messages, [
    { role: 'system', content: 'frozen system' }, { role: 'user', content: 'frozen input' },
  ]);
  assert.equal(observed.toolCount, 0);
  assert.equal(observed.maxTokens, 4096);
  assert.deepEqual(observed.thinking, { type: 'disabled' });
});

runtimeTest('official pi-ai wire uses the fixed endpoint, approved credential and empty tools', async () => {
  const script = `
    import { createDshExecutor } from ${JSON.stringify(new URL('../src/dsh-executor.js', import.meta.url).href)};
    let calls = 0, requestUrl, payload, approvedCredential, references = [];
    globalThis.fetch = async (url, options) => {
      calls++;
      requestUrl = String(url);
      payload = JSON.parse(options.body);
      approvedCredential = new Headers(options.headers).get('authorization') === 'Bearer offline-fixture-key';
      const content = JSON.stringify(${JSON.stringify(output)});
      const frames = [
        { id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-fixture', choices: [{
          index: 0, delta: { role: 'assistant', content }, finish_reason: null,
        }] },
        { id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-fixture', choices: [{
          index: 0, delta: {}, finish_reason: 'stop',
        }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
      ];
      return new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\\n\\n').join('') + 'data: [DONE]\\n\\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const executor = await createDshExecutor({
      runtimeRoot: ${JSON.stringify(runtimeRoot)}, provider: 'incremental-wire-fixture', model: 'offline-fixture',
      connection: { adapter: 'pi-ai', baseURL: 'https://example.invalid/fixed/v1', api: 'openai-completions' },
      credentialEnv: 'OFFLINE_WIRE_AUDIT_ONLY', allowRemote: true, approvedRepoRoot: process.cwd(), timeoutMs: 1500,
    }, { resolveCredential: async (reference) => { references.push(reference); return 'offline-fixture-key'; } });
    try {
      const result = await executor.execute({ request: ${JSON.stringify(request)}, repoRoot: process.cwd() });
      process.stdout.write(JSON.stringify({
        calls, requestUrl, approvedCredential, references, output: result.output,
        modelCalls: result.modelCalls, inputTokens: result.usage?.inputTokens,
        messages: payload?.messages, tools: payload?.tools ?? [], maxTokens: payload?.max_tokens ?? payload?.max_completion_tokens,
      }));
    } finally { await executor.dispose(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, timeout: 30000, windowsHide: true,
  });
  const observed = JSON.parse(stdout);
  assert.equal(observed.calls, 1);
  assert.equal(observed.requestUrl, 'https://example.invalid/fixed/v1/chat/completions');
  assert.equal(observed.approvedCredential, true);
  assert.deepEqual(observed.references, ['OFFLINE_WIRE_AUDIT_ONLY']);
  assert.deepEqual(observed.output, output);
  assert.equal(observed.modelCalls, 1);
  assert.equal(observed.inputTokens, 8);
  assert.deepEqual(observed.tools, []);
  assert.equal(observed.maxTokens, 4096);
  assert.deepEqual(observed.messages, [
    { role: 'system', content: request.system }, { role: 'user', content: 'snapshot only' },
  ]);
});

runtimeTest('actual plugin registers its fixed tools on rc.6 and rejects path-like report identifiers', async () => {
  const modules = await loadDshModules(runtimeRoot);
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const tools = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const system = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href);
  const plugin = await import('../src/plugin.js');
  const root = new modules['@deepseek-ai/cordis'].exports.Context();
  try {
    await root.plugin(system.default);
    await root.plugin(tools.ToolRuntime);
    const fiber = await root.plugin(plugin, {
      ...config(), repoRoot, manifestPath: path.join(repoRoot, 'fixture-manifest-not-opened.json'),
      stateDir: path.join(path.dirname(repoRoot), 'fixture-state-not-created'),
    });
    assert.deepEqual(root.tools.schemas().map(({ name }) => name).sort(), ['incremental_plan', 'incremental_report', 'incremental_run']);
    assert.deepEqual(root.tools.get('incremental_run').parameters.properties.full.type, 'boolean');
    const result = await root.tools.execute({
      name: 'incremental_report', arguments: { runId: '../../foreign' }, callId: 'bad-report-id', signal: new AbortController().signal,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid runId/);
    const missing = await root.tools.execute({
      name: 'incremental_report', arguments: { runId: 'missing-fixture-run' }, callId: 'missing-report-id', signal: new AbortController().signal,
    });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /Review report not found: missing-fixture-run/);
    assert.doesNotMatch(JSON.stringify(missing.content), /Cannot read properties/);
    await fiber.dispose();
    assert.equal(root.tools.schemas().length, 0);
  } finally { await root.fiber.dispose(); }
});

runtimeTest('plugin disposal waits for operations already reading their manifest', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-incremental-dispose-'));
  const definitions = new Map();
  let dispose;
  try {
    const manifestPath = path.join(temporary, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, tasks: [{
      id: 'fixture', description: 'Offline cancellation fixture', inputs: { files: [], directories: [] },
      dependsOn: [], acceptance: ['No model call'],
    }] }));
    dispose = await applyPlugin({ tools: { register: (definition) => {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    } } }, { ...config(), repoRoot, manifestPath, stateDir: path.join(temporary, 'state') });
    const plan = definitions.get('incremental_plan');
    let settled = false;
    const operation = plan.execute({}, {}).then(() => { settled = true; }, () => { settled = true; });
    await dispose();
    assert.equal(settled, true, 'all operations must settle before plugin disposal completes');
    await operation;
    assert.equal(definitions.size, 0);
    await assert.rejects(plan.execute({}, {}), /disposed/);
  } finally {
    await dispose?.();
    await rm(temporary, { recursive: true, force: true });
  }
});

runtimeTest('public rc.6 profile loader composes and activates the declared bundle patch offline', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const runtimeRoot = ${JSON.stringify(runtimeRoot)};
    const repoRoot = ${JSON.stringify(repoRoot)};
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    const fromRuntime = (name) => import(pathToFileURL(require.resolve(name)).href);
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Network prohibited in bundle fixture'); };
    const [{ Context }, { Loader }, boot, tools, system] = await Promise.all([
      fromRuntime('@deepseek-ai/cordis'), fromRuntime('@deepseek-ai/cordis-plugin-loader'),
      fromRuntime('@deepseek-ai/dsh-app-boot'), fromRuntime('@deepseek-ai/dsh-tools'),
      fromRuntime('@deepseek-ai/dsh-system-prompt'),
    ]);
    const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-incremental-profile-'));
    const root = new Context();
    try {
      const profileName = 'incremental-offline-fixture';
      const profileDir = path.join(temporary, 'profiles', profileName);
      await mkdir(path.join(profileDir, 'node_modules'), { recursive: true });
      await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
        name: 'offline-profile', private: true, dsh: { profile: { bundles: ['dsh-incremental'] } },
      }));
      await symlink(repoRoot, path.join(profileDir, 'node_modules', 'dsh-incremental'), process.platform === 'win32' ? 'junction' : 'dir');
      const profile = boot.loadProfile('offline-test', profileName, path.join(runtimeRoot, 'package.json'), temporary);
      assert.equal(profile.layers.length, 1);
      assert.equal(profile.layers[0].packageName, 'dsh-incremental');
      const entries = boot.composeEntries([...profile.layers.map((layer) => layer.patches), [{
        id: 'incremental', config: {
          runtimeRoot, repoRoot, manifestPath: path.join(temporary, 'manifest-not-opened.json'),
          stateDir: path.join(temporary, 'state-not-created'), provider: 'deepseek-official',
          model: 'offline-fixture', credentialEnv: 'OFFLINE_ONLY_UNUSED', allowRemote: false,
          connection: { adapter: 'deepseek', baseURL: 'https://example.invalid' },
        },
      }]]);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].name, 'dsh-incremental');
      await root.plugin(system.default);
      await root.plugin(tools.ToolRuntime);
      await root.plugin(Loader, { baseUrl: pathToFileURL(profileDir).href + '/' });
      for (const entry of entries) await root.loader.create(entry);
      await root.loader.await();
      await boot.assertEntriesActivated(root, 'offline-test');
      const registered = root.tools.schemas().map(({ name }) => name).sort();
      assert.deepEqual(registered, ['incremental_plan', 'incremental_report', 'incremental_run']);
      await root.loader.remove('incremental');
      assert.equal(root.tools.schemas().length, 0);
      assert.equal(networkCalls, 0);
      process.stdout.write(JSON.stringify({ registered, networkCalls, profileLayers: profile.layers.length }));
    } finally {
      await root.fiber.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, timeout: 30000, windowsHide: true,
  });
  assert.deepEqual(JSON.parse(stdout), {
    registered: ['incremental_plan', 'incremental_report', 'incremental_run'], networkCalls: 0, profileLayers: 1,
  });
});
