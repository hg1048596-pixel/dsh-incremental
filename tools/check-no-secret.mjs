// Exact-value leak check; neither the secret nor its hash is printed or persisted.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const secret=(await readFile(process.argv[2],'utf8')).trim();
if(secret.length<16)throw new Error('Invalid secret source');
let examined=0;
const matches=[];
async function scan(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(['.git','node_modules'].includes(entry.name))continue;
    const target=path.join(directory,entry.name);
    if(entry.isDirectory())await scan(target);
    else if(entry.isFile()&&!entry.name.endsWith('.tgz')) {
      examined++;if((await readFile(target)).includes(Buffer.from(secret)))matches.push(path.relative(process.cwd(),target));
    }
  }
}
await scan(process.cwd());
console.log(JSON.stringify({filesExamined:examined,credentialOccurrences:matches.length,files:matches}));
if(matches.length)process.exitCode=1;
