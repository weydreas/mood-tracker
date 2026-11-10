import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('UI elements are present and asset loading is local',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));
 for(const match of js.matchAll(/\$\('([A-Za-z0-9-]+)'\)/g)){
  assert.ok(ids.has(match[1]),'Missing element: '+match[1]);
 }
 assert.match(html,/name="viewport"/);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/);
 assert.match(html,/id="register-consent"/);
 assert.match(html,/id="entry-form"/);
});
