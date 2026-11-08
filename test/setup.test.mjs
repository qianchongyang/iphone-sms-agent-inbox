import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('setup creates separate credentials, private files and refuses silent key replacement',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sms-inbox-setup-'));
 try{
  await mkdir(path.join(dir,'scripts'));
  const script=path.join(dir,'scripts/setup.mjs');
  await copyFile(new URL('../scripts/setup.mjs',import.meta.url),script);
  const result=spawnSync(process.execPath,[script,'--domain','otp.unit.test'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(await readFile(path.join(dir,'.private/config.json'),'utf8'));
  assert.equal(config.read_token.length,43);assert.notEqual(config.read_token,config.upload_token);
  assert.ok(!result.stdout.includes(config.read_token));assert.ok(!result.stdout.includes(config.upload_token));
  const worker=JSON.parse(await readFile(path.join(dir,'.private/wrangler.json'),'utf8'));
  assert.equal(worker.routes[0].pattern,'otp.unit.test');assert.equal(worker.main,'../src/worker.mjs');
  if(process.platform!=='win32')assert.equal((await stat(path.join(dir,'.private/config.json'))).mode&0o777,0o600);
  const again=spawnSync(process.execPath,[script,'--domain','another.unit.test'],{encoding:'utf8'});
  assert.notEqual(again.status,0);
  assert.equal(JSON.parse(await readFile(path.join(dir,'.private/config.json'),'utf8')).read_token,config.read_token);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('shortcut generator binds custom HTTPS origin and actual variable tokens',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sms-inbox-shortcut-'));
 try{
  const generated=spawnSync('python3',[fileURLToPath(new URL('../shortcuts/build_shortcut.py',import.meta.url))],{input:JSON.stringify({origin:'https://otp.unit.test',upload_token:'x'.repeat(43),output_dir:dir}),encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  assert.ok(!generated.stdout.includes('x'.repeat(43)));
  const inspected=spawnSync('python3',['-c',`import plistlib,sys
w=plistlib.load(open(sys.argv[1],'rb'))
a=w['WFWorkflowActions']
assert a[1]['WFWorkflowActionParameters']['WFTextActionText']['Value']['attachmentsByRange']['{0, 1}']['Type']=='ExtensionInput'
p=a[2]['WFWorkflowActionParameters']
assert p['WFURL']=='https://otp.unit.test/api/sms'
assert p['WFHTTPMethod']=='POST'
fields=p['WFJSONValues']['Value']['WFDictionaryFieldValueItems']
assert fields[0]['WFKey']['Value']['string']=='message'
assert fields[0]['WFValue']['Value']['attachmentsByRange']['{0, 1}']['Type']=='ActionOutput'
`,path.join(dir,'验证码上传.unsigned.shortcut')],{encoding:'utf8'});
  assert.equal(inspected.status,0,inspected.stderr);
 }finally{await rm(dir,{recursive:true,force:true});}
});
