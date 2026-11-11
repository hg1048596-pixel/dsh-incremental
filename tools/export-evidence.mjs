import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { digest } from '../src/value.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const timingFields = ['totalMs', 'snapshotMs', 'executionMs', 'cacheMs'];
const totalFields = ['runs', 'executed', 'reused', 'failed', 'blocked', 'cancelled', 'modelCalls', 'knownModelCalls', 'unknownCallCounts', 'runsWithUsage', ...timingFields];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const number = value => Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const list = value => Array.isArray(value) ? value : [];
const fields = (value, names, project = text) => Object.fromEntries(names.filter(name => Object.hasOwn(value ?? {}, name)).map(name => [name, project(value[name])]));

/** Defense in depth for allowlisted free text; excluded objects are never serialized. */
function text(value) {
  if (value == null) return null;
  // Drop the complete free-text field when a host path occurs, including paths with spaces.
  if (/[a-z]:[\\/]|\\\\[^\\\s]|\/(?:Users|home|root|tmp|var|opt|etc|mnt)\//iu.test(String(value))) return '[REDACTED_HOST_PATH_TEXT]';
  return String(value)
    .replace(/\b[A-Z]:[\\/][^\s"'<>;,)}\]]+/giu, '[REDACTED_HOST_PATH]')
    .replace(/\\\\[^\s"'<>;,)}\]]+/gu, '[REDACTED_HOST_PATH]')
    .replace(/\/(?:Users|home|root|tmp|var|opt|etc|mnt)\/[^\s"'<>;,)}\]]*/gu, '[REDACTED_HOST_PATH]')
    .replace(/\bS-1-\d+(?:-\d+)+\b/gu, '[REDACTED_SID]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[^\s"']+)/giu, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]+/giu, '[REDACTED_CREDENTIAL]');
}

function relativePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/iu.test(normalized) || normalized.split('/').includes('..')) return '[REDACTED_HOST_PATH]';
  return text(normalized);
}
const strings = value => list(value).map(text);
const usage = value => value == null ? null : Object.fromEntries(usageFields.map(name => [name, number(value[name])]));
const timing = value => Object.fromEntries(timingFields.map(name => [name, number(value?.[name])]));
const totals = value => ({ ...fields(value, totalFields, number), usage: usage(value?.usage) });
const reasons = value => list(value).map(item => typeof item === 'string' ? text(item) : fields(item, ['code', 'message', 'sourceTaskId']));
const eligibility = value => value == null ? null : { eligible: boolean(value.eligible), reasons: reasons(value.reasons) };
const validations = value => list(value).map(item => fields(item, ['name', 'status', 'version', 'note']));
const finding = value => ({ ...fields(value, ['id', 'title', 'evidence', 'severity']), path: relativePath(value?.path), line: number(value?.line) });
const output = value => value == null ? null : { summary: text(value.summary), findings: list(value.findings).map(finding), unknownDependencies: strings(value.unknownDependencies), limitations: strings(value.limitations) };
const file = value => ({ path: relativePath(value.path), sha256: text(value.sha256), bytes: number(value.bytes) });

function snapshot(value) {
  if (value == null) return null;
  return {
    ...fields(value, ['manifestSha256', 'digest']),
    files: Array.isArray(value.files) ? value.files.map(file) : Object.fromEntries(Object.entries(value.files ?? {}).map(([name, item]) => [relativePath(name), fields(item, ['sha256', 'bytes'], item => typeof item === 'number' ? number(item) : text(item))])),
    ...(value.directories ? { directories: list(value.directories).map(item => ({ path: relativePath(item.path), entries: list(item.entries).map(entry => typeof entry === 'string' ? relativePath(entry) : fields(entry, ['name', 'type'])) })) } : {}),
  };
}

function identity(value) {
  if (value == null) return null;
  return {
    ...fields(value, ['kind', 'version', 'implementationSha256', 'analyzer', 'adapter', 'isolation', 'protocol', 'runnerHash']),
    ...fields(value, ['maxTokens', 'timeoutMs'], number),
    ...(value.model ? { model: fields(value.model, ['provider', 'id', 'immutableRevision', 'assurance']) } : {}),
    ...(value.connection ? { connection: fields(value.connection, ['adapter', 'thinking', 'reasoningEffort']) } : {}),
    ...(value.runtimeHashes ? { runtimeHashes: fields(value.runtimeHashes, ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-deepseek']) } : {}),
  };
}

function score(value) {
  return {
    ...fields(value, ['method']),
    ...fields(value, ['summaryAvailable', 'summaryCurrentSourceValid'], boolean),
    ...fields(value, ['expectedCount', 'observedUniqueCount', 'matchedCount', 'knownFindingCoverage'], number),
    matchedIds: strings(value?.matchedIds), missingIds: strings(value?.missingIds), unmatchedFindings: list(value?.unmatchedFindings).map(finding),
  };
}

function successfulProvenance(record) {
  if (!record) return null;
  return {
    fingerprint: text(record.fingerprint), requestSha256: text(record.components?.request),
    requestBytes: number(record.provenance?.requestBytes), finishReason: text(record.provenance?.finishReason),
    versions: fields(record.components?.versions, ['core', 'implementationDigest', 'prompt', 'toolPolicy', 'validator']),
  };
}

function projectTask(task, cacheRecord) {
  const input = task.inputSnapshot ?? (cacheRecord ? { digest: cacheRecord.provenance?.inputDigest, files: cacheRecord.components?.files, directories: cacheRecord.components?.directories } : null);
  return {
    ...fields(task, ['taskId', 'status', 'resultVersion']),
    reasons: reasons(task.reasons), output: output(task.output), modelCalls: number(task.modelCalls), usage: usage(task.usage),
    validation: validations(task.validation), reuseEligibility: eligibility(task.reuseEligibility),
    currentSourceValid: boolean(task.currentSourceValid), timing: timing(task.timing), inputSnapshot: snapshot(input),
    inputSnapshotOrigin: task.inputSnapshot ? 'run-report' : cacheRecord ? 'matching-successful-cache-provenance' : 'not-retained-in-original-report',
    successfulProvenance: successfulProvenance(cacheRecord),
    error: task.error ? fields(task.error, ['code', 'message']) : null,
    rejectedOutputAudit: task.status === 'failed' ? {
      available: task.rejectedOutput != null, output: output(task.rejectedOutput),
      note: task.rejectedOutput != null ? 'Rejected output retained for audit; excluded from successful results and finding scores.' : 'The original experiment did not retain the rejected response body. Error, attempted call usage and partial validation are retained; no response is reconstructed.',
      failedAttempt: task.failedAttempt ? { fingerprint: text(task.failedAttempt.fingerprint), inputDigest: text(task.failedAttempt.inputDigest), requestSha256: task.failedAttempt.request ? digest(task.failedAttempt.request) : null } : null,
    } : null,
  };
}

/** Explicit projection: no recursive copying of benchmark, run, request, or cache objects. */
export function projectExperiment({ id, sourcePath, benchmarkBytes, stageRecords }) {
  const benchmark = JSON.parse(benchmarkBytes);
  const stages = new Map(stageRecords.map(item => [item.relativePath, item]));
  return {
    schemaVersion: 1, kind: 'dsh-incremental-portable-evidence', id,
    projection: {
      sourcePath: relativePath(sourcePath), sourceSha256: hash(benchmarkBytes), sourceSchemaVersion: number(benchmark.schemaVersion),
      method: 'Explicit allowlist projection of existing local synthetic experiment records; no new model calls.',
      excluded: ['credentials and credential configuration', 'absolute host paths and runtime installation locations', 'filesystem ownership, access-control lists and security identifiers', 'full requests, frozen source prompt bodies, and cache objects'],
      missingValues: 'Unknown or unrecorded measurements remain null. Missing rejected bodies and consumed snapshots are labeled explicitly.',
      semanticValidation: 'Source-evidence validation and fixed-reference coverage do not establish model conclusion correctness, completeness, precision, or equivalence.',
    },
    createdAt: text(benchmark.createdAt), mode: text(benchmark.mode), repetitions: number(benchmark.repetitions), requestedRepetitions: number(benchmark.requestedRepetitions), cancelled: boolean(benchmark.cancelled),
    protocol: benchmark.protocol ? { ...fields(benchmark.protocol, ['id', 'description', 'relationshipToBaseline']), ...fields(benchmark.protocol, ['supplementary', 'seededIncrementalState'], boolean) } : null,
    controls: {
      ...fields(benchmark.controls, ['concurrency', 'retries'], number),
      ...fields(benchmark.controls, ['changedPairOrder', 'permissionVerification', 'requestPresentation']),
      ...fields(benchmark.controls, ['fullAndIncrementalUseIdenticalChangedSnapshot', 'separateFullAndIncrementalStateDirectories', 'executorIdentityConsistent', 'groundTruthOutsideReviewedRepository', 'seededIncrementalState'], boolean),
      changedFiles: list(benchmark.controls?.changedFiles).map(relativePath),
    },
    budget: fields(benchmark.budget, ['max', 'dispatched'], number), totals: totals(benchmark.totals),
    trials: list(benchmark.trials).map(trial => ({
      repetition: number(trial.repetition), initialSnapshot: snapshot(trial.initialSnapshot), changedSnapshot: snapshot(trial.changedSnapshot), changedPairOrder: strings(trial.changedPairOrder),
      comparison: trial.comparison ? { ...fields(trial.comparison, ['exactSummaryEvidenceEqual'], boolean), ...fields(trial.comparison, ['executedTaskReduction', 'modelCallReduction', 'modelCallReductionFraction', 'observedWallTimeDifferenceMs'], number) } : null,
      stages: list(trial.stages).map(stage => {
        const source = stages.get(stage.rawReportPath);
        if (!source) throw new Error('Missing stage report');
        const run = JSON.parse(source.bytes);
        if (run.status !== stage.status || !isDeepStrictEqual(run.totals, stage.totals)) throw new Error('Benchmark/stage report mismatch');
        return {
          stage: text(stage.stage), full: boolean(stage.full), sourceSnapshot: text(stage.sourceSnapshot), status: text(stage.status), executorIdentity: identity(stage.executorIdentity), reuseEligibility: eligibility(stage.reuseEligibility),
          score: score(stage.score), totals: totals(stage.totals),
          consumedSnapshot: stage.consumedSnapshot ? { complete: boolean(stage.consumedSnapshot.complete), files: Object.fromEntries(Object.entries(stage.consumedSnapshot.files ?? {}).map(([name, sha256]) => [relativePath(name), text(sha256)])) } : null,
          run: { ...fields(run, ['runId', 'startedAt', 'finishedAt', 'mode', 'manifestDigest', 'scope']), sourcePath: relativePath(stage.rawReportPath), sourceSha256: hash(source.bytes), tasks: list(run.tasks).map(task => projectTask(task, source.cacheRecords?.get(task.resultVersion))) },
        };
      }),
    })),
    limitations: strings(benchmark.limitations),
  };
}

async function cacheRecordsFor(trialDirectory) {
  const records = new Map();
  for (const state of ['full-state', 'incremental-state']) {
    const directory = path.join(trialDirectory, state, 'repositories');
    let repositories;
    try { repositories = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const repository of repositories.filter(item => item.isDirectory())) {
      const objects = path.join(directory, repository.name, 'objects');
      for (const name of await readdir(objects)) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        const record = JSON.parse(await readFile(path.join(objects, name), 'utf8'));
        records.set(record.resultVersion, record);
      }
    }
  }
  return records;
}

export async function exportEvidence({ root = repositoryRoot, destination = path.join(root, 'docs', 'evidence') } = {}) {
  const summary = JSON.parse(await readFile(path.join(root, 'docs', 'measurement-summary.json'), 'utf8'));
  const filenames = { fixture: 'fixture.json', baseline: 'real-baseline.json', followup: 'real-numbered-followup.json' };
  const result = [];
  for (const [id, filename] of Object.entries(filenames)) {
    // Original relative pointers must stay inside the repository; never follow arbitrary source roots.
    const sourcePath = summary.localRawReports?.[id] ?? summary.rawReports?.[id];
    if (relativePath(sourcePath) !== sourcePath) throw new Error('Expected a repository-relative source report');
    const source = path.join(root, sourcePath), benchmarkBytes = await readFile(source, 'utf8');
    const benchmark = JSON.parse(benchmarkBytes), stageRecords = [];
    for (const trial of benchmark.trials) {
      let records;
      for (const stage of trial.stages) {
        if (relativePath(stage.rawReportPath) !== stage.rawReportPath) throw new Error('Invalid stage report location');
        const target = path.join(path.dirname(source), stage.rawReportPath), bytes = await readFile(target, 'utf8');
        records ??= await cacheRecordsFor(path.dirname(target));
        const run = JSON.parse(bytes), matching = new Map();
        for (const task of run.tasks) {
          const record = records.get(task.resultVersion);
          if (record && record.taskId === task.taskId && isDeepStrictEqual(record.output, task.output) && (task.status === 'reused' || record.provenance?.runId === run.runId)) matching.set(task.resultVersion, record);
        }
        stageRecords.push({ relativePath: stage.rawReportPath, bytes, cacheRecords: matching });
      }
    }
    const data = projectExperiment({ id, sourcePath, benchmarkBytes, stageRecords });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, filename), `${JSON.stringify(data, null, 2)}\n`);
    result.push({ id, path: filename, sourceSha256: data.projection.sourceSha256, repetitions: data.repetitions, stages: data.trials.flatMap(trial => trial.stages).length, modelCalls: data.totals.modelCalls });
  }
  const index = { schemaVersion: 1, kind: 'dsh-incremental-evidence-index', experiments: result, totalRealModelCalls: result.filter(item => item.id !== 'fixture').reduce((sum, item) => sum + item.modelCalls, 0), authorizedMaxModelCalls: summary.authorizedMaxModelCalls };
  await writeFile(path.join(destination, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await exportEvidence();
  console.log(JSON.stringify(result));
}
