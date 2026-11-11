import { readFile } from 'node:fs/promises';
import { freeze } from './value.js';

function fail(message) { throw Object.assign(new Error(message), {code:'MANIFEST_INVALID'}); }
function object(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) fail(`${name}: unsupported fields ${extras.join(', ')}`);
}
function strings(value,name,{empty=true}={}) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.some(x=>typeof x !== 'string' || !x.trim())) fail(`${name} must be ${empty?'an':'a nonempty'} array of nonempty strings`);
  if (new Set(value).size !== value.length) fail(`${name} contains duplicates`);
  return [...value];
}
export function validateManifest(raw) {
  object(raw,'manifest',['schemaVersion','tasks']);
  if (raw.schemaVersion !== 1) fail('Unsupported manifest schemaVersion');
  if (!Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > 256) fail('manifest.tasks requires 1..256 tasks');
  const tasks = raw.tasks.map((task,index)=>{
    const name=`tasks[${index}]`;
    object(task,name,['id','description','inputs','dependsOn','acceptance']);
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(task.id)) fail(`${name}.id is invalid`);
    if (typeof task.description !== 'string' || !task.description.trim() || task.description.length>16000) fail(`${name}.description requires bounded nonempty text`);
    object(task.inputs,`${name}.inputs`,['files','directories']);
    return {
      id:task.id, description:task.description,
      inputs:{files:strings(task.inputs.files,`${name}.inputs.files`),directories:strings(task.inputs.directories,`${name}.inputs.directories`)},
      dependsOn:strings(task.dependsOn,`${name}.dependsOn`),
      acceptance:strings(task.acceptance,`${name}.acceptance`,{empty:false}),
    };
  });
  const byId = new Map(tasks.map(task=>[task.id,task]));
  if (byId.size !== tasks.length) fail('Duplicate task IDs');
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!byId.has(dep)) fail(`Task ${task.id} has missing upstream ${dep}`);
    if (dep === task.id) fail(`Task ${task.id} depends on itself`);
  }
  topologicalOrder(tasks);
  return freeze({schemaVersion:1,tasks});
}
export function topologicalOrder(tasks) {
  const ordered=[], done=new Set();
  while (ordered.length<tasks.length) {
    const ready=tasks.filter(task=>!done.has(task.id) && task.dependsOn.every(id=>done.has(id)));
    if (!ready.length) fail('Task dependency cycle');
    for (const task of ready) {ordered.push(task);done.add(task.id);}
  }
  return ordered;
}
export async function readManifest(path) {
  const data=await readFile(path);
  if (data.length>1024*1024) fail('Manifest exceeds 1 MiB');
  let raw;
  try { raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)); }
  catch(error) {fail(`Invalid UTF-8 JSON manifest: ${error.message}`);}
  return validateManifest(raw);
}
