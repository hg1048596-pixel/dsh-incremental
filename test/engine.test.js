import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runReview, planReview } from '../src/engine.js';
import { validateManifest } from '../src/manifest.js';
import { CacheStore } from '../src/cache.js';
import { validateOutput } from '../src/request.js';

const permissions=async paths=>({verified:true,entries:paths.map(path=>({path,owner:'test-user',dacl:'read'})),reasons:[]});
async function setup(t) {
  const base=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'dsh-incremental-engine-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const repoRoot=path.join(base,'repo'),stateDir=path.join(base,'state');
  await fs.mkdir(repoRoot);await fs.writeFile(path.join(repoRoot,'a.js'),'export const a = 1;\n');await fs.writeFile(path.join(repoRoot,'b.js'),'export const b = 2;\n');
  const manifest={schemaVersion:1,tasks:[
    {id:'a',description:'Review a only',inputs:{files:['a.js'],directories:[]},dependsOn:[],acceptance:['Return source-grounded observations']},
    {id:'b',description:'Review b only',inputs:{files:['b.js'],directories:[]},dependsOn:[],acceptance:['Return source-grounded observations']},
    {id:'summary',description:'Summarize upstream findings',inputs:{files:[],directories:[]},dependsOn:['a','b'],acceptance:['Use upstream results only']},
  ]};
  const calls=[];
  const executor={identity:{kind:'fixture',version:'1'},reuseEligibility:{eligible:true,reasons:[]},async execute({task,request}){
    calls.push(task.id);assert.deepEqual(request.tools,[]);assert(Object.isFrozen(request));
    return {output:{summary:'Scoped result',findings:[],unknownDependencies:[],limitations:[]},modelCalls:0,usage:null};
  }};
  return {base,repoRoot,stateDir,manifest,executor,calls,permissionProvider:permissions};
}
const statuses=report=>Object.fromEntries(report.tasks.map(task=>[task.taskId,task.status]));
test('first run, unchanged reuse, selective changes, and read-only preview',async t=>{
  const options=await setup(t);
  const preview=await planReview(options);assert(preview.tasks.every(x=>x.status==='would_execute'));
  await assert.rejects(fs.stat(options.stateDir),{code:'ENOENT'});
  const first=await runReview(options);assert.equal(first.status,'completed');assert.equal(first.totals.executed,3);
  const second=await runReview(options);assert.equal(second.totals.reused,3);assert.deepEqual(options.calls,['a','b','summary']);
  assert((await planReview(options)).tasks.every(x=>x.status==='would_reuse'));
  await fs.writeFile(path.join(options.repoRoot,'a.js'),'export const a = 3;\n');
  const changed=await runReview(options);assert.deepEqual(statuses(changed),{a:'executed',b:'reused',summary:'executed'});
  assert(changed.tasks[2].reasons.some(r=>r.code==='upstream_reran'&&r.sourceTaskId==='a'));
  assert.notEqual(changed.tasks[0].resultVersion,first.tasks[0].resultVersion);
  assert.equal(changed.tasks[0].output.summary,first.tasks[0].output.summary);
});
test('mtime is not a content hash and undeclared changes stay outside scope',async t=>{
  const o=await setup(t);await runReview(o);
  const file=path.join(o.repoRoot,'a.js'),before=await fs.stat(file);
  await fs.utimes(file,new Date(),new Date());assert.equal((await runReview(o)).totals.reused,3);
  await fs.writeFile(file,'export const a = 9;\n');await fs.utimes(file,before.atime,before.mtime);
  assert.equal((await runReview(o)).tasks[0].status,'executed');
  await fs.writeFile(path.join(o.repoRoot,'undeclared.js'),'outside scope');assert.equal((await runReview(o)).totals.reused,3);
});
test('definitions, prompt, execution identity and security policy invalidate reuse',async t=>{
  const o=await setup(t);await runReview(o);
  o.manifest.tasks[0].acceptance.push('Additional review criterion');
  assert.deepEqual(statuses(await runReview(o)),{a:'executed',b:'reused',summary:'executed'});
  assert.equal((await runReview({...o,prompt:'Changed fixed review prompt'})).totals.executed,3);
  o.executor.identity.version='2';assert.equal((await runReview(o)).totals.executed,3);
  assert.equal((await runReview({...o,securityPolicy:{network:'denied',version:2}})).totals.executed,3);
});
test('unknown execution identity and reported dependencies prevent reuse',async t=>{
  const o=await setup(t);o.executor.reuseEligibility={eligible:false,reasons:['model_revision_unknown']};
  await runReview(o);const unknown=await runReview(o);assert.equal(unknown.totals.executed,3);
  assert(unknown.tasks[0].reasons.some(r=>r.code==='model_revision_unknown'));
  o.executor.reuseEligibility={eligible:true,reasons:[]};
  const execute=o.executor.execute;o.executor.execute=async args=>{const result=await execute(args);if(args.task.id==='a')result.output.unknownDependencies=['Missing environment contract'];return result;};
  await runReview(o);const again=await runReview(o);assert.deepEqual(statuses(again),{a:'executed',b:'reused',summary:'executed'});
  assert.equal(again.tasks[0].reuseEligibility.eligible,false);
  assert.equal(again.tasks[2].reuseEligibility.eligible,false);
  assert(again.tasks[2].reuseEligibility.reasons.some(reason=>reason.code==='upstream_not_reusable'));
});
test('permission changes invalidate and unverifiable permissions never hit',async t=>{
  const o=await setup(t);await runReview(o);
  const changed=await runReview({...o,permissionProvider:async paths=>({verified:true,entries:paths.map(path=>({path,owner:'test-user',dacl:'changed'})),reasons:[]})});
  assert.equal(changed.totals.executed,3);
  const unverified={...o,permissionProvider:async()=>({verified:false,entries:[],reasons:['ACL unavailable']})};
  await runReview(unverified);assert.equal((await runReview(unverified)).totals.executed,3);
});
test('failure supersedes old success, blocks descendants, preserves independent branches',async t=>{
  const o=await setup(t);await runReview(o);
  await fs.writeFile(path.join(o.repoRoot,'a.js'),'changed');
  const execute=o.executor.execute;o.executor.execute=async args=>{if(args.task.id==='a')throw Object.assign(new Error('synthetic failure'),{code:'TEST_FAIL',modelCalls:1,usage:{inputTokens:5,outputTokens:1}});return execute(args);};
  const failed=await runReview(o);assert.deepEqual(statuses(failed),{a:'failed',b:'reused',summary:'blocked'});assert.equal(failed.totals.modelCalls,1);
  assert.equal(failed.totals.usage.inputTokens,5);assert.equal(failed.totals.usage.cacheReadTokens,null);
  assert.equal((await new CacheStore(o.stateDir,o.repoRoot).readHead('a')).reason,'previous_failed');
  o.executor.execute=execute;const resumed=await runReview({...o,resumeFrom:failed.runId});
  assert.deepEqual(statuses(resumed),{a:'executed',b:'reused',summary:'executed'});
});
test('corrupt objects are misses and force rerun creates new upstream versions',async t=>{
  const o=await setup(t);const first=await runReview(o);const store=new CacheStore(o.stateDir,o.repoRoot);
  const {head}=await store.readHead('a');await fs.writeFile(path.join(store.directory,'objects',`${head.objectHash}.json`),'broken');
  const corrupt=await runReview(o);assert.deepEqual(statuses(corrupt),{a:'executed',b:'reused',summary:'executed'});
  assert(corrupt.tasks[0].reasons.some(r=>r.code==='cache_corrupt'));
  const full=await runReview({...o,full:true});assert.equal(full.totals.executed,3);assert.notEqual(full.tasks[1].resultVersion,first.tasks[1].resultVersion);
});
test('cancelled work is not a cache hit on resume',async t=>{
  const o=await setup(t),control=new AbortController();
  const execute=o.executor.execute;o.executor.execute=async args=>{const result=await execute(args);control.abort();return result;};
  const cancelled=await runReview({...o,signal:control.signal});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.totals.reused,0);
  o.executor.execute=execute;assert.equal((await runReview(o)).totals.executed,3);
});
test('a pre-cancelled run preserves committed heads and records cancellation without execution',async t=>{
  const o=await setup(t),first=await runReview(o),control=new AbortController();
  const store=new CacheStore(o.stateDir,o.repoRoot);
  control.abort();
  const cancelled=await runReview({...o,signal:control.signal});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.totals.cancelled,3);
  assert.deepEqual(statuses(cancelled),{a:'cancelled',b:'cancelled',summary:'cancelled'});
  assert.deepEqual(o.calls,['a','b','summary']);
  assert.equal((await store.readReport(cancelled.runId)).status,'cancelled');
  for(const task of first.tasks) {
    const {head,record}=await store.readHead(task.taskId);
    assert.equal(head.status,'success');assert.equal(record.resultVersion,task.resultVersion);
  }
  const resumed=await runReview({...o,resumeFrom:cancelled.runId});
  assert.equal(resumed.totals.reused,3);assert.equal(resumed.totals.executed,0);
  assert.deepEqual(o.calls,['a','b','summary']);
});
test('mid-run cancellation retires attempted work while preserving unvisited heads for revalidation',async t=>{
  const o=await setup(t),first=await runReview(o),control=new AbortController();
  const store=new CacheStore(o.stateDir,o.repoRoot);
  await fs.writeFile(path.join(o.repoRoot,'a.js'),'changed a');
  const execute=o.executor.execute;
  o.executor.execute=async args=>{const result=await execute(args);control.abort();return result;};
  const cancelled=await runReview({...o,signal:control.signal});
  assert.equal(cancelled.status,'cancelled');
  assert.deepEqual(statuses(cancelled),{a:'cancelled',b:'cancelled',summary:'cancelled'});
  const attempted=await store.readHead('a');
  assert.equal(attempted.head.status,'cancelled');assert.equal(attempted.record,null);
  for(const taskId of ['b','summary']) {
    const {head,record}=await store.readHead(taskId);
    assert.equal(head.status,'success');
    assert.equal(record.resultVersion,first.tasks.find(task=>task.taskId===taskId).resultVersion);
  }
  assert.deepEqual(o.calls,['a','b','summary','a']);
  o.executor.execute=execute;
  const resumed=await runReview({...o,resumeFrom:cancelled.runId});
  assert.deepEqual(statuses(resumed),{a:'executed',b:'reused',summary:'executed'});
  assert.notEqual(resumed.tasks[0].resultVersion,first.tasks[0].resultVersion);
  assert.equal(resumed.tasks[1].resultVersion,first.tasks[1].resultVersion);
  assert.notEqual(resumed.tasks[2].resultVersion,first.tasks[2].resultVersion);
  assert.equal(resumed.tasks[2].upstreamVersions.a,resumed.tasks[0].resultVersion);
});
test('end-of-run drift retires completed or reused ancestors and their descendants',async t=>{
  const o=await setup(t);await runReview(o);
  await fs.writeFile(path.join(o.repoRoot,'b.js'),'changed b');
  const execute=o.executor.execute;o.executor.execute=async args=>{if(args.task.id==='b')await fs.writeFile(path.join(o.repoRoot,'a.js'),'changed after a reuse');return execute(args);};
  const result=await runReview(o);assert.equal(result.status,'partial');
  assert.equal(result.tasks[0].status,'reused');assert.equal(result.tasks[0].currentSourceValid,false);
  assert.equal(result.tasks[2].currentSourceValid,false);
  o.executor.execute=execute;assert.deepEqual(statuses(await runReview(o)),{a:'executed',b:'reused',summary:'executed'});
});
test('input disappearance fails closed, and evidence must be in declared input',async t=>{
  const o=await setup(t);await runReview(o);await fs.unlink(path.join(o.repoRoot,'a.js'));
  assert.deepEqual(statuses(await runReview(o)),{a:'failed',b:'reused',summary:'blocked'});
  assert.throws(()=>validateOutput({summary:'x',findings:[{title:'invented',path:'secret.js',line:1,evidence:'secret',severity:'high'}],unknownDependencies:[],limitations:[]},{files:[]},{}),{code:'RESULT_INVALID'});
});
test('DAG malformed input rejected before any execution',async t=>{
  const o=await setup(t);o.manifest.tasks[0].dependsOn=['summary'];assert.throws(()=>validateManifest(o.manifest),{code:'MANIFEST_INVALID'});
  o.manifest.tasks[0].dependsOn=['missing'];assert.throws(()=>validateManifest(o.manifest),{code:'MANIFEST_INVALID'});
  o.manifest.tasks[0].dependsOn=[];o.manifest.allowRemote=true;assert.throws(()=>validateManifest(o.manifest),{code:'MANIFEST_INVALID'});
});
test('missing usage and call counters remain unknown after dispatch errors',async t=>{
  const o=await setup(t);o.executor.execute=async()=>{throw new Error('dispatch status unknown');};
  const result=await runReview(o);assert.equal(result.tasks[0].modelCalls,null);assert.equal(result.totals.modelCalls,null);
  assert.equal(result.totals.knownModelCalls,0);assert.equal(result.totals.unknownCallCounts,2);
  assert.equal(result.totals.usage.inputTokens,null);
});
test('missing resume report has an explicit diagnostic',async t=>{
  const o=await setup(t);
  await assert.rejects(runReview({...o,resumeFrom:'missing-report'}),{code:'RESUME_NOT_FOUND'});
});
test('directory additions, renames and deletions invalidate only that branch and descendants',async t=>{
  const o=await setup(t);await fs.mkdir(path.join(o.repoRoot,'module'));
  await fs.writeFile(path.join(o.repoRoot,'module','one.js'),'export const one = 1;');
  o.manifest.tasks[0].inputs={files:[],directories:['module']};
  await runReview(o);assert.equal((await runReview(o)).totals.reused,3);
  for(const mutate of [
    ()=>fs.writeFile(path.join(o.repoRoot,'module','new.js'),'export const two = 2;'),
    ()=>fs.rename(path.join(o.repoRoot,'module','new.js'),path.join(o.repoRoot,'module','renamed.js')),
    ()=>fs.unlink(path.join(o.repoRoot,'module','renamed.js')),
    ()=>fs.mkdir(path.join(o.repoRoot,'module','empty')),
  ]) {
    await mutate();const result=await runReview(o);
    assert.deepEqual(statuses(result),{a:'executed',b:'reused',summary:'executed'});
    assert(result.tasks[0].reasons.some(reason=>reason.code==='directory_listing_changed'));
  }
});
test('line-number presentation is deterministic and rejected output is retained only as failed audit data',async t=>{
  const o=await setup(t);const execute=o.executor.execute;
  o.executor.execute=async args=>{
    const payload=JSON.parse(args.request.messages[0].content[0].text);
    if(args.task.id==='a') {
      assert.deepEqual(payload.files[0].numberedLines[0],{line:1,text:'export const a = 1;'});
      return {output:{summary:'bad citation',findings:[{title:'Mismatch',path:'a.js',line:2,evidence:'export const a = 1;',severity:'low'}],unknownDependencies:[],limitations:[]},usage:null,modelCalls:0};
    }
    return execute(args);
  };
  const report=await runReview(o);assert.equal(report.tasks[0].status,'failed');
  assert.equal(report.tasks[0].output,null);assert.equal(report.tasks[0].rejectedOutput.summary,'bad citation');
  assert(report.tasks[0].failedAttempt.request);assert.equal(report.tasks[2].status,'blocked');
});

test('reports identify the exact frozen inputs and upstream versions for execution and reuse',async t=>{
  const o=await setup(t);const first=await runReview(o),second=await runReview(o);
  assert.deepEqual(second.tasks[0].inputSnapshot,first.tasks[0].inputSnapshot);
  assert.equal(first.tasks[0].inputSnapshot.files[0].path,'a.js');
  assert.match(first.tasks[0].inputSnapshot.files[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(first.tasks[0].inputSnapshot.files[0].bytes,Buffer.byteLength('export const a = 1;\n'));
  assert.equal(first.tasks[0].inputSnapshot.files[0].text,undefined);
  assert.deepEqual(first.tasks[2].upstreamVersions,{a:first.tasks[0].resultVersion,b:first.tasks[1].resultVersion});
  assert(second.tasks[0].validation.some(check=>check.name==='cache_provenance_match'));
  assert(second.tasks[0].validation.every(check=>check.name!=='execution_completed'));
  assert(second.tasks[0].reusedFrom.validation.some(check=>check.name==='execution_completed'));
  assert(second.tasks[0].validation.some(check=>check.name==='inputs_and_upstream_current_at_finish' && check.status==='passed'));
  const {record}=await new CacheStore(o.stateDir,o.repoRoot).readHead('a');
  assert.equal(record.provenance.finishReason,null,'do not invent a provider stop signal');
  assert(record.validation.some(check=>check.name==='execution_completed' && check.status==='passed'));
});

test('explicit incomplete finish reasons reject otherwise valid results and retire older success',async t=>{
  const o=await setup(t);await runReview(o);const execute=o.executor.execute;
  for(const finishReason of ['length','tool_calls','unknown',{kind:'length'}]) {
    o.executor.execute=async args=>{
      const response=await execute(args);
      return args.task.id==='a'?{...response,finishReason,modelCalls:1,usage:{inputTokens:7,outputTokens:2}}:response;
    };
    const result=await runReview({...o,full:true});
    assert.deepEqual(statuses(result),{a:'failed',b:'executed',summary:'blocked'});
    assert(result.tasks[0].reasons.some(reason=>reason.code==='EXECUTION_INCOMPLETE'));
    assert.equal(result.tasks[0].output,null);assert(result.tasks[0].rejectedOutput);
    assert.equal(result.totals.modelCalls,1);assert.equal(result.totals.usage.outputTokens,2);
    assert.equal((await new CacheStore(o.stateDir,o.repoRoot).readHead('a')).reason,'previous_failed');
  }
  for(const finishReason of ['stop',{kind:'stop'}]) {
    o.executor.execute=async args=>({...await execute(args),finishReason});
    const result=await runReview({...o,full:true});
    assert.equal(result.status,'completed');
    assert.deepEqual((await new CacheStore(o.stateDir,o.repoRoot).readHead('a')).record.provenance.finishReason,finishReason);
  }
});

test('visible-model TTL expires from creation and cache hits never extend the window',async t=>{
  const o=await setup(t);let time=Date.UTC(2026,10,11,0,0,0);
  o.now=()=>time;o.executor.cachePolicy={mode:'visible-model',maxAgeMs:1000};
  o.executor.reuseEligibility={eligible:true,reasons:[],risks:['model_revision_unverified','provider_update_undetectable']};
  const first=await runReview(o),created=first.tasks[0].resultVersion;
  time+=900;const hit=await runReview(o);assert.equal(hit.totals.reused,3);
  assert.equal(hit.tasks[0].cacheCheck.ageMs,900);assert.equal(hit.tasks[0].cacheCheck.status,'within_window');
  assert.equal(hit.tasks[0].resultVersion,created);
  assert(hit.tasks[2].reuseEligibility.risks.includes('model_revision_unverified'));
  time+=100;const plan=await planReview(o);assert(plan.tasks.every(task=>task.status==='would_execute'));
  assert(plan.tasks[0].reasons.some(reason=>reason.code==='cache_expired'));
  const expired=await runReview(o);assert.equal(expired.totals.executed,3);
  assert(expired.tasks[0].reasons.some(reason=>reason.code==='cache_expired'));
  assert.notEqual(expired.tasks[0].resultVersion,created);
});

test('cache policy changes invalidate matching content and full execution bypasses valid windows',async t=>{
  const o=await setup(t);o.executor.cachePolicy={mode:'visible-model',maxAgeMs:60000};
  await runReview(o);assert.equal((await runReview(o)).totals.reused,3);
  o.executor.cachePolicy={mode:'visible-model',maxAgeMs:120000};
  const changed=await runReview(o);assert.equal(changed.totals.executed,3);
  assert(changed.tasks[0].reasons.some(reason=>reason.code==='reuse_policy_changed'));
  const forced=await runReview({...o,full:true});assert.equal(forced.totals.executed,3);
  assert(forced.tasks.every(task=>task.reasons.some(reason=>reason.code==='forced_full')));
});

test('each plan and run prepares an isolated identity view without fingerprinting observation time',async t=>{
  const o=await setup(t);let preparations=0,name='Model A',eligible=true;
  const execute=o.executor.execute;
  o.executor.prepareRun=async ({repoRoot})=>{
    assert.equal(repoRoot,o.repoRoot);preparations++;
    return Object.freeze({
      identity:{...o.executor.identity,advertisedModel:{id:'route-model',name}},
      cachePolicy:{mode:'visible-model',maxAgeMs:60000},
      reuseEligibility:{eligible,reasons:eligible?[]:['model_metadata_unavailable'],risks:['model_revision_unverified']},
      identityObservation:{kind:'advertised_route',status:eligible?'observed':'unavailable',observedAt:String(preparations),requestCount:1,risks:['model_revision_unverified']},
      execute,
    });
  };
  const first=await runReview(o),hit=await runReview(o);
  assert.equal(preparations,2);assert.equal(hit.totals.reused,3);
  assert.notEqual(first.identityObservation.observedAt,hit.identityObservation.observedAt);
  assert.equal((await planReview(o)).tasks[0].status,'would_reuse');assert.equal(preparations,3);
  name='Model B';const renamed=await runReview(o);assert.equal(renamed.totals.executed,3);
  assert(renamed.tasks[0].reasons.some(reason=>reason.code==='executor_or_model_changed'));
  eligible=false;const unavailable=await runReview(o);assert.equal(unavailable.totals.executed,3);
  assert(unavailable.tasks[0].reasons.some(reason=>reason.code==='model_metadata_unavailable'));
  assert.equal(unavailable.tasks[0].reuseEligibility.eligible,false);
});

test('future or malformed result timestamps cannot be reused',async t=>{
  const o=await setup(t);const time=Date.UTC(2026,10,11);o.now=()=>time;
  o.executor.cachePolicy={mode:'visible-model',maxAgeMs:60000};
  for(const timestamp of [new Date(time+1).toISOString(),'not-a-timestamp']) {
    await runReview(o);const store=new CacheStore(o.stateDir,o.repoRoot);await store.acquire();
    try {
      const {record}=await store.readHead('a'),generation=await store.begin('a','timestamp-check');
      await store.commit('a',generation,{...record,resultVersion:generation,createdAt:timestamp});
    } finally {await store.release();}
    const report=await runReview(o);assert.equal(report.tasks[0].status,'executed');
    assert(report.tasks[0].reasons.some(reason=>reason.code==='cache_timestamp_invalid'));
  }
});

test('unknown DSH permissions prevent reuse and session security identities remain cache boundaries',async t=>{
  const o=await setup(t);
  o.securityPolicy={authorizationSource:'fixed_host_configuration',allowRemote:true,approvedRepoRoot:o.repoRoot,
    sandbox:{status:'known',mode:'read-only',workspaceRoot:o.repoRoot,sessionBound:true,sessionId:'session-one'},
    approval:{status:'known',effectivePolicy:'ask',source:'configured_default'}};
  await runReview(o);
  assert.equal((await runReview(o)).totals.reused,3);
  o.securityPolicy.sandbox.sessionId='session-two';
  const changed=await runReview(o);assert.equal(changed.totals.executed,3);
  assert(changed.tasks[0].reasons.some(reason=>reason.code==='security_policy_changed'));
  assert.equal(changed.securityPolicy.sandbox.sessionId,'session-two');
  const {record}=await new CacheStore(o.stateDir,o.repoRoot).readHead('a');
  assert.equal(record.components.securityPolicy.sandbox.sessionId,'session-two');
  assert.equal(record.provenance.securityPolicy.sandbox.sessionId,'session-two');
  o.securityPolicy.approval={status:'unknown',reason:'service unavailable'};
  const unknown=await runReview(o);assert.equal(unknown.totals.executed,3);
  assert(unknown.tasks.every(task=>task.reuseEligibility.eligible===false));
  assert(unknown.tasks[0].reasons.some(reason=>reason.code==='host_policy_unverified'));
});
