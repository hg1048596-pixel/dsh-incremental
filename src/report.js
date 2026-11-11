const cell=value=>String(value??'unknown').replaceAll('|','\\|').replaceAll('\n',' ');
const ms=value=>Number.isFinite(value)?`${value.toFixed(2)} ms`:'unknown';
export function renderReport(report) {
  const lines=[`# dsh-incremental ${report.kind==='plan'?'plan':`run ${report.runId}`}`,'',report.scope||'', ''];
  if(report.status)lines.push(`Status: **${report.status}**. Mode: ${report.mode}.`, '');
  lines.push('| Task | Status | Reason | Current source | Model calls | Time |','|---|---|---|---|---:|---:|');
  for(const task of report.tasks||[])lines.push(`| ${cell(task.taskId)} | ${cell(task.status)} | ${cell(task.reasons.map(r=>typeof r==='string'?r:`${r.code}${r.sourceTaskId?` (${r.sourceTaskId})`:''}`).join('; ')||'all reuse checks passed')} | ${task.currentSourceValid===undefined?'—':task.currentSourceValid?'checked':'not valid / not checked'} | ${cell(task.modelCalls??(report.kind==='plan'?'—':null))} | ${ms(task.timing?.totalMs)} |`);
  if(report.totals) {
    lines.push('',`Executed: ${report.totals.executed}; reused: ${report.totals.reused}; failed: ${report.totals.failed}; blocked: ${report.totals.blocked}; cancelled: ${report.totals.cancelled}.`,
      `Elapsed: ${ms(report.totals.totalMs)}; input checks: ${ms(report.totals.snapshotMs)}; executor: ${ms(report.totals.executionMs)}; cache: ${ms(report.totals.cacheMs)}.`,
      '',`Model calls: ${report.totals.modelCalls??'unknown'}; known calls: ${report.totals.knownModelCalls??report.totals.modelCalls}; attempts with unknown counts: ${report.totals.unknownCallCounts??0}.`,
      `Provider usage (missing counters remain unknown): \`${JSON.stringify(report.totals.usage)}\`.`,
      'Cache hits make no new model request; original generation usage is retained in result provenance and is not charged to this run.');
  }
  for(const task of report.tasks||[])if(task.output) {
    lines.push('',`## ${task.taskId}`, '',task.output.summary,'',`Result version: ${task.resultVersion}. Reusable: ${task.reuseEligibility?.eligible===true?'yes':'no'}.`);
    for(const reason of task.reuseEligibility?.reasons||[])lines.push(`- Reuse restriction: ${cell(reason.message||reason)}`);
    for(const finding of task.output.findings)lines.push(`- [${finding.severity}] ${finding.title} — ${finding.path}:${finding.line}; evidence: ${JSON.stringify(finding.evidence)}`);
    for(const limitation of task.output.limitations)lines.push(`- Limitation: ${limitation}`);
    lines.push('',`Validation performed: ${(task.validation||[]).map(v=>`${v.name}=${v.status}`).join(', ')}.`);
    if(task.reusedFrom?.validation)lines.push(`Original generation validation (not re-executed here): ${task.reusedFrom.validation.map(v=>`${v.name}=${v.status}`).join(', ')}.`);
  }
  lines.push('','Input/cache checks do not establish semantic dependency completeness or correctness of the model conclusions.','');
  return lines.join('\n');
}
