import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await readFile(path.join(root,'.private/config.json'),'utf8'));
const result=spawnSync('python3',[path.join(root,'shortcuts/build_shortcut.py')],{input:JSON.stringify({origin:config.origin,upload_token:config.upload_token,output_dir:path.join(root,'.private')}),encoding:'utf8'});
if(result.status!==0){console.error('Shortcut generation failed. Check Python 3 and configuration.');process.exit(1);}
if(process.platform==='darwin'){
 const signed=spawnSync('shortcuts',['sign','--mode','anyone','--input',path.join(root,'.private/验证码上传.unsigned.shortcut'),'--output',path.join(root,'.private/验证码上传.shortcut')],{stdio:'inherit'});
 if(signed.status!==0){console.error('Apple signing did not complete. Use the manual instructions in docs/IPHONE.md.');process.exit(1);}
 console.log('Signed private shortcut saved in .private/. Import it locally; never publish it.');
}else console.log('Unsigned shortcut saved in .private/. Sign it on a Mac, or build the actions manually using docs/IPHONE.md.');
