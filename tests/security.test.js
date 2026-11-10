import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';

test('recovery, export, encryption and account deletion',{timeout:25000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mood-sec-'));
 const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const origin='http://127.0.0.1:'+port, dbPath=join(dir,'data.sqlite');
 const server=spawn(process.execPath,['src/server.js'],{cwd:new URL('..',import.meta.url).pathname,stdio:'ignore',
  env:{...process.env,NODE_ENV:'test',APP_ORIGIN:origin,HOST:'127.0.0.1',PORT:String(port),
   DB_PATH:dbPath,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex')}});
 const call=async(path,method='GET',payload,cookie,withOrigin=true)=>{
  const headers={};
  if(method!=='GET'){headers['Content-Type']='application/json';headers['X-Mood-Client']='1';if(withOrigin)headers.Origin=origin;}
  if(cookie)headers.Cookie=cookie;
  const r=await fetch(origin+path,{method,headers,body:method==='GET'?undefined:JSON.stringify(payload||{})});
  const type=r.headers.get('content-type')||'';
  return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],
   data:type.includes('json')?await r.json():await r.text()};
 };
 try{
  let ready=false;
  for(let i=0;i<65;i++){try{ready=(await call('/api/health')).status===200;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,75));}
  assert.ok(ready);
  const account={username:'secureuser',password:'very-long-password-123',consent:true,adult:true};
  assert.equal((await call('/api/register','POST',account,null,false)).status,403);
  const first=await call('/api/register','POST',account);
  assert.equal(first.status,201);
  const record={occurredAt:new Date().toISOString(),mood:3,anxiety:2,lowMood:0,
   elevated:0,irritability:0,energy:2,sleepHours:7.5,medication:'na',
   medicationNote:'',tags:['Работа'],note:'PRIVATE_ENCRYPTION_TEST'};
  const saved=await call('/api/entries','POST',record,first.cookie);
  assert.equal(saved.status,201);
  const id=saved.data.entry.id;
  const db=new DatabaseSync(dbPath);
  const cipher=db.prepare('SELECT ciphertext FROM entries WHERE id=?').get(id).ciphertext;
  assert.ok(!cipher.includes(record.note));
  db.close();
  assert.equal((await call('/api/entries','POST',{...record,mood:8},first.cookie)).status,400);
  const changed=await call('/api/entries/'+id,'PUT',{...record,mood:4},first.cookie);
  assert.equal(changed.data.entry.mood,4);
  const json=await call('/api/export?format=json','GET',null,first.cookie);
  assert.equal(json.data.entries.length,1);
  assert.equal(json.data.entries[0].note,record.note);
  const recovered=await call('/api/recover','POST',{username:account.username,
   recoveryCode:first.data.recoveryCode,password:'new-long-password-123'});
  assert.equal(recovered.status,200);
  assert.notEqual(recovered.data.recoveryCode,first.data.recoveryCode);
  assert.equal((await call('/api/entries','GET',null,first.cookie)).status,401);
  assert.equal((await call('/api/account','DELETE',{password:'new-long-password-123'},recovered.cookie)).status,200);
  assert.equal((await call('/api/entries','GET',null,recovered.cookie)).status,401);
 }finally{
  server.kill('SIGTERM');
  await new Promise(r=>{if(server.exitCode!==null)r();else server.once('exit',r);});
  rmSync(dir,{recursive:true,force:true});
 }
});
