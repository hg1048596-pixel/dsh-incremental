#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, open, rename, unlink, mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readManifest } from '../src/manifest.js';
import { planReview, runReview } from '../src/engine.js';
import { createFixtureExecutor } from '../src/fixture-executor.js';
import { createDshExecutor } from '../src/dsh-executor.js';
import { inspectDshRuntime } from '../src/doctor.js';
import { CacheStore } from '../src/cache.js';
import { renderReport } from '../src/report.js';
import { runDemo, runBenchmark, runPairedBenchmark } from '../src/benchmark.js';

const help=`dsh-incremental 0.1.0 (Node >=22.13)

Commands:
  doctor [--runtime-root PATH] [--json]
  plan --repo PATH --manifest PATH [--state PATH] (--dsh-config PATH | --fixture)
  run --repo PATH --manifest PATH [--state PATH] [--full] (--dsh-config PATH | --fixture)
  resume --repo PATH --manifest PATH --run-id ID [--state PATH] (--dsh-config PATH | --fixture)
  report --repo PATH [--run-id ID] [--state PATH] [--json]
  demo [--output PATH]
  benchmark [--output PATH] [--repetitions 3]
  benchmark --dsh-config PATH --allow-synthetic-remote [--output PATH]
  benchmark --paired-only --dsh-config PATH --allow-synthetic-remote [--output PATH]

Review commands require --dsh-config; there is no default reviewer.
--fixture explicitly selects a deterministic synthetic diagnostic, NOT an AI reviewer.
Remote run requires human configuration with allowRemote and an exact approvedRepoRoot.
Benchmark's remote flag authorizes only its generated synthetic repositories.
State defaults to a per-user directory outside the reviewed repository.
--credential-file PATH may supply one private key instead of an environment variable.
The key is read privately for the configured reference and is never stored in results.
No commands install software, edit DSH core, or execute repository scripts.
`;
let values,positionals,command;
function parseOptions() {
  ({values,positionals}=parseArgs({allowPositionals:true,options:{
  help:{type:'boolean',short:'h'},repo:{type:'string'},manifest:{type:'string'},state:{type:'string'},
  'dsh-config':{type:'string'},fixture:{type:'boolean'},'runtime-root':{type:'string'},'run-id':{type:'string'},
  'credential-file':{type:'string'},
  output:{type:'string'},repetitions:{type:'string'},full:{type:'boolean'},json:{type:'boolean'},
  'allow-synthetic-remote':{type:'boolean'},
  'paired-only':{type:'boolean'},
  }}));
  command=positionals[0];
}
const defaultRuntime=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Programs','DeepSeek Harness','resources','dsh-app');
const defaultState=path.join(process.env.LOCALAPPDATA||process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'dsh-incremental');
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());
function required(name) {if(!values[name])throw new Error(`--${name} is required`);return values[name];}
async function configFile() {
  const data=await readFile(path.resolve(values['dsh-config']),'utf8');
  const config=JSON.parse(data);
  if(!config || typeof config!=='object' || Array.isArray(config)) throw new Error('Invalid DSH config');
  return config;
}
function credentialDependencies(config) {
  if(!values['credential-file'])return {};
  const credentialPath=path.resolve(values['credential-file']);
  return {resolveCredential:async reference=>{
    if(reference!==config.credentialEnv)throw new Error('Credential reference denied');
    const raw=await readFile(credentialPath);
    if(raw.length>65536)throw new Error('Credential file exceeds supported size');
    const secret=new TextDecoder('utf-8',{fatal:true}).decode(raw).trim();
    if(!/^[A-Za-z0-9_-]{16,}$/.test(secret))throw new Error('Credential file must contain a single bare key (contents omitted)');
    return secret;
  }};
}
async function outputTarget() {
  if(values.output) {
    const target=path.resolve(values.output);
    if(values.repo) {
      const repo=await realpath(path.resolve(values.repo));
      let existing=target;
      while(true) {
        try {await realpath(existing);break;}
        catch(error) {if(error.code!=='ENOENT')throw error;existing=path.dirname(existing);}
      }
      const resolvedTarget=path.resolve(await realpath(existing),path.relative(existing,target));
      const relative=path.relative(repo,resolvedTarget);
      if(relative==='' || (!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Report output must be outside the reviewed repository');
    }
    return target;
  }
  return null;
}
async function writeResult(value,markdown) {
  const content=values.json?`${JSON.stringify(value,null,2)}\n`:markdown;
  const target=await outputTarget();
  if(target) {
    await mkdir(path.dirname(target),{recursive:true});
    // Replacing the destination also preserves reviewed files reached through an
    // existing outside hard link; opening the destination for writing would not.
    const temporary=path.join(path.dirname(target),`.${path.basename(target)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle=await open(temporary,'wx',0o600);
      await handle.writeFile(content);await handle.close();handle=null;
      await outputTarget();
      await rename(temporary,target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    process.stdout.write(`${target}\n`);
  } else process.stdout.write(content.endsWith('\n')?content:`${content}\n`);
}
async function main() {
  parseOptions();
  if(values.help||!command) {process.stdout.write(help);return;}
  if(positionals.length!==1)throw new Error('Unexpected positional arguments');
  const allowedOptions={
    doctor:['runtime-root','json','output'],
    plan:['repo','manifest','state','dsh-config','fixture','credential-file','full','json','output'],
    run:['repo','manifest','state','dsh-config','fixture','credential-file','full','json','output'],
    resume:['repo','manifest','state','dsh-config','fixture','credential-file','full','run-id','json','output'],
    report:['repo','state','run-id','json','output'],
    demo:['output'],
    benchmark:['output','repetitions','dsh-config','credential-file','allow-synthetic-remote','paired-only'],
  };
  if(!allowedOptions[command])throw new Error(`Unknown command ${command}`);
  for(const name of Object.keys(values))if(!allowedOptions[command].includes(name))throw new Error(`--${name} is not supported by ${command}`);
  if(values.fixture&&values['dsh-config'])throw Object.assign(new Error('--fixture and --dsh-config are mutually exclusive'),{code:'EXECUTOR_CONFIGURATION_CONFLICT'});
  if(['plan','run','resume'].includes(command)&&!values['dsh-config']&&!values.fixture) {
    throw Object.assign(new Error(`${command} requires --dsh-config PATH for AI review; use --fixture only for explicit synthetic diagnostics`),{code:'MODEL_CONFIGURATION_REQUIRED'});
  }
  if(values['credential-file']&&!values['dsh-config'])throw new Error('--credential-file requires --dsh-config');
  if(values['paired-only']&&Object.hasOwn(values,'repetitions'))throw new Error('--paired-only does not accept --repetitions');
  if(command==='doctor') {
    const result=await inspectDshRuntime({runtimeRoot:path.resolve(values['runtime-root']||defaultRuntime)});
    await writeResult(result,JSON.stringify(result,null,2));if(!result.compatible)process.exitCode=1;return;
  }
  if(command==='demo'||command==='benchmark') {
    let executorFactory,maxModelCalls;
    if(values['dsh-config']) {
      if(command!=='benchmark'||!values['allow-synthetic-remote'])throw new Error('Remote synthetic experiments require benchmark --allow-synthetic-remote');
      const config=await configFile();maxModelCalls=Math.min(config.maxRequests??48,values['paired-only']?8:48);
      if(!Number.isSafeInteger(maxModelCalls)||maxModelCalls<1)throw new Error('Invalid experiment request budget');
      const budget={used:0,max:maxModelCalls};
      executorFactory=({repoRoot})=>createDshExecutor({...config,approvedRepoRoot:repoRoot,allowRemote:true,budget,maxTokens:Math.min(config.maxTokens??4096,4096),maxRequests:maxModelCalls},credentialDependencies(config));
    } else if(values['allow-synthetic-remote'])throw new Error('--allow-synthetic-remote requires --dsh-config');
    const options={outputDir:path.resolve(values.output||`artifacts/${command}`),signal:controller.signal,
      ...(executorFactory?{executorFactory,securityPolicy:{network:'synthetic-only',authorization:'explicit-cli'}}:{}),
      ...(maxModelCalls?{maxModelCalls}:{}),
      ...(Object.hasOwn(values,'repetitions')?{repetitions:Number(values.repetitions)}:{}),
    };
    const result=command==='demo'?await runDemo(options):values['paired-only']?await runPairedBenchmark(options):await runBenchmark(options);
    process.stdout.write(`${result.markdownPath}\n${result.reportPath}\n`);
    if(command==='demo') {
      const expected=result.report.expected;
      if(result.report.cancelled||result.report.runs.length!==expected.length||result.report.runs.some((run,i)=>run.report.status!=='completed'||run.report.totals.executed!==expected[i].executed||run.report.totals.reused!==expected[i].reused||run.score.missingIds.length>0))process.exitCode=2;
    } else if(result.report.cancelled||result.report.trials.some(trial=>trial.stages.some(stage=>stage.status&&stage.status!=='completed')))process.exitCode=2;
    return;
  }
  if(!['report','run','resume','plan'].includes(command))throw new Error(`Unknown command ${command}`);
  const repoRoot=path.resolve(required('repo')),stateDir=path.resolve(values.state||defaultState);
  if(command==='resume')required('run-id');
  // Reject an invalid output boundary before creating state or dispatching work.
  await outputTarget();
  if(command==='report') {
    const store=new CacheStore(stateDir,repoRoot);
    const result=values['run-id']?await store.readReport(values['run-id']):await store.latestReport();
    if(!result)throw Object.assign(new Error('Saved report does not exist'),{code:'REPORT_NOT_FOUND'});
    await writeResult(result,renderReport(result));return;
  }
  const manifest=await readManifest(path.resolve(required('manifest')));
  const dshConfig=values['dsh-config']?await configFile():null;
  if(values['credential-file']&&!dshConfig)throw new Error('--credential-file requires --dsh-config');
  const executor=dshConfig?await createDshExecutor(dshConfig,credentialDependencies(dshConfig)):createFixtureExecutor();
  try {
    const options={repoRoot,stateDir,manifest,executor,full:values.full===true,signal:controller.signal,
      securityPolicy:{network:values['dsh-config']?'explicit-human-config':'denied'},
      ...(command==='resume'?{resumeFrom:required('run-id')}:{})};
    const result=command==='plan'?await planReview(options):await runReview(options);
    await writeResult(result,renderReport(result));
    if(result.status&&result.status!=='completed')process.exitCode=2;
    if(command==='plan'&&result.tasks.some(task=>task.status==='blocked'))process.exitCode=2;
  } finally {await executor.dispose?.();}
}
try {await main();}
catch(error) {
  // Provider adapters sanitize credential-bearing errors; do not dump objects or stacks.
  process.stderr.write(`${error.code||'ERROR'}: ${error.message}\n`);process.exitCode=1;
}
