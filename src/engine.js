import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { validateManifest, topologicalOrder } from './manifest.js';
import { snapshotTask } from './snapshot.js';
import { CacheStore } from './cache.js';
import { buildRequest, validateOutput, PROMPT_VERSION, TOOL_POLICY_VERSION, VALIDATOR_VERSION, SYSTEM_PROMPT } from './request.js';
import { abortIfNeeded, clone, digest, errorInfo, freeze, problem } from './value.js';

const CORE_VERSION='1';
// Invalidate caches when shipped policy/validation code changes without a version bump.
const implementationDigest = digest(await Promise.all(['engine.js','manifest.js','request.js','snapshot.js','cache.js','value.js'].map(async name=>[name,await readFile(new URL(name,import.meta.url),'utf8')])));

function eligibility(executor,snapshot,output,upstreamResults=[],securityPolicy={}) {
  const reasons=[];
  const risks=[...(executor.reuseEligibility?.risks||[])];
  if(executor.reuseEligibility?.eligible !== true) {
    for(const reason of executor.reuseEligibility?.reasons || ['executor_identity_unverified']) reasons.push(problem(typeof reason==='string'?reason:reason.code,typeof reason==='string'?reason:reason.message));
    if(!reasons.length) reasons.push(problem('executor_identity_unverified','Executor does not attest reuse eligibility'));
  }
  if(snapshot.assurance?.verified!==true) for(const reason of snapshot.assurance?.reasons?.length?snapshot.assurance.reasons:['permissions_unverified']) reasons.push(problem('permissions_unverified',String(reason)));
  if(securityPolicy.authorizationSource==='fixed_host_configuration' &&
      (securityPolicy.sandbox?.status!=='known'||securityPolicy.approval?.status!=='known')) {
    reasons.push(problem('host_policy_unverified','DSH sandbox or approval policy could not be verified for this operation'));
  }
  if(output?.unknownDependencies?.length) reasons.push(problem('unknown_dependencies',output.unknownDependencies.join('; ')));
  for(const result of upstreamResults) if(result.reuseEligibility?.eligible!==true) {
    reasons.push(problem('upstream_not_reusable',`Upstream ${result.taskId} is not eligible for reuse`,result.taskId));
  }
  for(const result of upstreamResults)risks.push(...(result.reuseEligibility?.risks||[]));
  return {eligible:reasons.length===0,reasons,risks:[...new Set(risks)].sort(),
    assurance:executor.reuseEligibility?.assurance??executor.identity?.model?.assurance??'executor_attested'};
}
function componentsFor(task,snapshot,upstream,request,executor,securityPolicy) {
  return {
    task:clone(task),repoIdentity:snapshot.repoIdentity,
    files:snapshot.files.map(({path,sha256,bytes})=>({path,sha256,bytes})),directories:snapshot.directories,
    permissions:snapshot.permissions,inputDigest:snapshot.digest,
    upstream:Object.fromEntries(Object.entries(upstream).map(([id,r])=>[id,r.resultVersion])),
    execution:clone(executor.identity),reusePolicy:clone(executor.cachePolicy??null),securityPolicy:clone(securityPolicy),request:digest(request),
    versions:{core:CORE_VERSION,implementationDigest,prompt:PROMPT_VERSION,toolPolicy:TOOL_POLICY_VERSION,validator:VALIDATOR_VERSION},
  };
}
function differences(old,current) {
  const pairs=[['task','task_definition_changed'],['repoIdentity','repository_identity_changed'],['files','file_content_or_membership_changed'],['directories','directory_listing_changed'],['permissions','permissions_changed'],['upstream','upstream_result_changed'],['execution','executor_or_model_changed'],['reusePolicy','reuse_policy_changed'],['securityPolicy','security_policy_changed'],['versions','implementation_or_policy_changed'],['request','request_changed']];
  return pairs.filter(([key])=>digest(old[key]??null)!==digest(current[key]??null)).map(([,code])=>problem(code,code.replaceAll('_',' ')));
}
function reuseDecision({cached,components,executor,snapshot,full,upstreamChanged,nowMs,securityPolicy}) {
  const reasons=[];
  const window=cacheWindow(cached.record,executor,nowMs);
  if(window?.reason)reasons.push(window.reason);
  if(full) reasons.push(problem('forced_full','Full execution was requested'));
  for(const id of upstreamChanged) reasons.push(problem('upstream_reran',`Upstream ${id} did not reuse its previous result`,id));
  reasons.push(...eligibility(executor,snapshot,undefined,[],securityPolicy).reasons);
  if(cached.reason) reasons.push(problem(cached.reason,cached.reason.replaceAll('_',' ')));
  if(cached.record) {
    if(cached.record.reuseEligibility?.eligible!==true) {
      const oldReasons=cached.record.reuseEligibility?.reasons || [];
      reasons.push(problem('previous_result_not_reusable','The previous result did not satisfy reuse conditions'));
      reasons.push(...oldReasons);
    }
    if(!cached.record.components || digest(cached.record.components)!==cached.record.fingerprint ||
        !cached.record.provenance?.request || digest(cached.record.provenance.request)!==cached.record.components?.request) {
      reasons.push(problem('cache_provenance_invalid','Cached fingerprint or recorded request is inconsistent'));
    } else reasons.push(...differences(cached.record.components,components));
  } else if(!cached.reason) reasons.push(problem('cache_missing','No committed result'));
  return {reuse:reasons.length===0,reasons:dedupeReasons(reasons),cacheCheck:window};
}
function clockMs(now) {
  const value=now();
  if(!Number.isSafeInteger(value)||!Number.isFinite(new Date(value).getTime()))throw new TypeError('now() must return a valid integer UTC timestamp');
  return value;
}
function cacheWindow(record,executor,nowMs) {
  if(!record||!executor.cachePolicy)return null;
  const maxAgeMs=executor.cachePolicy.maxAgeMs,created=Date.parse(record.createdAt);
  const valid=Number.isFinite(created)&&new Date(created).toISOString()===record.createdAt&&created<=nowMs&&Number.isFinite(new Date(created+maxAgeMs).getTime());
  const expired=valid&&nowMs-created>=maxAgeMs;
  return {checkedAt:new Date(nowMs).toISOString(),createdAt:record.createdAt,maxAgeMs,
    ageMs:valid?nowMs-created:null,expiresAt:valid?new Date(created+maxAgeMs).toISOString():null,
    status:!valid?'invalid_timestamp':expired?'expired':'within_window',
    ...(!valid?{reason:problem('cache_timestamp_invalid','Cached result timestamp is invalid or in the future')}:expired?{reason:problem('cache_expired','Cached result exceeded its configured maximum age')}:{})};
}
function dedupeReasons(reasons) {
  return [...new Map(reasons.map(reason=>[digest(reason),reason])).values()];
}
export function aggregateUsage(tasks) {
  const called=tasks.filter(task=>task.modelCalls!==0);
  if(!called.length) return null;
  const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'];
  return Object.fromEntries(fields.map(field=>[field,called.every(task=>Number.isFinite(task.usage?.[field]))?called.reduce((sum,task)=>sum+task.usage[field],0):null]));
}
function totalsFor(tasks,totalMs,identityMs=0) {
  return {
    executed:tasks.filter(t=>t.status==='executed').length,reused:tasks.filter(t=>t.status==='reused').length,
    failed:tasks.filter(t=>t.status==='failed').length,blocked:tasks.filter(t=>t.status==='blocked').length,
    cancelled:tasks.filter(t=>t.status==='cancelled').length,
    modelCalls:tasks.some(t=>t.modelCalls===null)?null:tasks.reduce((sum,t)=>sum+t.modelCalls,0),
    knownModelCalls:tasks.reduce((sum,t)=>sum+(t.modelCalls||0),0),unknownCallCounts:tasks.filter(t=>t.modelCalls===null).length,
    usage:aggregateUsage(tasks),totalMs,identityMs,
    snapshotMs:tasks.reduce((sum,t)=>sum+t.timing.snapshotMs,0),
    executionMs:tasks.reduce((sum,t)=>sum+t.timing.executionMs,0),
    cacheMs:tasks.reduce((sum,t)=>sum+t.timing.cacheMs,0),
  };
}
function assertExecutor(executor) {
  if(!executor || !executor.identity || typeof executor.execute!=='function') throw new TypeError('An executor with identity and execute() is required');
  if(executor.cachePolicy && (!['strict','visible-model'].includes(executor.cachePolicy.mode)||!Number.isSafeInteger(executor.cachePolicy.maxAgeMs)||executor.cachePolicy.maxAgeMs<1))throw new TypeError('Executor cachePolicy requires a known mode and positive maxAgeMs');
}
async function prepareExecutor(executor,context) {
  const prepared=typeof executor.prepareRun==='function'?await executor.prepareRun(context):executor;
  assertExecutor(prepared);return prepared;
}
function timing() {return {totalMs:0,snapshotMs:0,executionMs:0,cacheMs:0};}
function stateFor(task) {return {taskId:task.id,status:'blocked',reasons:[],resultVersion:null,output:null,usage:null,modelCalls:0,validation:[],reuseEligibility:{eligible:false,reasons:[]},currentSourceValid:false,timing:timing()};}
function reportsNormalStop(reason) {
  return reason==='stop' || (reason!==null && typeof reason==='object' && !Array.isArray(reason) &&
    reason.kind==='stop' && Object.keys(reason).length===1);
}

/** Execute one read-only, declared-input review DAG. No task-provided code runs. */
export async function runReview({repoRoot,manifest,executor,stateDir,full=false,signal,securityPolicy={network:'denied'},maxBytes=256*1024,permissionProvider,resumeFrom=null,prompt=SYSTEM_PROMPT,now=Date.now}) {
  assertExecutor(executor);
  const checked=validateManifest(manifest), tasks=topologicalOrder(checked.tasks);
  const store=new CacheStore(stateDir,repoRoot);
  const started=performance.now();
  const startedAt=new Date(clockMs(now)).toISOString(),identityStart=performance.now();
  executor=await prepareExecutor(executor,{repoRoot,signal});
  const identityMs=performance.now()-identityStart;
  const report={schemaVersion:1,runId:randomUUID(),startedAt,finishedAt:null,repoRoot,
    manifest:clone(checked),manifestDigest:digest(checked),mode:full?'full':'incremental',resumeFrom,
    executor:clone(executor.identity),reusePolicy:clone(executor.cachePolicy??null),identityObservation:clone(executor.identityObservation??null),
    securityPolicy:clone(securityPolicy),status:'running',tasks:[],totals:null,
    scope:'Declared immutable inputs only; cache validity is not conclusion correctness.',
  };
  await store.acquire();
  const snapshots=new Map(), completed=new Map(), states=new Map();
  try {
    if(resumeFrom) {
      const previous=await store.readReport(resumeFrom);
      if(!previous) throw Object.assign(new Error('Resume run report does not exist'),{code:'RESUME_NOT_FOUND'});
      if(previous.manifestDigest!==report.manifestDigest) throw Object.assign(new Error('Resume manifest differs; start a new run instead'),{code:'RESUME_MANIFEST_CHANGED'});
    }
    await store.writeReport(report);
    for(const task of tasks) {
      const entry=stateFor(task), taskStart=performance.now();
      report.tasks.push(entry);states.set(task.id,entry);
      let generation=null,response=null,attemptProvenance=null;
      try {
        abortIfNeeded(signal);
        const failedDeps=task.dependsOn.filter(id=>!completed.has(id));
        if(failedDeps.length) {
          entry.status='blocked';entry.reasons=failedDeps.map(id=>problem('upstream_failed',`No current successful result for ${id}`,id));
          generation=await store.begin(task.id,report.runId);
          await store.fail(task.id,generation,'blocked',entry.reasons);
          continue;
        }
        const snapStart=performance.now();
        const snapshot=await snapshotTask(repoRoot,task.inputs,{maxBytes,signal,permissionProvider});
        entry.timing.snapshotMs+=performance.now()-snapStart;snapshots.set(task.id,snapshot);
        entry.inputSnapshot={digest:snapshot.digest,files:snapshot.files.map(({path,sha256,bytes})=>({path,sha256,bytes})),directories:clone(snapshot.directories)};
        const upstream=Object.fromEntries(task.dependsOn.map(id=>{
          const result=completed.get(id);return [id,{resultVersion:result.resultVersion,output:result.output}];
        }));
        entry.upstreamVersions=Object.fromEntries(Object.entries(upstream).map(([id,result])=>[id,result.resultVersion]));
        const request=buildRequest(task,snapshot,upstream,{prompt});
        const requestBytes=Buffer.byteLength(JSON.stringify(request),'utf8');
        if(requestBytes>maxBytes) throw Object.assign(new Error(`Complete task request ${requestBytes} exceeds ${maxBytes} bytes; split the task`),{code:'INPUT_TOO_LARGE'});
        const components=componentsFor(task,snapshot,upstream,request,executor,securityPolicy);
        const fingerprint=digest(components);
        const cacheStart=performance.now();
        const cached=await store.readHead(task.id,{quarantine:true});
        const decision=reuseDecision({cached,components,executor,snapshot,full,upstreamChanged:task.dependsOn.filter(id=>states.get(id).status!=='reused'),nowMs:clockMs(now),securityPolicy});
        entry.timing.cacheMs+=performance.now()-cacheStart;entry.reasons=decision.reasons;entry.cacheCheck=decision.cacheCheck;
        let reuseValidation=[];
        if(decision.reuse) {
          try {reuseValidation=validateOutput(cached.record.output,snapshot,upstream);}
          catch(error) {decision.reuse=false;entry.reasons.push(problem('cached_output_invalid',error.message));}
        }
        if(decision.reuse) {
          entry.status='reused';entry.output=clone(cached.record.output);entry.resultVersion=cached.record.resultVersion;
          entry.validation=[...reuseValidation,{name:'cache_provenance_match',status:'passed',version:CORE_VERSION}];
          entry.reuseEligibility=clone(cached.record.reuseEligibility);
          entry.currentSourceValid=true;entry.reusedFrom={resultVersion:cached.record.resultVersion,createdAt:cached.record.createdAt,
            validation:clone(cached.record.validation)};
          completed.set(task.id,cached.record);
        } else {
          generation=await store.begin(task.id,report.runId);
          attemptProvenance={fingerprint,request:clone(request),inputDigest:snapshot.digest};
          const executionStart=performance.now();
          entry.modelCalls=null;
          try {response=await executor.execute({task,snapshot:freeze(snapshot),upstream:freeze(upstream),request,signal,repoRoot});}
          finally {entry.timing.executionMs+=performance.now()-executionStart;}
          entry.modelCalls=response.modelCalls??null;entry.usage=response.usage??null;
          abortIfNeeded(signal);
          // A syntactically complete JSON body can still come from an interrupted or
          // truncated generation. Never promote an explicitly incomplete response.
          if(response.finishReason!==undefined && response.finishReason!==null && !reportsNormalStop(response.finishReason)) {
            throw Object.assign(new Error('Executor did not report a normal completed response'),{code:'EXECUTION_INCOMPLETE'});
          }
          entry.validation=validateOutput(response.output,snapshot,upstream);
          entry.validation.push({name:'execution_completed',status:'passed',version:CORE_VERSION,
            note:reportsNormalStop(response.finishReason)?'Executor reported stop.':'Trusted executor returned normally without a provider finish reason.'});
          entry.validation.push({name:'request_has_no_tools',status:'passed',version:TOOL_POLICY_VERSION});
          const postStart=performance.now();
          const after=await snapshotTask(repoRoot,task.inputs,{maxBytes,signal,permissionProvider});
          entry.timing.snapshotMs+=performance.now()-postStart;
          if(after.digest!==snapshot.digest) throw Object.assign(new Error('Declared input or permissions changed during task execution'),{code:'SNAPSHOT_DRIFT'});
          entry.validation.push({name:'snapshot_stable_after_execution',status:'passed',version:CORE_VERSION});
          entry.reuseEligibility=eligibility(executor,snapshot,response.output,task.dependsOn.map(id=>completed.get(id)),securityPolicy);
          const record={schemaVersion:1,taskId:task.id,resultVersion:generation,fingerprint,components,
            output:clone(response.output),validation:clone(entry.validation),reuseEligibility:entry.reuseEligibility,createdAt:new Date(clockMs(now)).toISOString(),
            provenance:{runId:report.runId,request:clone(request),requestBytes,executor:clone(executor.identity),
              reusePolicy:clone(executor.cachePolicy??null),identityObservation:clone(executor.identityObservation??null),
              securityPolicy:clone(securityPolicy),
              inputDigest:snapshot.digest,scope:report.scope,usage:entry.usage,modelCalls:entry.modelCalls,
              finishReason:response.finishReason??null},
          };
          const commitStart=performance.now();await store.commit(task.id,generation,record);entry.timing.cacheMs+=performance.now()-commitStart;
          entry.status='executed';entry.output=record.output;entry.resultVersion=generation;entry.currentSourceValid=true;
          completed.set(task.id,record);
        }
      } catch(error) {
        entry.status=signal?.aborted || error.code==='CANCELLED' || error.name==='AbortError'?'cancelled':'failed';
        entry.reasons.push(problem(error.code||'execution_failed',error.message));
        entry.error=errorInfo(error);entry.validation=error.validation||entry.validation;
        if(attemptProvenance)entry.failedAttempt=attemptProvenance;
        if(response?.output)entry.rejectedOutput=clone(response.output);
        entry.modelCalls=response?.modelCalls??error.modelCalls??entry.modelCalls;
        entry.usage=response?.usage??error.usage??entry.usage;
        // Global cancellation before an execution generation starts must not
        // retire an untouched committed result. Resume still rechecks all inputs
        // and upstream versions before it can reuse that result.
        if(!generation && !signal?.aborted) generation=await store.begin(task.id,report.runId);
        if(generation) await store.fail(task.id,generation,entry.status,errorInfo(error));
      } finally {
        entry.timing.totalMs=performance.now()-taskStart;
        report.totals=totalsFor(report.tasks,performance.now()-started,identityMs);
        await store.writeReport(report);
      }
    }
    // Revalidate successful branches after the whole DAG, including cache hits.
    const drifted=new Map();
    for(const task of tasks) {
      if(!completed.has(task.id)) continue;
      const entry=states.get(task.id),checkStart=performance.now();
      try {
        const current=await snapshotTask(repoRoot,task.inputs,{maxBytes,permissionProvider});
        if(current.digest!==snapshots.get(task.id).digest) drifted.set(task.id,problem('source_changed_before_finish','Inputs or permissions changed before the run finished',task.id));
      } catch(error) {drifted.set(task.id,problem('source_changed_before_finish',error.message,task.id));}
      entry.timing.snapshotMs+=performance.now()-checkStart;
      entry.timing.totalMs+=performance.now()-checkStart;
    }
    for(const task of tasks) {
      const parent=task.dependsOn.find(id=>drifted.has(id));
      if(parent && !drifted.has(task.id)) drifted.set(task.id,problem('upstream_source_changed','Upstream became stale before run completion',parent));
      if(completed.has(task.id)) states.get(task.id).validation.push({name:'inputs_and_upstream_current_at_finish',
        status:drifted.has(task.id)?'failed':'passed',version:CORE_VERSION});
      if(!drifted.has(task.id) || !completed.has(task.id)) continue;
      const entry=states.get(task.id);entry.currentSourceValid=false;
      entry.reuseEligibility={...entry.reuseEligibility,eligible:false,reasons:[drifted.get(task.id)]};entry.reasons.push(drifted.get(task.id));
      const generation=await store.begin(task.id,report.runId);
      await store.fail(task.id,generation,'stale',drifted.get(task.id));
    }
    report.totals=totalsFor(report.tasks,performance.now()-started,identityMs);
    report.status=report.totals.cancelled?'cancelled':report.tasks.every(t=>['executed','reused'].includes(t.status)&&t.currentSourceValid)?'completed':report.tasks.some(t=>['executed','reused'].includes(t.status))?'partial':'failed';
    report.finishedAt=new Date(clockMs(now)).toISOString();
    await store.writeReport(report);
    return report;
  } finally {await store.release();}
}

/** Read-only preview: never creates a state directory, lock or model request. */
export async function planReview({repoRoot,manifest,executor,stateDir,full=false,signal,securityPolicy={network:'denied'},maxBytes=256*1024,permissionProvider,prompt=SYSTEM_PROMPT,now=Date.now}) {
  assertExecutor(executor);
  const checked=validateManifest(manifest), store=new CacheStore(stateDir,repoRoot), entries=[], candidates=new Map();
  executor=await prepareExecutor(executor,{repoRoot,signal});
  for(const task of topologicalOrder(checked.tasks)) {
    abortIfNeeded(signal);
    const entry={taskId:task.id,status:'would_execute',reasons:[]};entries.push(entry);
    const blockedParents=task.dependsOn.filter(id=>entries.find(e=>e.taskId===id).status==='blocked');
    if(blockedParents.length) {
      entry.status='blocked';entry.reasons=blockedParents.map(id=>problem('upstream_blocked',`Upstream ${id} cannot execute`,id));continue;
    }
    try {
      const snapshot=await snapshotTask(repoRoot,task.inputs,{maxBytes,signal,permissionProvider});
      const upstream=Object.fromEntries(task.dependsOn.map(id=>[id,candidates.get(id)?{resultVersion:candidates.get(id).resultVersion,output:candidates.get(id).output}:{resultVersion:'pending',output:{summary:'Pending upstream execution',findings:[],unknownDependencies:[],limitations:[]}}]));
      const request=buildRequest(task,snapshot,upstream,{prompt});
      if(Buffer.byteLength(JSON.stringify(request))>maxBytes) throw Object.assign(new Error('Complete task request exceeds input bound'),{code:'INPUT_TOO_LARGE'});
      const components=componentsFor(task,snapshot,upstream,request,executor,securityPolicy);
      const cached=await store.readHead(task.id);
      const decision=reuseDecision({cached,components,executor,snapshot,full,upstreamChanged:task.dependsOn.filter(id=>entries.find(e=>e.taskId===id).status!=='would_reuse'),nowMs:clockMs(now),securityPolicy});
      if(decision.reuse) {
        try{validateOutput(cached.record.output,snapshot,upstream);}
        catch(error){decision.reuse=false;decision.reasons.push(problem('cached_output_invalid',error.message));}
      }
      entry.status=decision.reuse?'would_reuse':'would_execute';entry.reasons=decision.reasons;entry.cacheCheck=decision.cacheCheck;
      entry.reuseEligibility=eligibility(executor,snapshot,undefined,[],securityPolicy);
      if(cached.record)candidates.set(task.id,cached.record);
    } catch(error) {entry.status='blocked';entry.reasons=[problem(error.code||'input_error',error.message)];}
  }
  return {schemaVersion:1,kind:'plan',repoRoot,tasks:entries,reusePolicy:clone(executor.cachePolicy??null),identityObservation:clone(executor.identityObservation??null),
    scope:'Read-only preview; no model completion requests executed. Approved model metadata may be queried.'};
}
