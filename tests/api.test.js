import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

test('registration and private entries', {timeout:20000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'mood-test-'));
  const port=await new Promise(resolve=>{
    const s=createServer(); s.listen(0,'127.0.0.1',()=>{
      const p=s.address().port;s.close(()=>resolve(p));
    });
  });
  const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['src/server.js'],{
    cwd:new URL('..',import.meta.url).pathname,stdio:'ignore',
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,
      DB_PATH:join(dir,'db.sqlite'),DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),NODE_ENV:'test'}
  });
  const req=async(path,method='GET',payload,cookie)=>{
    const h={};if(method!=='GET'){h['Content-Type']='application/json';h['X-Mood-Client']='1';h.Origin=origin;}
    if(cookie)h.Cookie=cookie;
    const r=await fetch(origin+path,{method,headers:h,body:method==='GET'?undefined:JSON.stringify(payload)});
    return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};
  };
  try{
    let ready=false;
    for(let i=0;i<60;i++){
      try {ready=(await req('/api/health')).status===200;if(ready)break;}catch{}
      await new Promise(r=>setTimeout(r,70));
    }
    assert.ok(ready);
    assert.equal((await req('/api/entries')).status,401);
    const register={password:'a-strong-test-password',consent:true,adult:true};
    const a=await req('/api/register','POST',{...register,username:'alice123'});
    assert.equal(a.status,201);
    const b=await req('/api/register','POST',{...register,username:'bob123'});
    assert.equal(b.status,201);
    const entry={occurredAt:new Date().toISOString(),mood:3,anxiety:1,lowMood:0,
      elevated:0,irritability:0,energy:2,sleepHours:null,medication:'na',tags:[],
      medicationNote:'',note:'hello'};
    assert.equal((await req('/api/entries','POST',entry,a.cookie)).status,201);
    assert.equal((await req('/api/entries','GET',undefined,a.cookie)).data.entries.length,1);
    assert.equal((await req('/api/entries','GET',undefined,b.cookie)).data.entries.length,0);
  }finally{
    child.kill('SIGTERM');
    await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});
    rmSync(dir,{recursive:true,force:true});
  }
});
