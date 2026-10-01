'use strict';
/* CRM GRAVV v2 — núcleo: API, formatação, componentes, formulários, gráficos e rotas. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => (v == null || v === '' ? '—' : BRL.format(Number(v)));
const num = v => Number(v || 0);
const round2 = v => Math.round(num(v) * 100) / 100;
const fdate = s => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—');
const fdt = s => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const pct = v => `${Math.round(num(v))}%`;
const S = { csrf: '', today: new Date().toISOString().slice(0, 10), owner: 'Marcos', email: '', owners: [] };
const REF = { stages: [], categories: [], accounts: [], services: [], clients: [], settings: {} };
const ACTIONS = {};
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ---------------------------------------------------------------- datas
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); };
const monthStart = iso => iso.slice(0, 8) + '01';
const monthEnd = iso => addDays(addMonths(monthStart(iso), 1), -1);
const monthLabel = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1]}/${iso.slice(2, 4)}`;
const inRange = (d, a, b) => d && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
const localDay = ts => (ts ? new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : '');

// ---------------------------------------------------------------- rótulos
const L = {
  per: { one_time: 'Avulso', monthly: 'Mensal', quarterly: 'Trimestral', semiannual: 'Semestral', yearly: 'Anual' },
  client: { ativo: 'Ativo', pausado: 'Pausado', inativo: 'Inativo', arquivado: 'Arquivado' },
  svc: { active: 'Ativo', paused: 'Pausado', cancelled: 'Cancelado' },
  entry: { pending: 'Em aberto', partial: 'Parcial', paid: 'Pago', cancelled: 'Cancelado' },
  sale: { confirmed: 'Confirmada', cancelled: 'Cancelada' },
  fu: { follow_up: 'Follow-up', contact: 'Contato', meeting: 'Reunião', proposal: 'Proposta', alignment: 'Alinhamento', charge: 'Cobrança' },
  fuStatus: { pending: 'Pendente', done: 'Concluído', cancelled: 'Cancelado' },
  prio: { low: 'Baixa', normal: 'Normal', high: 'Alta' },
  proj: { waiting_materials: 'Aguardando material', planning: 'Planejamento', design: 'Design', development: 'Desenvolvimento', review: 'Revisão', approval: 'Aprovação', published: 'Publicado', completed: 'Concluído', cancelled: 'Cancelado' },
  escopo: { empresa: 'GRAVV', pessoal: 'Pessoal' },
  tipo: { income: 'Entrada', expense: 'Saída' },
  mrr: { new: 'Novo', expansion: 'Expansão', contraction: 'Redução', churn: 'Churn', reactivation: 'Reativação' },
  act: { criado: 'Criado', nota: 'Nota', etapa: 'Etapa', ligacao: 'Ligação', whatsapp: 'WhatsApp', email: 'E-mail', reuniao: 'Reunião', follow_up: 'Follow-up', ganho: 'Ganho', perdido: 'Perdido', convertido: 'Convertido' },
  acct: { banco: 'Banco', carteira: 'Carteira', investimento: 'Investimento', cartao: 'Cartão', outro: 'Outro' },
};
const opts = map => Object.entries(map);
const TONE = { paid: 'good', done: 'good', active: 'good', ativo: 'good', confirmed: 'good', completed: 'good', published: 'good', partial: 'warn', paused: 'warn', pausado: 'warn', high: 'bad', cancelled: 'mute', arquivado: 'mute', inativo: 'mute' };
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
const sbadge = (map, v) => badge(L[map][v] || v, TONE[v] || '');

// ---------------------------------------------------------------- API
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = S.csrf;
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { if (!r.ok) throw Error('O servidor não respondeu direito. Tente de novo.'); }
  if (r.status === 401 && !path.startsWith('/api/login')) { showLogin('Sua sessão terminou. Entre de novo.'); throw Error('Sessão encerrada.'); }
  if (!r.ok) throw Error((data && data.error) || 'Não foi possível concluir.');
  return data;
}
// Leituras juntadas: tudo que a tela pede no mesmo instante vai numa chamada só (/api/batch).
let BATCH = null, BATCH_TIMER = 0;
function flushBatch() {
  clearTimeout(BATCH_TIMER);
  const items = BATCH; BATCH = null;
  if (!items || !items.length) return;
  if (items.length === 1) {
    const [it] = items;
    api(`/api/db/${it.t}${it.q ? '?' + it.q : ''}`).then(it.ok, it.no);
    return;
  }
  api('/api/batch?q=' + encodeURIComponent(JSON.stringify(items.map(it => [it.t, it.q])))).then(
    res => res.results.forEach((r, i) => ('error' in r ? items[i].no(Error(r.error)) : items[i].ok(r.data))),
    err => items.forEach(it => it.no(err)));
}
function batchGet(t, q) {
  return new Promise((ok, no) => {
    if (!BATCH) { BATCH = []; BATCH_TIMER = setTimeout(flushBatch, 4); }
    BATCH.push({ t, q, ok, no });
    if (BATCH.length >= 24) flushBatch();
  });
}
const db = {
  get: (t, q = '') => batchGet(t, q),
  add: (t, row) => api(`/api/db/${t}`, { method: 'POST', body: row }),
  set: (t, id, row) => api(`/api/db/${t}?id=${encodeURIComponent(id)}`, { method: 'PATCH', body: row }),
  del: (t, id) => api(`/api/db/${t}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
const rpc = async (name, body) => (await api('/api/rpc/' + name, { method: 'POST', body })).result;

function setRef({ stages, categories, accounts, services, clients, settings }) {
  Object.assign(REF, { stages, categories, accounts, services, clients, settings: Object.fromEntries(settings.map(s => [s.key, s.value])) });
}
async function loadRef() {
  const [stages, categories, accounts, services, clients, settings] = await Promise.all([
    db.get('pipeline_stages', 'order=posicao.asc'), db.get('financial_categories', 'order=nome.asc'),
    db.get('v_account_balances', 'order=nome.asc'), db.get('services', 'order=nome.asc'),
    db.get('clients', 'select=id,nome,status,telefone,email&order=nome.asc'), db.get('settings')]);
  setRef({ stages, categories, accounts, services, clients, settings });
}
const clientName = id => REF.clients.find(c => c.id === id)?.nome || '—';
const catOptions = (tipo, escopo) => REF.categories.filter(c => c.ativo && (!tipo || c.tipo === tipo) && (!escopo || c.escopo === escopo)).map(c => [c.id, c.nome]);
// Conta única (GRAVV + pessoal no mesmo banco): se não houver conta ativa do escopo, mostra todas as ativas.
const acctOptions = escopo => { const all = REF.accounts.filter(a => a.ativo); const mine = all.filter(a => !escopo || a.escopo === escopo); return (mine.length ? mine : all).map(a => [a.id, a.nome]); };
const clientOptions = () => REF.clients.filter(c => c.status !== 'arquivado').map(c => [c.id, c.nome]);
const defaultAccount = escopo => (REF.accounts.find(a => a.ativo && a.escopo === escopo) || REF.accounts.find(a => a.ativo))?.id || '';

// ---------------------------------------------------------------- componentes
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', funnel: 'M3 4h18l-7 9v6l-4 2v-8z', cart: 'M3 4h2l2.5 11h11L21 7H7M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.8M16 4.2a3 3 0 0 1 0 5.6',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8', folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', in: 'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16', out: 'M12 20V8m0 0l-5 5m5-5l5 5M4 4h16',
  flow: 'M3 12h4l3-8 4 16 3-8h4', minus: 'M4 12h16M6 6h12l-1 14H7z', repeat: 'M17 2l4 4-4 4M3 12V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 0 1-4 4H3',
  wallet: 'M3 7a2 2 0 0 1 2-2h14v4M3 7v10a2 2 0 0 0 2 2h16v-10H5a2 2 0 0 1-2-2zM16 14h.01', report: 'M6 3h9l5 5v13H6zM14 3v6h6M9 13h8M9 17h8',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5', chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.2 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1z',
  menu: 'M4 6h16M4 12h16M4 18h16', bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0', user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
};
const ico = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;
const btn = (text, action, data = {}, cls = '') => `<button type="button" class="${cls}" data-action="${action}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${esc(text)}</button>`;
const kpi = (label, value, sub = '', tone = '') => `<div class="kpi ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
const kpis = items => `<div class="kpis">${items.join('')}</div>`;
const empty = (title, text = '', action = '', label = '') => `<div class="empty"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${action ? btn(label, action, {}, 'primary') : ''}</div>`;
const panel = (title, body, aside = '', cls = '') => `<section class="panel ${cls}"><header class="panel-head"><h2>${esc(title)}</h2><div class="panel-aside">${aside}</div></header>${body}</section>`;
function table(headers, rows, emptyText = 'Nada por aqui ainda.') {
  if (!rows.length) return `<div class="empty small"><p>${esc(emptyText)}</p></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => { const [t, c] = Array.isArray(h) ? h : [h, '']; return `<th class="${c}">${esc(t)}</th>`; }).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
const tabs = (items, current, action, extra = {}) => `<div class="tabs" role="tablist">${items.map(([k, t]) => `<button type="button" role="tab" aria-selected="${k === current}" class="${k === current ? 'on' : ''}" data-action="${action}" data-v="${esc(k)}" ${Object.entries(extra).map(([a, b]) => `data-${a}="${esc(b)}"`).join(' ')}>${esc(t)}</button>`).join('')}</div>`;
const bar = (value, max, tone = '') => `<div class="bar ${tone}"><i style="width:${Math.max(0, Math.min(100, max ? (100 * value) / max : 0)).toFixed(1)}%"></i></div>`;
const link = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;

function toast(message, tone = '') {
  const t = $('#toast'); t.textContent = message; t.className = 'toast ' + tone; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 5000);
}

// ---------------------------------------------------------------- formulário lateral (Sheet)
let SHEET = null;
function fieldHTML(f, v) {
  const id = 'f-' + f.name; const req = f.required ? 'required' : '';
  const val = v ?? f.value ?? '';
  let ctl;
  if (f.type === 'select') {
    const list = typeof f.options === 'function' ? f.options() : f.options || [];
    ctl = `<select id="${id}" name="${f.name}" ${req}>${f.required && val !== '' ? '' : `<option value="">${esc(f.placeholder || (f.required ? 'Selecione…' : '—'))}</option>`}${list.map(([k, t]) => `<option value="${esc(k)}" ${String(val) === String(k) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') ctl = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
  else if (f.type === 'checkbox') return `<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" id="${id}" name="${f.name}" ${val ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else if (f.type === 'html') return `<div class="full">${f.html}</div>`;
  else {
    const type = { money: 'number', datetime: 'datetime-local' }[f.type] || f.type || 'text';
    const extra = f.type === 'money' ? 'step="0.01" min="0" inputmode="decimal"' : f.type === 'number' ? `step="${f.step || 1}" min="${f.min ?? ''}"` : '';
    const shown = f.type === 'datetime' && val ? String(val).slice(0, 16) : val;
    ctl = `<input id="${id}" name="${f.name}" type="${type}" value="${esc(shown)}" ${extra} ${req} placeholder="${esc(f.placeholder || '')}" ${f.readonly ? 'readonly' : ''}>`;
  }
  return `<label class="field ${f.full ? 'full' : ''}" for="${id}">${esc(f.label)}${f.required ? '' : ' <em>(opcional)</em>'}${ctl}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}
function openSheet({ title, fields = [], values = {}, submit = 'Salvar', onSubmit, html = '', onMount, danger = false, wide = false }) {
  SHEET = { fields, onSubmit, lastFocus: document.activeElement };
  $('#sheet-title').textContent = title;
  const oldBody = $('#sheet-body'); const fresh = oldBody.cloneNode(false); oldBody.replaceWith(fresh); // descarta ouvintes do formulário anterior
  fresh.innerHTML = `<div class="form-grid">${fields.map(f => fieldHTML(f, values[f.name])).join('')}</div>${html}`;
  $('#sheet-error').textContent = '';
  $('#sheet-foot').innerHTML = `<button type="button" data-close>Cancelar</button>${onSubmit ? `<button type="submit" class="${danger ? 'danger' : 'primary'}" id="sheet-submit">${esc(submit)}</button>` : ''}`;
  $('#sheet').classList.toggle('wide', wide);
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  document.body.classList.add('locked');
  onMount && onMount($('#sheet-body'));
  setTimeout(() => $('#sheet-body input:not([type=hidden]):not([readonly]), #sheet-body select, #sheet-body textarea')?.focus(), 30);
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; document.body.classList.remove('locked');
  if (SHEET?.lastFocus?.isConnected) SHEET.lastFocus.focus();
  SHEET = null;
}
function readForm(fields, root = $('#sheet-form')) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'html') continue;
    const el = root.querySelector(`[name="${f.name}"]`); if (!el) continue;
    if (f.type === 'checkbox') { out[f.name] = el.checked; continue; }
    let v = el.value.trim();
    if (f.required && v === '') throw Error(`Preencha: ${f.label}.`);
    if (v === '') { out[f.name] = null; continue; }
    if (f.type === 'money' || f.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw Error(`Número inválido em ${f.label}.`); if (f.type === 'money') v = round2(v); }
    if (f.type === 'datetime') v = new Date(v).toISOString();
    out[f.name] = v;
  }
  return out;
}
function confirmSheet(title, text, onConfirm, { label = 'Confirmar', danger = true, reason = false } = {}) {
  openSheet({ title, html: `<p class="lead-text">${esc(text)}</p>`, fields: reason ? [{ name: 'motivo', label: typeof reason === 'string' ? reason : 'Motivo', type: 'textarea', required: true, full: true }] : [],
    submit: label, danger, onSubmit: v => onConfirm(v) });
}

// ---------------------------------------------------------------- gráficos (SVG simples, sem biblioteca)
function barChart(labels, series, { height = 190, fmt = money } = {}) {
  const all = series.flatMap(s => s.values.map(num));
  if (!all.some(v => v)) return `<div class="empty small"><p>Sem movimentações no período.</p></div>`;
  const max = Math.max(1, ...all.map(Math.abs)); const n = labels.length; const W = 640; const H = height; const pad = 26;
  if (!n) return `<div class="empty small"><p>Sem dados no período.</p></div>`;
  const gw = (W - 10) / n; const bw = Math.max(3, Math.min(26, (gw - 8) / series.length));
  const bars = labels.map((lab, i) => series.map((s, j) => {
    const v = num(s.values[i]); const h = ((H - pad - 8) * Math.abs(v)) / max;
    const x = 5 + i * gw + (gw - bw * series.length) / 2 + j * bw;
    return `<rect x="${x.toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="s${j}"><title>${esc(lab)} · ${esc(s.name)}: ${esc(fmt(v))}</title></rect>`;
  }).join('')).join('');
  const step = Math.ceil(n / 12);
  const xl = labels.map((lab, i) => (i % step ? '' : `<text x="${(5 + i * gw + gw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`)).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, j) => `<span><i class="s${j}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<div class="chart">${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico"><line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" class="axis"/><text x="4" y="12" class="max">${esc(fmt(max))}</text>${bars}${xl}</svg></div>`;
}
function lineChart(labels, values, { height = 170, fmt = money } = {}) {
  const n = labels.length; if (!n) return `<div class="empty small"><p>Sem histórico ainda.</p></div>`;
  const W = 640, H = height, pad = 26; const max = Math.max(1, ...values.map(num)); const min = Math.min(0, ...values.map(num));
  const x = i => (n === 1 ? W / 2 : 20 + (i * (W - 40)) / (n - 1)); const y = v => H - pad - ((H - pad - 14) * (num(v) - min)) / (max - min || 1);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de linha"><line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" class="axis"/><polyline points="${pts}" class="line"/>${values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" class="pt"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></circle><text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`).join('')}<text x="4" y="12" class="max">${esc(fmt(max))}</text></svg></div>`;
}
function hbars(items, fmt = money) {
  if (!items.length) return `<div class="empty small"><p>Sem dados.</p></div>`;
  const max = Math.max(...items.map(i => Math.abs(num(i[1]))), 1);
  return `<div class="hbars">${items.map(([k, v, sub]) => `<div class="hbar"><span>${esc(k)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${bar(Math.abs(num(v)), max)}<b>${esc(fmt(v))}</b></div>`).join('')}</div>`;
}
function groupSum(rows, keyFn, valFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + num(valFn(r))); } return m; }

function downloadCSV(name, headers, rows) {
  const cell = v => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = '\ufeff' + [headers, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '.csv'; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const csvMoney = v => (v == null ? '' : num(v).toFixed(2).replace('.', ','));

// ---------------------------------------------------------------- rotas e navegação
const ROUTES = [];
const route = (pattern, title, fn, nav) => ROUTES.push({ re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), title, fn, nav });
const NAV = [
  ['', [['dashboard', 'Dashboard', 'home', '#/']]],
  ['Comercial', [['prospeccao', 'Prospecção', 'funnel', '#/prospeccao'], ['vendas', 'Vendas', 'cart', '#/vendas'], ['follow-ups', 'Follow-ups', 'clock', '#/follow-ups'], ['leads-site', 'Leads do site', 'inbox', '#/leads-site'], ['conversas', 'Conversas', 'chat', '#/conversas'], ['avisos', 'Avisos de cobrança', 'bell', '#/avisos']]],
  ['Clientes', [['clientes', 'Clientes', 'users', '#/clientes'], ['servicos', 'Serviços', 'box', '#/servicos'], ['projetos', 'Projetos', 'folder', '#/projetos']]],
  ['Financeiro', [['financeiro', 'Visão geral', 'chart', '#/financeiro'], ['receber', 'Contas a receber', 'in', '#/financeiro/receber'], ['pagar', 'Contas a pagar', 'out', '#/financeiro/pagar'], ['fluxo', 'Fluxo de caixa', 'flow', '#/financeiro/fluxo'], ['despesas', 'Despesas', 'minus', '#/financeiro/despesas'], ['mrr', 'MRR', 'repeat', '#/mrr']]],
  ['Pessoal', [['pessoal', 'Minhas finanças', 'wallet', '#/pessoal'], ['agente', 'Agente financeiro', 'chat', '#/agente']]],
  ['Gestão', [['relatorios', 'Relatórios', 'report', '#/relatorios']]],
];
let CURRENT = { nav: '', path: '', query: new URLSearchParams() };
const TAB_OF = { dashboard: 'inicio', prospeccao: 'funil', 'follow-ups': 'funil', vendas: 'funil', 'leads-site': 'funil',
  financeiro: 'financeiro', receber: 'financeiro', pagar: 'financeiro', fluxo: 'financeiro', despesas: 'financeiro', mrr: 'financeiro', avisos: 'financeiro', pessoal: 'pessoal', agente: 'pessoal' };
function setMenu(open) {
  $('#sidebar').classList.toggle('open', open); $('#side-backdrop').hidden = !open;
  $('#menu-toggle').setAttribute('aria-expanded', String(open)); document.body.classList.toggle('locked', open);
}
function renderNav() {
  $('#nav').innerHTML = NAV.map(([sec, items]) => `${sec ? `<div class="nav-sec">${esc(sec)}</div>` : ''}${items.map(([k, t, i, h]) => `<a href="${h}" class="nav-link ${CURRENT.nav === k ? 'on' : ''}" data-nav="${k}" ${CURRENT.nav === k ? 'aria-current="page"' : ''}><span class="ico">${ico(i)}</span>${esc(t)}</a>`).join('')}`).join('');
  $$('.side-foot .nav-link').forEach(a => a.classList.toggle('on', a.dataset.nav === CURRENT.nav));
  const tab = TAB_OF[CURRENT.nav] || 'menu';
  $$('#tabbar [data-tab]').forEach(a => { const on = a.dataset.tab === tab; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  $$('[data-ico]').forEach(i => { if (!i.innerHTML) i.innerHTML = ico(i.dataset.ico); });
}
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path === '' ? '/' : path, query: new URLSearchParams(qs || '') };
}
function setQuery(changes) {
  const { path, query } = parseHash();
  for (const [k, v] of Object.entries(changes)) (v == null || v === '' ? query.delete(k) : query.set(k, v));
  const qs = query.toString(); location.hash = '#' + path + (qs ? '?' + qs : '');
}
let RENDER_SEQ = 0;
async function render() {
  const seq = ++RENDER_SEQ;
  const { path, query } = parseHash();
  const r = ROUTES.find(x => x.re.test(path)) || ROUTES.find(x => x.nav === 'dashboard');
  const params = path.match(r.re)?.slice(1) || [];
  CURRENT = { nav: r.nav, path, query };
  renderNav();
  $('#page-title').textContent = r.title;
  document.title = `${r.title} · GRAVV CRM`;
  const main = $('#content');
  if (!main.innerHTML) main.innerHTML = '<div class="loading">Carregando…</div>';
  main.classList.add('busy'); document.body.classList.add('loading');
  refreshBell(); // entra no mesmo lote das consultas da tela
  try {
    const out = await r.fn(query, ...params);
    if (seq !== RENDER_SEQ) return; // o usuário já foi para outra tela
    const page = typeof out === 'string' ? { html: out } : out;
    if (page.title) { $('#page-title').textContent = page.title; document.title = `${page.title} · GRAVV CRM`; }
    main.innerHTML = page.html;
    labelTables(main);
    page.after && page.after(main);
  } catch (e) {
    if (seq === RENDER_SEQ && e.message !== 'Sessão encerrada.') main.innerHTML = `<div class="empty"><strong>Não carregou.</strong><p>${esc(e.message)}</p>${btn('Tentar de novo', 'reload', {}, 'primary')}</div>`;
  } finally { if (seq === RENDER_SEQ) { main.classList.remove('busy'); document.body.classList.remove('loading'); } }
}
// No celular as tabelas viram cartões: cada célula ganha o nome da coluna.
function labelTables(root) {
  $$('.table-wrap table', root).forEach(t => {
    const heads = $$('thead th', t).map(th => th.textContent.trim());
    $$('tbody tr', t).forEach(tr => [...tr.children].forEach((td, i) => { if (heads[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i]); }));
  });
}
const rerender = () => render();
async function saved(msg = 'Salvo.') { closeSheet(); toast(msg); await loadRef().catch(() => {}); await render(); }

// ---------------------------------------------------------------- arrastar e soltar (Kanban)
function enableDnD(root, onDrop) {
  let dragId = null;
  root.addEventListener('dragstart', e => { const card = e.target.closest('[data-drag]'); if (!card) return; dragId = card.dataset.drag; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
  root.addEventListener('dragend', e => { e.target.closest('[data-drag]')?.classList.remove('dragging'); $$('.drop-on', root).forEach(x => x.classList.remove('drop-on')); });
  root.addEventListener('dragover', e => { const col = e.target.closest('[data-drop]'); if (!col) return; e.preventDefault(); $$('.drop-on', root).forEach(x => x !== col && x.classList.remove('drop-on')); col.classList.add('drop-on'); });
  root.addEventListener('drop', async e => {
    const col = e.target.closest('[data-drop]'); if (!col || !dragId) return; e.preventDefault(); col.classList.remove('drop-on');
    const card = root.querySelector(`[data-drag="${CSS.escape(dragId)}"]`); const from = card?.closest('[data-drop]');
    if (!card || from === col) return;
    col.querySelector('.col-body').prepend(card); // otimista
    try { await onDrop(dragId, col.dataset.drop); } catch (err) { toast(err.message, 'bad'); } finally { await render(); }
  });
}

// ---------------------------------------------------------------- sessão
async function boot() {
  $('#retry').hidden = true; $('#login-form').hidden = true; $('#gate-title').textContent = 'Abrindo o CRM…'; $('#gate-message').textContent = '';
  try {
    const r = await fetch('/api/session?ref=1', { credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return showLogin(r.status === 403 ? 'Este e-mail não tem acesso ao CRM.' : '');
    const s = await r.json(); if (!r.ok) throw Error(s.error || 'Não foi possível abrir o CRM.');
    Object.assign(S, { csrf: s.csrf, today: s.today, owner: s.owner, email: s.email, owners: s.owners || [] });
    if (s.ref) setRef(s.ref); else await loadRef();
    $('#gate').hidden = true; $('#shell').hidden = false;
    await render();
  } catch (e) { $('#gate-title').textContent = 'Não foi possível abrir o CRM.'; $('#gate-message').textContent = e.message; $('#retry').hidden = false; }
}
function showLogin(msg = '') {
  $('#shell').hidden = true; $('#gate').hidden = false; $('#gate-title').textContent = 'Entre no CRM da GRAVV.';
  $('#gate-message').textContent = 'Acesso exclusivo.'; $('#login-error').textContent = msg; $('#login-form').hidden = false; $('#login-email').focus();
}

// ---------------------------------------------------------------- topo: busca, notificações, + Novo
async function refreshBell() {
  try {
    const now = new Date().toISOString();
    const [fu, en] = await Promise.all([
      db.get('v_follow_ups', `select=id,titulo,due_at,lead_id,client_id,lead_empresa,client_nome&status=eq.pending&due_at=lte.${encodeURIComponent(addDays(S.today, 1) + 'T03:00:00Z')}&order=due_at.asc&limit=20`),
      db.get('v_entries', `select=id,descricao,due_date,tipo,escopo,open_amount&status=in.(pending,partial)&due_date=lte.${S.today}&order=due_date.asc&limit=30`)]);
    const items = [
      ...fu.map(f => ({ t: `${f.due_at < now ? 'Atrasado' : 'Hoje'} · ${f.titulo}`, s: f.lead_empresa || f.client_nome || '', h: f.lead_id ? `#/prospeccao/${f.lead_id}` : `#/follow-ups` })),
      ...en.map(e => ({ t: `${e.due_date < S.today ? 'Vencido' : 'Vence hoje'} · ${e.descricao}`, s: `${L.escopo[e.escopo]} · ${money(e.open_amount)}`, h: e.escopo === 'pessoal' ? '#/pessoal' : e.tipo === 'income' ? '#/financeiro/receber?st=vencidos' : '#/financeiro/pagar?st=vencidos' }))];
    const c = $('#bell-count'); c.hidden = !items.length; c.textContent = items.length > 9 ? '9+' : items.length;
    $('#bell-menu').innerHTML = items.length ? items.map(i => `<a href="${esc(i.h)}"><b>${esc(i.t)}</b><small>${esc(i.s)}</small></a>`).join('') : '<p class="muted pad">Nada atrasado. Tudo em dia.</p>';
  } catch { /* silencioso */ }
}
const NEW_MENU = [['Lead', 'new-lead'], ['Cliente', 'new-client'], ['Venda', 'new-sale'], ['Follow-up', 'new-followup'], ['Fatura (a receber)', 'new-invoice'], ['Despesa (a pagar)', 'new-expense'], ['Projeto', 'new-project'], ['Lançamento pessoal', 'new-personal-quick']];
function toggleMenu(id, show) { $$('.dropdown').forEach(d => { if (d.id !== id) d.hidden = true; }); const m = $('#' + id); m.hidden = show === undefined ? !m.hidden : !show; }
let searchTimer;
async function globalSearch(q) {
  const box = $('#search-results');
  if (q.length < 2) { box.hidden = true; return; }
  const like = encodeURIComponent(`*${q.replace(/[*,()]/g, ' ')}*`);
  const [cl, le, pr] = await Promise.all([db.get('clients', `select=id,nome&nome=ilike.${like}&limit=6`), db.get('leads', `select=id,empresa&empresa=ilike.${like}&limit=6`), db.get('projects', `select=id,nome&nome=ilike.${like}&limit=6`)]);
  const rows = [...cl.map(c => [`#/clientes/${c.id}`, c.nome, 'Cliente']), ...le.map(l => [`#/prospeccao/${l.id}`, l.empresa, 'Lead']), ...pr.map(p => [`#/projetos/${p.id}`, p.nome, 'Projeto'])];
  box.innerHTML = rows.length ? rows.map(([h, t, k]) => `<a href="${h}"><b>${esc(t)}</b><small>${k}</small></a>`).join('') : '<p class="muted pad">Nada encontrado.</p>';
  box.hidden = false;
}

// ---------------------------------------------------------------- eventos globais
document.addEventListener('click', async e => {
  if (e.target.closest('[data-close]')) { e.preventDefault(); closeSheet(); return; }
  if (e.target.closest('#sidebar a')) setMenu(false);
  if (!e.target.closest('.dropdown, #bell, #new-btn, #global-search')) $$('.dropdown').forEach(d => (d.hidden = true));
  if (e.target.closest('.dropdown a')) $$('.dropdown').forEach(d => (d.hidden = true));
  const el = e.target.closest('[data-action]'); if (!el) return;
  const fn = ACTIONS[el.dataset.action]; if (!fn) return;
  e.preventDefault(); $$('.dropdown').forEach(d => (d.hidden = true));
  if (el.disabled) return;
  el.disabled = true;
  try { await fn(el.dataset, el, e); } catch (err) { toast(err.message, 'bad'); } finally { el.disabled = false; }
});
$('#sheet-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!SHEET?.onSubmit) return;
  const b = $('#sheet-submit'); b.disabled = true; $('#sheet-error').textContent = '';
  try { await SHEET.onSubmit(readForm(SHEET.fields)); } catch (err) { $('#sheet-error').textContent = err.message; } finally { if (b.isConnected) b.disabled = false; }
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (SHEET) closeSheet(); setMenu(false); $$('.dropdown').forEach(d => (d.hidden = true)); } });
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const b = $('#login-button'); b.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: { email: $('#login-email').value.trim(), password: $('#login-password').value } }); $('#login-password').value = ''; await boot(); }
  catch (err) { $('#login-error').textContent = err.message; } finally { b.disabled = false; }
});
$('#retry').addEventListener('click', boot);
$('#menu-toggle').addEventListener('click', () => setMenu(!$('#sidebar').classList.contains('open')));
$('#side-backdrop').addEventListener('click', () => setMenu(false));
$('#tab-menu').addEventListener('click', () => setMenu(!$('#sidebar').classList.contains('open')));
$('#bell').addEventListener('click', () => toggleMenu('bell-menu'));
$('#new-btn').addEventListener('click', () => { $('#new-menu').innerHTML = NEW_MENU.map(([t, a]) => `<button type="button" data-action="${a}">${esc(t)}</button>`).join(''); toggleMenu('new-menu'); });
$('#global-search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => globalSearch(e.target.value.trim()).catch(() => {}), 250); });
$('#global-search').addEventListener('focus', e => e.target.value.trim().length > 1 && ($('#search-results').hidden = false));
window.addEventListener('hashchange', () => { if (SHEET) closeSheet(); setMenu(false); window.scrollTo(0, 0); $('#global-search').value = ''; $('#search-results').hidden = true; render(); });

ACTIONS.reload = () => render();
ACTIONS.logout = async () => { await api('/api/logout', { method: 'POST' }); location.hash = ''; location.reload(); };
ACTIONS.go = d => { location.hash = d.href; };
ACTIONS.setq = d => setQuery({ [d.k]: d.v });
