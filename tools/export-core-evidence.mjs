import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { scoreReport } from '../src/benchmark.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Deliberately fixed sources: neither command-line arguments nor report paths select files.
const attempts = ['run-6gQjkT', 'run-02FG6R'];
const stageFiles = { initial: 'initial.report.json', unchanged: 'unchanged.report.json', 'pricing-changed': 'pricing-changed.report.json' };
const taskIds = ['auth', 'pricing', 'pagination', 'summary'];
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const timingFields = ['totalMs', 'snapshotMs', 'executionMs', 'cacheMs'];
const totalFields = ['executed', 'reused', 'failed', 'blocked', 'cancelled', 'modelCalls', 'knownModelCalls', 'unknownCallCounts', 'identityMs', ...timingFields];
const checkFields = ['allStagesPassed', 'unchangedKeepsAllVersions', 'unaffectedVersionsKept', 'affectedVersionsReplaced', 'exactlySixRealModelCalls', 'sixDurableDispatchAttempts', 'sharedBudgetRespected', 'freshRepositoryOutsideCache', 'builtinSourceReferenceValidated', 'initialMatchesBuiltinReference', 'pricingFixedMatchesBuiltinReferenceBeforeProvider', 'initialSnapshotRestoredBeforeProvider', 'providerInputsGuardedByBuiltinHashes', 'onlyDeclaredPricingSourceChanged', 'allConsumedSnapshotsVerified', 'noFatalError'];
const stageCheckFields = ['completed', 'allFourTasksPresent', 'expectedExecutions', 'expectedReuses', 'expectedModelCalls', 'realOfficialDshIdentity', 'explicitVisibleModelPolicy', 'advertisedRouteObserved', 'noUnknownCallCounts', 'noFailedBlockedOrCancelled', 'currentSourceValid', 'perTaskCallsConsistent', 'reportedTaskTotalsConsistent', 'allResultsReusable', 'unknownRevisionRisksRecorded', 'reusedResultsWithinTtl', 'usageRecordedForExecutions', 'noNewUsageOnReuse'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const fields = (value, names, project = text) => Object.fromEntries(names.filter(name => Object.hasOwn(value ?? {}, name)).map(name => [name, project(value[name])]));

// Allowlisted free text receives a second privacy guard; excluded objects are never copied.
function text(value) {
  if (value == null) return null;
  const result = String(value);
  if (/[a-z]:[\\/]|\\\\[^\\\s]|\/(?:Users|home|root|tmp|var|opt|etc|mnt|usr)\//iu.test(result)) return '[REDACTED_HOST_PATH_TEXT]';
  return result.replace(/\bS-1-\d+(?:-\d+)+\b/gu, '[REDACTED_SID]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[^\s"']+)/giu, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]+/giu, '[REDACTED_CREDENTIAL]');
}
function relative(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/iu.test(normalized) || normalized.split('/').includes('..')) return '[REDACTED_HOST_PATH]';
  return text(normalized);
}
const strings = value => list(value).map(text);
const usage = value => value == null ? null : Object.fromEntries(usageFields.map(name => [name, number(value[name])]));
const totals = value => value == null ? null : { ...fields(value, totalFields, number), usage: usage(value.usage) };
const reasons = value => list(value).map(item => typeof item === 'string' ? text(item) : fields(item, ['code', 'message', 'sourceTaskId']));
const validation = value => list(value).map(item => fields(item, ['name', 'status', 'version', 'note']));
const finding = value => ({ ...fields(value, ['id', 'title', 'evidence', 'severity']), path: relative(value.path), line: number(value.line) });
const output = value => value == null ? null : { summary: text(value.summary), findings: list(value.findings).map(finding), unknownDependencies: strings(value.unknownDependencies), limitations: strings(value.limitations) };
const policy = value => value == null ? null : { mode: text(value.mode), maxAgeMs: number(value.maxAgeMs) };
const observation = value => value == null ? null : { ...fields(value, ['kind', 'status', 'observedAt']), requestCount: number(value.requestCount), risks: strings(value.risks) };
const eligibility = value => value == null ? null : { eligible: boolean(value.eligible), reasons: reasons(value.reasons), risks: strings(value.risks), assurance: text(value.assurance) };
function snapshot(value) {
  return value == null ? null : {
    digest: text(value.digest),
    files: list(value.files).map(file => ({ path: relative(file.path), sha256: text(file.sha256), bytes: number(file.bytes) })),
    directories: list(value.directories).map(directory => ({ path: relative(directory.path), entries: list(directory.entries).map(entry => typeof entry === 'string' ? relative(entry) : fields(entry, ['name', 'type'])) })),
  };
}
function identity(value) {
  return value == null ? null : {
    ...fields(value, ['kind', 'version', 'adapter', 'isolation', 'protocol', 'runnerHash']),
    ...fields(value, ['maxTokens', 'timeoutMs'], number),
    model: { ...fields(value.model, ['provider', 'id', 'immutableRevision', 'assurance']), risks: strings(value.model?.risks) },
    advertisedModel: fields(value.advertisedModel, ['id', 'name', 'owned_by']),
    connection: fields(value.connection, ['adapter', 'thinking', 'reasoningEffort']),
    runtimeHashes: fields(value.runtimeHashes, ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-deepseek']),
  };
}

export function projectCoreTask(task) {
  return {
    ...fields(task, ['taskId', 'status', 'resultVersion']), reasons: reasons(task.reasons),
    output: output(task.output), modelCalls: number(task.modelCalls), usage: usage(task.usage),
    validation: validation(task.validation), reuseEligibility: eligibility(task.reuseEligibility),
    currentSourceValid: boolean(task.currentSourceValid), timing: fields(task.timing, timingFields, number),
    inputSnapshot: snapshot(task.inputSnapshot), upstreamVersions: fields(task.upstreamVersions, taskIds),
    cacheCheck: task.cacheCheck == null ? null : { ...fields(task.cacheCheck, ['status', 'checkedAt', 'createdAt', 'expiresAt']), ...fields(task.cacheCheck, ['maxAgeMs', 'ageMs'], number) },
    reusedFrom: task.reusedFrom == null ? null : { ...fields(task.reusedFrom, ['resultVersion', 'createdAt']), validation: validation(task.reusedFrom.validation) },
    error: task.error == null ? null : fields(task.error, ['code', 'message']),
  };
}
function score(value) {
  return { ...fields(value, ['method']), ...fields(value, ['summaryAvailable', 'summaryCurrentSourceValid'], boolean), ...fields(value, ['expectedCount', 'observedUniqueCount', 'matchedCount', 'knownFindingCoverage'], number), matchedIds: strings(value.matchedIds), missingIds: strings(value.missingIds), unmatchedFindings: list(value.unmatchedFindings).map(finding) };
}
function source(relativePath, bytes) { return { path: relative(relativePath), sha256: sha256(bytes) }; }

async function readAttempt(id) {
  const directory = `artifacts/core-acceptance/${id}`;
  const read = async filename => readFile(path.join(root, directory, filename), 'utf8');
  const [acceptanceBytes, referenceBytes, ledgerBytes] = await Promise.all(['acceptance.json', 'ground-truth.json', 'dispatch-ledger.jsonl'].map(read));
  const acceptance = JSON.parse(acceptanceBytes), reference = JSON.parse(referenceBytes);
  const stages = [];
  for (const stage of acceptance.stages) {
    const projected = { stage: text(stage.stage), status: text(stage.status), checks: fields(stage.checks, stageCheckFields, boolean) };
    if (stage.reportPath == null) {
      stages.push({ ...projected, sourceSnapshot: null, source: null, score: null, report: null });
      continue;
    }
    const filename = stageFiles[stage.stage];
    if (!filename || stage.reportPath !== filename) throw new Error('Unexpected core stage source');
    const bytes = await read(filename), report = JSON.parse(bytes);
    if (!isDeepStrictEqual(report.totals, stage.totals)) throw new Error('Core acceptance/stage totals mismatch');
    const sourceSnapshot = stage.stage === 'pricing-changed' ? 'pricingFixed' : 'initial';
    stages.push({
      ...projected, sourceSnapshot, source: source(`${directory}/${filename}`, bytes),
      score: score(scoreReport(report, reference.snapshots[sourceSnapshot])),
      report: {
        ...fields(report, ['schemaVersion'], number), ...fields(report, ['runId', 'startedAt', 'finishedAt', 'manifestDigest', 'mode', 'status', 'scope']),
        executor: identity(report.executor), reusePolicy: policy(report.reusePolicy), identityObservation: observation(report.identityObservation),
        tasks: list(report.tasks).map(projectCoreTask), totals: totals(report.totals),
      },
    });
  }
  const metadataRequests = stages.reduce((sum, stage) => sum + (stage.report?.identityObservation?.requestCount ?? 0), 0);
  const modelCalls = stages.reduce((sum, stage) => sum + (stage.report?.totals?.modelCalls ?? 0), 0);
  const dispatchAttempts = ledgerBytes.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'dispatch-attempt').length;
  if (dispatchAttempts !== acceptance.budget.durableDispatchAttempts || modelCalls !== acceptance.budget.executorDispatchedCalls) throw new Error('Core dispatch accounting mismatch');
  return {
    id, status: text(acceptance.status), ...fields(acceptance, ['startedAt', 'finishedAt', 'errorCode']),
    source: source(`${directory}/acceptance.json`, acceptanceBytes),
    sourceReference: { ...source(`${directory}/ground-truth.json`, referenceBytes), notice: text(reference.notice), outsideReviewedRepository: true },
    dispatchLedger: { ...source(`${directory}/dispatch-ledger.jsonl`, ledgerBytes), durableDispatchAttempts: dispatchAttempts },
    runtime: fields(acceptance.runtime, ['dshVersion', 'nodeVersion']),
    controls: fields(acceptance.controls, ['maxTokens', 'timeoutMs', 'concurrency', 'retries'], number),
    reusePolicy: policy(acceptance.reusePolicy), acceptedRisks: strings(acceptance.acceptedRisks),
    checks: fields(acceptance.checks, checkFields, boolean),
    accounting: { modelCalls, advertisedRouteMetadataRequests: metadataRequests, maxCallsForAttempt: number(acceptance.budget.maxCalls) },
    stages, limitations: strings(acceptance.limitations),
  };
}

/** Reads only the fixed retained runs; writes one portable evidence file. No provider access. */
export async function exportCoreEvidence() {
  const projectedAttempts = await Promise.all(attempts.map(readAttempt));
  const evidence = {
    schemaVersion: 1, kind: 'dsh-incremental-core-acceptance-evidence',
    projection: {
      method: 'Explicit allowlist projection of existing local core acceptance records; no new model calls.',
      excluded: ['absolute host paths', 'credential configuration and references', 'filesystem ownership, ACLs and SIDs', 'security configuration', 'full requests and prompt bodies', 'raw cache objects'],
      semanticValidation: 'Source-evidence validation and fixed-reference coverage do not establish conclusion correctness, completeness, precision, or equivalence.',
      metadataAccounting: 'Advertised-route metadata requests are recorded separately from review model calls and do not establish an immutable model revision.',
      missingValues: 'Unknown provider usage fields remain null; not-run stages have no report or score.',
    },
    accounting: {
      modelCallsInRetainedAttempts: projectedAttempts.reduce((sum, attempt) => sum + attempt.accounting.modelCalls, 0),
      advertisedRouteMetadataRequests: projectedAttempts.reduce((sum, attempt) => sum + attempt.accounting.advertisedRouteMetadataRequests, 0),
      historicalExperimentModelCalls: 46, earlierSmokeModelCalls: 2,
      cumulativeModelCalls: 58, authorizedCumulativeMaxModelCalls: 58,
      sessionAccountingNote: 'The 58-call session ledger comprises 46 historical experiment calls, two earlier smoke calls, four calls in the retained failed core attempt, and six in the passed attempt. This file exports only the two core attempts.',
    },
    attempts: projectedAttempts,
  };
  const destination = path.join(root, 'docs', 'evidence', 'core-acceptance.json');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await exportCoreEvidence();
  console.log(JSON.stringify({ path: 'docs/evidence/core-acceptance.json', accounting: evidence.accounting, attempts: evidence.attempts.map(attempt => ({ id: attempt.id, status: attempt.status, modelCalls: attempt.accounting.modelCalls })) }));
}
