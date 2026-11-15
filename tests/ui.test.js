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
 assert.match(html,/id="theme-toggle"[^>]*aria-label="Включить тёмную тему"[^>]*aria-pressed="false"/);
 assert.match(html,/class="header-actions"[\s\S]*id="theme-toggle"/);
 assert.match(html,/<button type="button" data-tab="settings">Аккаунт<\/button>/);
 assert.doesNotMatch(html, /id="header-account"/);
 assert.equal((html.match(/id="username-display"/g)||[]).length,1);
 assert.match(html,/class="account-profile"[\s\S]*id="username-display"[\s\S]*id="logout-button"/);
 const insights=html.slice(html.indexOf('id="view-insights"'),html.indexOf('id="view-settings"'));
 const account=html.slice(html.indexOf('id="view-settings"'));
 assert.match(insights,/insight-disclaimer[\s\S]*insights-export[\s\S]*data-export="csv"[\s\S]*data-export="json"[\s\S]*id="print-summary"/);
 assert.doesNotMatch(account,/data-export=|id="print-summary"/);
 assert.match(html,/<option value="light">Светлая<\/option>/);
 assert.match(js,/localStorage\.getItem\('mood-theme'\) \|\| 'light'/);
 assert.match(js,/theme-toggle'\)\.addEventListener\('click'/);
 assert.match(html,/<footer[^>]*class="footer"[^>]*>[\s\S]*Сервис разработан и поддерживается компанией Biodata[\s\S]*<\/footer>/);
 assert.match(html,/<span class="footer-note">Не заменяет медицинскую помощь<\/span>/);
 assert.match(html,/<a class="footer-credit" href="https:\/\/biodata\.health"/);
 assert.match(html,/<a class="footer-credit" href="https:\/\/biodata\.health" target="_blank" rel="noopener noreferrer">Сервис разработан и поддерживается компанией Biodata<\/a>/);
 const css=readFileSync(new URL("../public/styles.css",import.meta.url),"utf8");
 assert.match(css,/@media\(max-width:760px\)[^\n]*safe-area-inset-top/);
 assert.match(css,/\.header-actions\{width:auto;margin-left:auto;justify-content:flex-end/);
 assert.match(css,/\.footer \.footer-note,\.footer \.footer-credit\{display:block/);
});
