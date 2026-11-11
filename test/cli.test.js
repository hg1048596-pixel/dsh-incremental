import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CacheStore } from '../src/cache.js';

const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/dsh-incremental.js',import.meta.url));
async function command(args) {
  try {return {code:0,...await exec(process.execPath,[cli,...args],{timeout:30000,windowsHide:true})};}
  catch(error) {return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}
async function workspace(t) {
  const base=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'incremental-cli-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const repo=path.join(base,'repo'),state=path.join(base,'state');await fs.mkdir(repo);
  return {base,repo,state};
}
test('CLI help requires model configuration and makes synthetic diagnostics explicit',async()=>{
  const result=await command(['--help']);assert.equal(result.code,0);
  assert.match(result.stdout,/Review commands require --dsh-config/);
  assert.match(result.stdout,/--fixture explicitly selects a deterministic synthetic diagnostic, NOT an AI reviewer/);
});
test('CLI plan creates neither state nor model requests, and missing report is explicit',async t=>{
  const {base,repo,state}=await workspace(t);await fs.writeFile(path.join(repo,'file.js'),'const value = 1;');
  const manifest=path.join(base,'tasks.json');await fs.writeFile(manifest,JSON.stringify({schemaVersion:1,tasks:[{
    id:'module',description:'Review supplied text',inputs:{files:['file.js'],directories:[]},dependsOn:[],acceptance:['Return structured findings'],
  }]}));
  const result=await command(['plan','--fixture','--repo',repo,'--state',state,'--manifest',manifest,'--json']);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).kind,'plan');
  await assert.rejects(fs.stat(state),{code:'ENOENT'});
  const missing=await command(['report','--repo',repo,'--state',state]);assert.notEqual(missing.code,0);assert.match(missing.stderr,/REPORT_NOT_FOUND/);
});
test('CLI report cannot write through an outside junction into reviewed source',async t=>{
  const {base,repo,state}=await workspace(t),alias=path.join(base,'alias');
  await fs.symlink(repo,alias,process.platform==='win32'?'junction':'dir');
  const store=new CacheStore(state,repo);await store.acquire();
  await store.writeReport({schemaVersion:1,runId:'test',status:'completed',mode:'incremental',tasks:[],totals:null});await store.release();
  const result=await command(['report','--repo',repo,'--state',state,'--run-id','test','--output',path.join(alias,'report.md')]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/outside the reviewed repository/);
  await assert.rejects(fs.stat(path.join(repo,'report.md')),{code:'ENOENT'});
});

test('CLI report replaces an outside hard link without modifying reviewed source',async t=>{
  const {base,repo,state}=await workspace(t);
  const source=path.join(repo,'file.js'),output=path.join(base,'report.md');
  await fs.writeFile(source,'const retained = true;');await fs.link(source,output);
  const store=new CacheStore(state,repo);await store.acquire();
  await store.writeReport({schemaVersion:1,runId:'test',status:'completed',mode:'incremental',tasks:[],totals:null});await store.release();
  const result=await command(['report','--repo',repo,'--state',state,'--run-id','test','--output',output]);
  assert.equal(result.code,0,result.stderr);
  assert.equal(await fs.readFile(source,'utf8'),'const retained = true;');
  assert.match(await fs.readFile(output,'utf8'),/# dsh-incremental run test/);
});

test('CLI rejects source output before loading a manifest or creating review state',async t=>{
  const {base,repo,state}=await workspace(t),output=path.join(repo,'report.md');
  const result=await command(['run','--fixture','--repo',repo,'--state',state,'--manifest',path.join(base,'missing.json'),'--output',output]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/outside the reviewed repository/);
  await assert.rejects(fs.stat(state),{code:'ENOENT'});
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
});

test('CLI review commands require model configuration before reading inputs or creating state',async t=>{
  const {base,repo,state}=await workspace(t),output=path.join(base,'report.json');
  for(const operation of ['plan','run','resume']) {
    const result=await command([operation,'--repo',repo,'--state',state,'--manifest',path.join(base,'missing.json'),
      '--output',output,...(operation==='resume'?['--run-id','missing-run']:[])]);
    assert.equal(result.code,1,result.stderr);
    assert.match(result.stderr,/^MODEL_CONFIGURATION_REQUIRED:/);
    assert.match(result.stderr,/requires --dsh-config PATH/);
    assert.equal(result.stdout,'');
    await assert.rejects(fs.stat(state),{code:'ENOENT'});
    await assert.rejects(fs.stat(output),{code:'ENOENT'});
  }
});

test('CLI synthetic diagnostics cannot also select a DSH configuration',async t=>{
  const {base,repo,state}=await workspace(t);
  for(const operation of ['plan','run','resume']) {
    const result=await command([operation,'--fixture','--dsh-config',path.join(base,'missing-config.json'),
      '--repo',repo,'--state',state,'--manifest',path.join(base,'missing.json'),
      ...(operation==='resume'?['--run-id','missing-run']:[])]);
    assert.equal(result.code,1,result.stderr);
    assert.match(result.stderr,/^EXECUTOR_CONFIGURATION_CONFLICT: --fixture and --dsh-config are mutually exclusive/);
    await assert.rejects(fs.stat(state),{code:'ENOENT'});
  }
});

test('CLI rejects misrouted flags and sanitizes parser errors',async t=>{
  const {base,repo,state}=await workspace(t);
  const misrouted=await command(['report','--repo',repo,'--state',state,'--dsh-config',path.join(base,'missing.json')]);
  assert.notEqual(misrouted.code,0);assert.match(misrouted.stderr,/--dsh-config is not supported by report/);
  for(const operation of ['doctor','report','demo','benchmark']) {
    const fixture=await command([operation,'--fixture']);
    assert.equal(fixture.code,1,fixture.stderr);assert.match(fixture.stderr,new RegExp(`--fixture is not supported by ${operation}`));
  }
  const paired=await command(['benchmark','--paired-only','--repetitions','3','--output',path.join(base,'out')]);
  assert.notEqual(paired.code,0);assert.match(paired.stderr,/does not accept --repetitions/);
  const unknown=await command(['--not-an-option']);
  assert.notEqual(unknown.code,0);assert.match(unknown.stderr,/ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  assert.doesNotMatch(unknown.stderr,/\n\s+at /);
  await assert.rejects(fs.stat(state),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(base,'out')),{code:'ENOENT'});
});
