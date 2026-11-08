import { WINDOW_MS, MAX_BODY_BYTES, AGENT_INSTRUCTIONS, normalizeMessage, selectMessages, renderInbox } from './core.mjs';

const HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0', 'Pragma':'no-cache',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options':'nosniff',
  'X-Robots-Tag':'noindex, nofollow, noarchive',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Strict-Transport-Security':'max-age=31536000'
};
const json = (value, status=200) => new Response(JSON.stringify(value,null,2), {status,headers:{...HEADERS,'Content-Type':'application/json; charset=utf-8'}});
const html = value => new Response(value,{headers:{...HEADERS,'Content-Type':'text/html; charset=utf-8'}});

async function equalsSecret(actual, expected) {
  if (!expected || typeof actual !== 'string' || actual.length > 256) return false;
  const hash = s => crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  const [a,b] = await Promise.all([hash(actual),hash(expected)]);
  let diff=0; const aa=new Uint8Array(a),bb=new Uint8Array(b);
  for(let i=0;i<aa.length;i++)diff |= aa[i]^bb[i];
  return diff===0;
}

async function limitedJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('json_required');
  const reader=request.body?.getReader();
  if(!reader)throw new Error('message_required');
  const parts=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>MAX_BODY_BYTES){await reader.cancel();throw new Error('body_too_large');}parts.push(value);}
  const all=new Uint8Array(total);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(all));}catch{throw new Error('invalid_json');}
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET')return json({ok:true,service:'private-otp-inbox',retention_seconds:600});
    if(url.pathname==='/' && request.method==='GET')return json({service:'Private SMS inbox',description:'Private access is required. Ask the owner for the private read URL. Do not send SMS or credentials to this public endpoint.',retention_seconds:600});
    const bearer=request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')||'';
    try {
      if(url.pathname==='/api/sms') {
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        if(!await equalsSecret(bearer,env.UPLOAD_TOKEN))return json({error:'unauthorized'},401);
        const body=await limitedJson(request);
        const message=normalizeMessage(body);
        if(Date.parse(message.retention_expires_at)<=Date.now())return json({accepted:false,reason:'expired',retention_seconds:600});
        const id=env.INBOX.idFromName('owner-inbox-v1');
        return env.INBOX.get(id).fetch(new Request('https://inbox.internal/ingest',{method:'POST',body:JSON.stringify(message)}));
      }
      const match=url.pathname.match(/^\/r\/([A-Za-z0-9_-]{32,128})(\/messages)?\/?$/);
      const api=url.pathname==='/api/messages';
      if(match||api) {
        if(request.method!=='GET')return json({error:'method_not_allowed'},405);
        const credential=match?match[1]:bearer;
        if(!await equalsSecret(credential,env.READ_TOKEN))return json({error:'not_found'},404);
        const id=env.INBOX.idFromName('owner-inbox-v1');
        const response=await env.INBOX.get(id).fetch('https://inbox.internal/list'+url.search);
        if(!response.ok)return response;
        const data=await response.json();
        if(api||match[2])return json(data);
        return html(renderInbox(data,`/r/${match[1]}/messages`));
      }
      return json({error:'not_found'},404);
    } catch(error) {
      const known=['message_required','message_too_long','invalid_received_at','json_required','invalid_json','invalid_after','body_too_large'];
      if(known.includes(error.message))return json({error:error.message},error.message==='body_too_large'?413:400);
      return json({error:'temporarily_unavailable'},503);
    }
  }
};

export class OtpInbox {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}

  async cleanup(now) {
    const rows=await this.ctx.storage.list({prefix:'m:'});
    const expired=[...rows].filter(([,m])=>Date.parse(m.retention_expires_at)<=now).map(([key])=>key);
    for(let i=0;i<expired.length;i+=128)await this.ctx.storage.delete(expired.slice(i,i+128));
    return [...rows].filter(([,m])=>Date.parse(m.retention_expires_at)>now);
  }

  async schedule(rows) {
    if(rows.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,Math.min(...rows.map(([,m])=>Date.parse(m.retention_expires_at)))));
    else await this.ctx.storage.deleteAlarm();
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now(),url=new URL(request.url);
      const rows=await this.cleanup(now);
      if(url.pathname==='/ingest' && request.method==='POST') {
        const message=await request.json();
        const duplicate=rows.find(([,m])=>m.text===message.text&&m.sender===message.sender);
        if(duplicate)return json({accepted:true,duplicate:true,id:duplicate[1].id,retention_expires_at:duplicate[1].retention_expires_at});
        if(rows.filter(([,m])=>Date.parse(m.server_received_at)>now-60000).length>=60 || rows.length>=600)return json({error:'rate_limited'},429);
        message.id=crypto.randomUUID();
        const key=`m:${now}:${message.id}`;
        await this.ctx.storage.put(key,message);
        await this.schedule([...rows,[key,message]]);
        return json({accepted:true,id:message.id,retention_expires_at:message.retention_expires_at});
      }
      if(url.pathname==='/list') {
        let selected;try{selected=selectMessages(rows.map(([,m])=>m),url.searchParams,now);}catch{return json({error:'invalid_after'},400);}
        await this.schedule(rows);
        return json({description:AGENT_INSTRUCTIONS,server_time:new Date(now).toISOString(),retention_seconds:WINDOW_MS/1000,messages:selected});
      }
      return json({error:'not_found'},404);
    });
  }

  async alarm(){await this.ctx.blockConcurrencyWhile(async()=>{await this.schedule(await this.cleanup(Date.now()));});}
}
