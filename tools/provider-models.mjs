// Metadata-only diagnostic for the explicitly approved official DeepSeek route.
// Never logs credentials or response bodies on failure.
import { readFile } from 'node:fs/promises';
const credentialFile=process.argv[2];
if(!credentialFile)throw new Error('Pass an approved credential file path');
try {
  const secret=(await readFile(credentialFile,'utf8')).trim();
  if(!/^sk-[A-Za-z0-9_-]+$/.test(secret))throw new Error('Unsupported credential file format');
  const response=await fetch('https://api.deepseek.com/models',{
    headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(20000),redirect:'error',
  });
  if(!response.ok) {console.log(JSON.stringify({status:response.status,models:[],modelCalls:0}));process.exitCode=1;}
  else {const result=await response.json();console.log(JSON.stringify({status:response.status,models:(result.data||[]).map(model=>model.id),modelCalls:0}));}
} catch(error) {console.log(JSON.stringify({errorCode:error.code||error.cause?.code||error.name,models:[],modelCalls:0}));process.exitCode=1;}
