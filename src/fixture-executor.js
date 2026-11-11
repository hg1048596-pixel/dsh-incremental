import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const implementationSha256 = createHash('sha256')
  .update(readFileSync(new URL('./fixture-executor.js', import.meta.url)))
  .digest('hex');

const limitations = [
  'This is a deterministic rule-based synthetic fixture, not an AI review.',
  'Only the explicitly implemented source patterns are checked; other defects may be missed.',
];

function abortIfRequested(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
  }
}

function sourceFiles(snapshot) {
  if (!Array.isArray(snapshot?.files)) {
    throw new TypeError('The fixture executor requires snapshot.files with path and text fields');
  }
  return snapshot.files.filter((file) => typeof file.path === 'string' && typeof file.text === 'string');
}

function findLine(file, predicate) {
  const lines = file.text.split(/\r?\n/);
  const index = lines.findIndex(predicate);
  return index < 0 ? null : { path: file.path, line: index + 1, evidence: lines[index].trim() };
}

function inspectFile(file) {
  const findings = [];
  const role = findLine(file, (line) => /\.roles\.some\(.*\.includes\(['"]admin['"]\)/.test(line));
  if (role) {
    findings.push({
      title: 'Substring role matching grants account-management access',
      ...role,
      severity: 'high',
    });
  }

  if (/function\s+calculateLineTotal\b/.test(file.text)) {
    const quantity = findLine(file, (line) => /if\s*\(!Number\.isInteger\(quantity\)\)\s*\{/.test(line));
    if (quantity && /unitPrice\s*\*\s*quantity/.test(file.text)) {
      findings.push({
        title: 'Negative quantities produce a negative checkout charge',
        ...quantity,
        severity: 'medium',
      });
    }
  }

  const page = findLine(file, (line) => /return\s+items\.slice\(offset,\s*pageSize\)/.test(line));
  if (page && /const\s+offset\s*=\s*\(page\s*-\s*1\)\s*\*\s*pageSize/.test(file.text)) {
    findings.push({
      title: 'Pagination uses page size as an absolute slice end',
      ...page,
      severity: 'medium',
    });
  }
  return findings;
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = JSON.stringify([finding.path, finding.line, finding.evidence]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A synthetic deterministic analyzer. It never imports or executes repository code. */
export function createFixtureExecutor({ version = '1' } = {}) {
  return {
    identity: {
      kind: 'fixture',
      version: String(version),
      implementationSha256,
      analyzer: 'deterministic-synthetic-patterns-v1',
    },
    reuseEligibility: { eligible: true, reasons: [] },
    async execute({ task, snapshot, upstream = {}, signal }) {
      abortIfRequested(signal);
      const aggregate = task.id === 'summary';
      const findings = aggregate
        ? uniqueFindings(Object.values(upstream).flatMap((result) => result.output?.findings ?? []))
        : sourceFiles(snapshot).flatMap(inspectFile);
      abortIfRequested(signal);
      return {
        output: {
          summary: aggregate
            ? `Synthetic aggregate: ${findings.length} source-pattern finding(s) across ${Object.keys(upstream).length} module result(s).`
            : `Synthetic source-pattern scan: ${findings.length} finding(s) in the declared input files.`,
          findings,
          unknownDependencies: [],
          limitations: [...limitations],
        },
        usage: null,
        modelCalls: 0,
      };
    },
  };
}
