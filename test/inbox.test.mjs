import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{OtpInbox} from '../src/worker.mjs';
import {candidatesFor,normalizeMessage,selectMessages,renderInbox} from '../src/core.mjs';

function memoryStore(){const data=new Map();let alarm=null;return {data,getAlarm:async()=>alarm,setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;},list:async({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix))),put:async(k,v)=>data.set(k,structuredClone(v)),delete:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])data.delete(k);}};}
function runtime(){const storage=memoryStore();const ctx={storage,blockConcurrencyWhile:f=>f()};const box=new OtpInbox(ctx,{});const env={UPLOAD_TOKEN:'u'.repeat(43),READ_TOKEN:'r'.repeat(43),INBOX:{idFromName:x=>x,get:()=>({fetch:(req)=>box.fetch(typeof req==='string'?new Request(req):req)})}};return {env,storage,box};}
const upload=(env,body,token=env.UPLOAD_TOKEN)=>worker.fetch(new Request('https://example.com/api/sms',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);

test('broad candidates include short numbers and letters, but never fragments of long runs',()=>{
 const c=candidatesFor('验证码 A1B2C 英文 ABCD 1 12345678 123456789 abcdefghi');
 assert.deepEqual(c.candidates,['A1B2C','ABCD','1','12345678']);assert.deepEqual(c.preferred_candidates,['A1B2C']);
 assert.deepEqual(candidatesFor('G-123456 是您的 Google 验证码').preferred_candidates,['123456']);
});
test('normalization preserves raw text and expires after ten minutes or earlier source time',()=>{
 const now=Date.parse('2026-11-08T05:00:00Z');const m=normalizeMessage({text:'code: 2468',received_at:'2026-11-08T04:59:00Z'},now);
 assert.equal(m.retention_expires_at,'2026-11-08T05:09:00.000Z');assert.throws(()=>normalizeMessage({text:'a',received_at:'bad'},now));
 assert.throws(()=>normalizeMessage({text:'a',received_at:'2027-01-01'},now));
});
test('unauthorized upload/read rejected and public endpoints contain no SMS',async()=>{
 const {env}=runtime();assert.equal((await upload(env,{message:'code 123456'},'bad')).status,401);
 await upload(env,{message:'code 123456'});
 for(const path of ['/','/health','/api/messages','/r/'+'x'.repeat(43)+'/messages']){
  const r=await worker.fetch(new Request('https://example.com'+path),env);assert.ok(!(await r.text()).includes('123456'));
 }
 assert.equal((await worker.fetch(new Request('https://example.com/api/messages',{headers:{Authorization:'Bearer '+env.UPLOAD_TOKEN}}),env)).status,404);
 assert.equal((await upload(env,{message:'code 9999'},env.READ_TOKEN)).status,401);
});
test('upload, deduplication, filtering and expiry work across object recreation',async()=>{
 const {env,storage}=runtime();let r=await upload(env,{message:'【Demo】验证码 246810'});assert.equal((await r.json()).accepted,true);
 r=await upload(env,{message:'【Demo】验证码 246810'});assert.equal((await r.json()).duplicate,true);
 assert.equal(storage.data.size,1);
 const ctx={storage,blockConcurrencyWhile:f=>f()};const recreated=new OtpInbox(ctx,{});
 let data=await (await recreated.fetch(new Request('https://inbox.internal/list?q=Demo'))).json();assert.equal(data.messages.length,1);
 data=await (await recreated.fetch(new Request('https://inbox.internal/list?q=Other'))).json();assert.deepEqual(data.messages,[]);
 for(const m of storage.data.values())m.retention_expires_at=new Date(Date.now()-1).toISOString();
 data=await(await recreated.fetch(new Request('https://inbox.internal/list'))).json();assert.deepEqual(data.messages,[]);assert.equal(storage.data.size,0);
});
test('old source timestamps do not reappear and duplicate upload does not renew expiry',async()=>{
 const {env,storage}=runtime();const r=await upload(env,{message:'code ABCD',received_at:new Date(Date.now()-600001).toISOString()});assert.equal((await r.json()).reason,'expired');assert.equal(storage.data.size,0);
 await upload(env,{message:'code ABCD'});const expires=[...storage.data.values()][0].retention_expires_at;
 await upload(env,{message:'code ABCD'});assert.equal([...storage.data.values()][0].retention_expires_at,expires);
});
test('HTML escapes SMS and expires it on screen; JSON explains untrusted data',()=>{
 const m=normalizeMessage({message:'【Test】<script>alert(1)</script> code 1234'});
 const text=renderInbox({messages:[m],server_time:'now'},'/private/messages');
 assert.ok(text.includes('&lt;script&gt;'));assert.ok(!text.includes('<script>alert(1)'));
 assert.ok(text.includes('data-expires='));assert.equal(selectMessages([m],new URLSearchParams(),Date.parse(m.retention_expires_at)).length,0);
});
test('all-message mode accepts text without any candidate codes',async()=>{
 const {env,storage}=runtime();const r=await upload(env,{message:'您的快递已经送达，请及时领取。'});
 assert.equal((await r.json()).accepted,true);assert.equal(storage.data.size,1);
 assert.deepEqual([...storage.data.values()][0].candidates,[]);
});
test('invalid input, oversized bodies and invalid query filters fail closed',async()=>{
 const {env}=runtime();assert.equal((await upload(env,{})).status,400);
 assert.equal((await upload(env,{message:'a'.repeat(20000)})).status,413);
 assert.equal((await worker.fetch(new Request('https://example.com/r/'+env.READ_TOKEN+'/messages?after=bad'),env)).status,400);
});
