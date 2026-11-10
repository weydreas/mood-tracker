'use strict';

const $ = id => document.getElementById(id);
const moodNames = ['','Очень тяжело','Снижено','Ровно','Хорошо','Очень хорошо'];
const defaults = ['Работа','Семья','Сон','Спорт','Прогулка','Общение','Стресс','Конфликт','Здоровье','Терапия','Алкоголь','Путешествие'];
const scales = ['anxiety','lowMood','elevated','irritability','energy'];
let user = null;
let entries = [];
let editingId = null;
let mood = 3;
let selectedTags = new Set();
let historyPages = 1;
let insightDays = 30;
let lastToast = 0;

function el(tag, className, textValue) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (textValue !== undefined) item.textContent = String(textValue);
  return item;
}
function toast(message) {
  const item = $('toast');
  item.textContent = message;
  item.hidden = false;
  const sequence = ++lastToast;
  setTimeout(() => { if (sequence === lastToast) item.hidden = true; }, 4300);
}
async function api(url, method = 'GET', payload) {
  const options = { method, credentials: 'same-origin' };
  if (method !== 'GET') {
    options.headers = { 'Content-Type':'application/json','X-Mood-Client':'1' };
    options.body = JSON.stringify(payload || {});
  }
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('Нет соединения с сервером. Проверьте интернет.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Не удалось прочитать ответ сервера.'); }
  if (!response.ok) {
    if (response.status === 401 && !['/api/login','/api/recover'].includes(url)) showAuth();
    throw new Error(data.error || 'Не удалось выполнить действие.');
  }
  return data;
}
function localDateInput(iso) {
  const date = iso ? new Date(iso) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0,16);
}
function dayKey(date) {
  const d = new Date(date);
  return [d.getFullYear(),String(d.getMonth() + 1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU',{ day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit' });
}
function avg(items) { return items.length ? items.reduce((s,v) => s + v,0) / items.length : null; }
function fmt(value) { return value === null ? '—' : value.toFixed(1).replace('.',','); }
function showAuth() {
  user = null;
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
  $('header-account').hidden = true;
}
async function enterApp(account) {
  user = account;
  $('username-display').textContent = account.username;
  $('header-account').hidden = false;
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('today-label').textContent = new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
  resetForm();
  await reload();
  openTab('today');
}
function switchAuth(name) {
  ['login','register','recover'].forEach(kind => {
    $(kind + '-form').hidden = kind !== name;
  });
  document.querySelectorAll('[data-auth]').forEach(button => {
    button.classList.toggle('active',button.dataset.auth === name);
  });
  if (name === 'recover') document.querySelector('.auth-switch').hidden = true;
  else document.querySelector('.auth-switch').hidden = false;
}
function recoveryDialog(code) {
  $('recovery-code-display').value = code;
  $('recovery-dialog').showModal();
}
function openTab(name) {
  ['today','history','insights','settings'].forEach(kind => {
    $('view-' + kind).hidden = kind !== name;
  });
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  if (name === 'history') renderHistory();
  if (name === 'insights') renderInsights();
  if (name === 'today') renderSummary();
  window.scrollTo({top:0,behavior:'smooth'});
}
function setMood(value) {
  mood = Number(value);
  document.querySelectorAll('[data-mood]').forEach(button => {
    const active = Number(button.dataset.mood) === mood;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',String(active));
  });
}
function renderTagButtons() {
  const known = [...new Set([...defaults,...entries.flatMap(e => e.tags),...selectedTags])].slice(0,70);
  const wrapper = $('tag-options');
  wrapper.replaceChildren();
  for (const tag of known) {
    const button = el('button','tag-button' + (selectedTags.has(tag) ? ' selected' : ''),tag);
    button.type = 'button';
    button.setAttribute('aria-pressed',String(selectedTags.has(tag)));
    button.addEventListener('click', () => {
      if (selectedTags.has(tag)) selectedTags.delete(tag);
      else if (selectedTags.size < 12) selectedTags.add(tag);
      else return toast('Можно выбрать не более 12 факторов.');
      renderTagButtons();
    });
    wrapper.append(button);
  }
}
function resetForm() {
  editingId = null;
  $('entry-form').reset();
  $('entry-time').value = localDateInput();
  $('entry-title').textContent = 'Как вы себя чувствуете?';
  $('save-entry').textContent = 'Сохранить запись';
  $('cancel-edit').hidden = true;
  setMood(3);
  selectedTags = new Set();
  for (const scale of scales) {
    $('score-' + scale).value = scale === 'energy' ? 2 : 0;
    $('out-' + scale).textContent = $('score-' + scale).value;
  }
  renderTagButtons();
}
function populateEdit(entry) {
  editingId = entry.id;
  $('entry-title').textContent = 'Редактирование записи';
  $('save-entry').textContent = 'Сохранить изменения';
  $('cancel-edit').hidden = false;
  $('entry-time').value = localDateInput(entry.occurredAt);
  $('sleep-hours').value = entry.sleepHours ?? '';
  $('medication').value = entry.medication;
  $('medication-note').value = entry.medicationNote;
  $('note').value = entry.note;
  setMood(entry.mood);
  selectedTags = new Set(entry.tags);
  scales.forEach(k => {
    $('score-' + k).value = entry[k];
    $('out-' + k).textContent = entry[k];
  });
  renderTagButtons();
  openTab('today');
}
function formEntry() {
  const rawDate = $('entry-time').value;
  if (!rawDate || !Number.isFinite(new Date(rawDate).getTime())) throw new Error('Выберите дату и время.');
  return {
    occurredAt: new Date(rawDate).toISOString(), mood,
    anxiety: Number($('score-anxiety').value),
    lowMood: Number($('score-lowMood').value),
    elevated: Number($('score-elevated').value),
    irritability: Number($('score-irritability').value),
    energy: Number($('score-energy').value),
    sleepHours: $('sleep-hours').value === '' ? null : Number($('sleep-hours').value),
    medication: $('medication').value, medicationNote: $('medication-note').value,
    note: $('note').value, tags: [...selectedTags]
  };
}
async function reload() {
  const result = await api('/api/entries');
  entries = result.entries.sort((a,b) => b.occurredAt.localeCompare(a.occurredAt));
  renderTagButtons();
  renderSummary();
  renderHistory();
  renderInsights();
}
function recent(days) {
  const min = new Date();
  min.setHours(0,0,0,0);
  min.setDate(min.getDate() - days + 1);
  return entries.filter(e => new Date(e.occurredAt) >= min);
}
function stat(name, value) {
  const card = el('div','stat');
  card.append(el('div','stat-value',value),el('div','stat-label',name));
  return card;
}
function renderSummary() {
  const week = recent(7);
  $('summary-stats').replaceChildren(
    stat('Записей',week.length),
    stat('Среднее настроение',fmt(avg(week.map(e => e.mood)))));
  drawChart($('mini-chart'),week,7);
}
function drawChart(container, data, days) {
  container.replaceChildren();
  if (!data.length) {
    container.append(el('div','chart-empty','Пока нет записей за этот период.'));
    return;
  }
  const grouped = new Map();
  for (const entry of data) {
    const key = dayKey(entry.occurredAt);
    if (!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(entry.mood);
  }
  const start = new Date(); start.setHours(12,0,0,0);
  start.setDate(start.getDate() - days + 1);
  const items = Array.from({length:days},(_,i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = dayKey(d);
    return {date:d, value:avg(grouped.get(key) || [])};
  });
  const wrap = el('div','chart-wrap');
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  const w = 620,h = 220,left = 29,right = 15,top = 16,bottom = 35;
  svg.setAttribute('viewBox','0 0 ' + w + ' ' + h);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Изменения средней оценки настроения по дням за ' + days + ' дней');
  const ns = 'http://www.w3.org/2000/svg';
  function node(tag,attrs,textValue) {
    const n = document.createElementNS(ns,tag);
    for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v);
    if (textValue !== undefined) n.textContent = textValue;
    svg.append(n);
    return n;
  }
  function x(i) { return left + i * (w-left-right) / Math.max(1,days-1); }
  function y(v) { return top + (5-v) * (h-top-bottom)/4; }
  for (const level of [1,2,3,4,5]) {
    node('line',{x1:left,y1:y(level),x2:w-right,y2:y(level),stroke:'currentColor','stroke-opacity':'.12','stroke-width':'1'});
    node('text',{x:3,y:y(level)+4,fill:'currentColor','fill-opacity':'.55','font-size':'13'},level);
  }
  let path = '';
  items.forEach((item,i) => {
    if (item.value === null) return;
    const prev = i && items[i-1].value !== null;
    path += (prev ? ' L ' : ' M ') + x(i).toFixed(1) + ' ' + y(item.value).toFixed(1);
  });
  node('path',{d:path,fill:'none',stroke:'#4b9b86','stroke-width':'3','stroke-linecap':'round','stroke-linejoin':'round'});
  items.forEach((item,i) => {
    if (item.value === null) return;
    const dot = node('circle',{cx:x(i),cy:y(item.value),r:days <= 7 ? 5 : 3.2,fill:'#29836c'});
    const title = document.createElementNS(ns,'title');
    title.textContent = item.date.toLocaleDateString('ru-RU') + ': ' + fmt(item.value);
    dot.append(title);
  });
  for (const i of [0,Math.floor((days-1)/2),days-1]) {
    node('text',{x:x(i),y:h-7,'text-anchor':i===0?'start':i===days-1?'end':'middle',fill:'currentColor','fill-opacity':'.6','font-size':'12'},items[i].date.toLocaleDateString('ru-RU',{day:'numeric',month:'short'}));
  }
  wrap.append(svg);
  container.append(wrap);
}
function renderCalendar() {
  const container = $('mood-calendar');
  container.replaceChildren();
  const grouped = new Map();
  for (const e of entries) {
    const key = dayKey(e.occurredAt);
    if (!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(e.mood);
  }
  for (let i = 27; i >= 0; i--) {
    const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate()-i);
    const values = grouped.get(dayKey(d)) || [];
    const value = avg(values);
    const cell = el('div','calendar-cell' + (value === null ? '' : ' level-' + Math.round(value)),d.getDate());
    cell.title = d.toLocaleDateString('ru-RU') + ': ' + (value === null ? 'нет записей' : fmt(value) + ' (' + values.length + ')');
    container.append(cell);
  }
}
function renderHistory() {
  renderCalendar();
  const month = $('month-filter').value;
  const filtered = month ? entries.filter(e => dayKey(e.occurredAt).startsWith(month)) : entries;
  const showing = filtered.slice(0,historyPages * 20);
  const box = $('history-list');
  box.replaceChildren();
  if (!showing.length) box.append(el('div','empty','Здесь пока нет записей. Они появятся после первого сохранения.'));
  for (const e of showing) {
    const item = el('article','history-item');
    const top = el('div','history-top');
    top.append(el('span','history-date',formatDate(e.occurredAt)),el('span','history-mood',moodNames[e.mood]));
    item.append(top);
    const fragments = [];
    for (const [key,label] of [['anxiety','тревога'],['lowMood','подавленность'],['elevated','возбуждение'],['irritability','раздражительность'],['energy','энергия']]) {
      fragments.push(label + ' ' + e[key] + '/4');
    }
    if (e.sleepHours !== null) fragments.push('сон ' + e.sleepHours + ' ч');
    if (e.medication === 'taken') fragments.push('лекарства по плану');
    if (e.medication === 'missed') fragments.push('пропуск / изменение лекарств');
    if (e.tags.length) fragments.push('факторы: ' + e.tags.join(', '));
    item.append(el('div','history-detail',fragments.join(' · ')));
    if (e.medicationNote) item.append(el('div','history-note',e.medicationNote));
    if (e.note) item.append(el('p','history-note',e.note));
    const actions = el('div','history-actions');
    const edit = el('button','','Редактировать');
    edit.type = 'button';
    edit.addEventListener('click',() => populateEdit(e));
    const remove = el('button','delete-link','Удалить');
    remove.type = 'button';
    remove.addEventListener('click',async () => {
      if (!confirm('Удалить эту запись без возможности восстановления?')) return;
      try {
        await api('/api/entries/' + e.id,'DELETE');
        if (editingId === e.id) resetForm();
        await reload(); toast('Запись удалена.');
      } catch (error) { toast(error.message); }
    });
    actions.append(edit,remove);
    item.append(actions);
    box.append(item);
  }
  $('load-more').hidden = showing.length >= filtered.length;
}
function renderInsights() {
  const subset = recent(insightDays);
  const first = new Set(subset.map(e => dayKey(e.occurredAt)));
  const mean = avg(subset.map(e => e.mood));
  $('insight-numbers').replaceChildren(
    stat('Записей',subset.length),
    stat('Дней с записями',first.size),
    stat('Средняя оценка',fmt(mean)));
  drawChart($('insight-chart'),subset,insightDays);
  const factors = $('factor-insights');
  factors.replaceChildren();
  const tags = [...new Set(subset.flatMap(e => e.tags))];
  let comparisons = [];
  for (const tag of tags) {
    const withTag = subset.filter(e => e.tags.includes(tag));
    const without = subset.filter(e => !e.tags.includes(tag));
    if (withTag.length >= 3 && without.length >= 3) {
      comparisons.push({tag,n:withTag.length,difference:avg(withTag.map(e=>e.mood))-avg(without.map(e=>e.mood))});
    }
  }
  comparisons.sort((a,b) => Math.abs(b.difference)-Math.abs(a.difference));
  if (!comparisons.length) factors.append(el('p','','Понадобится больше записей: не менее 3 с фактором и 3 без него.'));
  comparisons.slice(0,6).forEach(c => {
    const row = el('div','insight-row');
    row.append(el('span','',c.tag + ' · ' + c.n + ' записей'),el('strong','',(c.difference > 0 ? '+' : '') + fmt(c.difference)));
    factors.append(row);
  });
  const sleep = $('sleep-insights');
  sleep.replaceChildren();
  const measured = subset.filter(e => e.sleepHours !== null);
  const long = measured.filter(e => e.sleepHours >= 7);
  const short = measured.filter(e => e.sleepHours < 7);
  if (long.length < 3 || short.length < 3) {
    sleep.append(el('p','','Для сравнения нужно минимум по 3 записи с коротким и более продолжительным сном.'));
  } else {
    const row1 = el('div','insight-row'); row1.append(el('span','','Сон ≥ 7 ч · ' + long.length),el('strong','',fmt(avg(long.map(e => e.mood)))));
    const row2 = el('div','insight-row'); row2.append(el('span','','Сон < 7 ч · ' + short.length),el('strong','',fmt(avg(short.map(e => e.mood)))));
    sleep.append(row1,row2);
  }
  document.querySelectorAll('[data-days]').forEach(button => button.classList.toggle('active',Number(button.dataset.days)===insightDays));
}
async function download(format) {
  const response = await fetch('/api/export?format=' + format,{credentials:'same-origin'});
  if (!response.ok) throw new Error('Не удалось выгрузить данные.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = 'mood-diary.' + format;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
function applyTheme(choice) {
  const dark = choice === 'dark' || (choice === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.dataset.theme = dark ? 'dark':'light';
  $('theme-select').value = choice;
  localStorage.setItem('mood-theme',choice);
}
function bindEvents() {
  document.querySelectorAll('[data-auth]').forEach(b => b.addEventListener('click',() => switchAuth(b.dataset.auth)));
  $('show-recover').addEventListener('click',() => switchAuth('recover'));
  $('back-login').addEventListener('click',() => switchAuth('login'));
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click',() => openTab(b.dataset.tab)));
  document.querySelectorAll('[data-mood]').forEach(b => b.addEventListener('click',() => setMood(b.dataset.mood)));
  document.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click',() => { insightDays=Number(b.dataset.days); renderInsights(); }));
  document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click',() => download(b.dataset.export).catch(error => toast(error.message))));
  $('month-filter').addEventListener('change',() => { historyPages=1; renderHistory(); });
  $('load-more').addEventListener('click',() => { historyPages++; renderHistory(); });
  scales.forEach(k => $('score-'+k).addEventListener('input',() => { $('out-'+k).textContent=$('score-'+k).value; }));
  $('add-tag').addEventListener('click',() => {
    const tag = $('custom-tag').value.trim().replace(/\s+/g,' ');
    if (!tag || tag.length > 32) return toast('Название фактора: до 32 символов.');
    if (selectedTags.size >= 12 && !selectedTags.has(tag)) return toast('Можно выбрать не более 12 факторов.');
    selectedTags.add(tag); $('custom-tag').value=''; renderTagButtons();
  });
  $('cancel-edit').addEventListener('click',resetForm);
  $('login-form').addEventListener('submit',async e => {
    e.preventDefault();
    try {
      const result = await api('/api/login','POST',{username:$('login-name').value,password:$('login-password').value});
      $('login-password').value=''; await enterApp(result.user);
    } catch(error) { toast(error.message); }
  });
  $('register-form').addEventListener('submit',async e => {
    e.preventDefault();
    try {
      const result = await api('/api/register','POST',{
        username:$('register-name').value,password:$('register-password').value,
        consent:$('register-consent').checked,adult:$('register-adult').checked
      });
      $('register-password').value='';
      recoveryDialog(result.recoveryCode);
      await enterApp(result.user);
    } catch(error) { toast(error.message); }
  });
  $('recover-form').addEventListener('submit',async e => {
    e.preventDefault();
    try {
      const result = await api('/api/recover','POST',{
        username:$('recover-name').value,recoveryCode:$('recover-code').value.trim(),
        password:$('recover-password').value
      });
      $('recover-password').value=''; $('recover-code').value='';
      recoveryDialog(result.recoveryCode);
      await enterApp(result.user);
    } catch(error) { toast(error.message); }
  });
  $('entry-form').addEventListener('submit',async e => {
    e.preventDefault();
    const button = $('save-entry'); button.disabled=true;
    try {
      const payload = formEntry();
      if (editingId) await api('/api/entries/'+editingId,'PUT',payload);
      else await api('/api/entries','POST',payload);
      resetForm(); await reload(); toast('Запись сохранена.');
    } catch(error) { toast(error.message); }
    finally { button.disabled=false; }
  });
  $('logout-button').addEventListener('click',async () => {
    try { await api('/api/logout','POST'); showAuth(); switchAuth('login'); }
    catch(error) { toast(error.message); }
  });
  $('delete-account-form').addEventListener('submit',async e => {
    e.preventDefault();
    if (!confirm('Удалить аккаунт и ВСЕ текущие записи? Это действие нельзя отменить.')) return;
    try {
      await api('/api/account','DELETE',{password:$('delete-password').value});
      $('delete-password').value=''; entries=[]; showAuth(); switchAuth('login'); toast('Аккаунт удалён.');
    } catch(error) { toast(error.message); }
  });
  $('copy-recovery').addEventListener('click',async () => {
    try { await navigator.clipboard.writeText($('recovery-code-display').value); toast('Код скопирован.'); }
    catch { $('recovery-code-display').select(); toast('Скопируйте выделенный код вручную.'); }
  });
  $('close-recovery').addEventListener('click',() => {
    $('recovery-code-display').value=''; $('recovery-dialog').close();
  });
  $('print-summary').addEventListener('click',() => { renderInsights(); window.print(); });
  $('theme-select').addEventListener('change',e => applyTheme(e.target.value));
}
async function init() {
  bindEvents();
  try { applyTheme(localStorage.getItem('mood-theme') || 'auto'); }
  catch { applyTheme('auto'); }
  switchAuth('login');
  try {
    const session = await api('/api/me');
    if (session.user) await enterApp(session.user);
    else showAuth();
  } catch(error) { showAuth(); toast(error.message); }
}
init();
