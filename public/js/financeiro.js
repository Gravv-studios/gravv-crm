'use strict';
/* Financeiro (empresa e pessoal), MRR e Minhas finanças. Título = obrigação; pagamento = dinheiro que se moveu. */
const METODOS = ['Pix', 'Boleto', 'Cartão', 'Transferência', 'Dinheiro', 'Débito automático'].map(x => [x, x]);
const OPEN = 'status=in.(pending,partial)';
const AGING = [['a_vencer', 'A vencer'], ['1-7', '1–7 dias'], ['8-30', '8–30 dias'], ['31-60', '31–60 dias'], ['60+', '60+ dias']];
const balanceHint = () => (REF.accounts.length && REF.accounts.every(a => !num(a.opening_balance)) ? `<div class="notice">Dica: coloque o <b>saldo inicial</b> de cada conta (quanto tinha no banco quando começou a usar o CRM) em ${link('#/configuracoes?tab=financeiro', 'Configurações › Financeiro')}. Aí o saldo disponível fecha com o banco.</div>` : '');
const scopeQ = esc2 => (esc2 === 'tudo' ? '' : `&escopo=eq.${esc2}`);

function entryTable(rows, { client = true, actions = true } = {}) {
  return table(['Vencimento', 'Descrição', ...(client ? ['Cliente'] : []), ['Valor', 'r'], ['Em aberto', 'r'], 'Status', ...(actions ? [''] : [])], rows.map(e => `<tr class="${e.overdue ? 'late' : ''}">
    <td>${fdate(e.due_date)}${e.overdue ? badge(e.aging + ' dias', 'bad') : ''}</td><td><b>${esc(e.descricao)}</b><small>${esc([e.category_nome, e.escopo === 'pessoal' ? 'Pessoal' : '', e.account_nome].filter(Boolean).join(' · '))}</small></td>
    ${client ? `<td>${e.client_id ? link('#/clientes/' + e.client_id, e.client_nome) : e.debt_id ? esc(e.debt_nome) : '—'}</td>` : ''}
    <td class="r">${money(e.amount)}</td><td class="r">${e.status === 'cancelled' ? '—' : money(e.open_amount)}</td><td>${sbadge('entry', e.status)}</td>
    ${actions ? `<td class="r nowrap">${['pending', 'partial'].includes(e.status) ? btn(e.tipo === 'income' ? 'Receber' : 'Pagar', 'settle', { id: e.id }, 'small primary') : ''}${num(e.paid_amount) ? btn('Pagamentos', 'payments', { id: e.id }, 'small') : ''}${e.status !== 'cancelled' ? btn('Editar', 'edit-entry', { id: e.id }, 'small subtle') : ''}${e.status === 'pending' ? btn('Cancelar', 'cancel-entry', { id: e.id }, 'small subtle') : ''}</td>` : ''}</tr>`), 'Nenhum título aqui.');
}

// ---------------------------------------------------------------- formulários
function entryForm({ tipo, escopo = 'empresa', entry = null, preset = {} }) {
  const inc = tipo === 'income';
  openSheet({ title: entry ? 'Editar título' : inc ? (escopo === 'pessoal' ? 'Nova entrada prevista' : 'Nova fatura (a receber)') : (escopo === 'pessoal' ? 'Nova conta pessoal' : 'Nova despesa (a pagar)'),
    values: entry || { due_date: S.today, account_id: defaultAccount(escopo), ...preset }, fields: [
      { name: 'descricao', label: 'Descrição', required: true, full: true },
      ...(escopo === 'empresa' ? [{ name: 'client_id', label: 'Cliente', type: 'select', options: clientOptions, placeholder: '— nenhum —' }] : []),
      { name: 'category_id', label: 'Categoria', type: 'select', options: () => catOptions(tipo, escopo) },
      { name: 'amount', label: 'Valor (R$)', type: 'money', required: true }, { name: 'due_date', label: 'Vencimento', type: 'date', required: true },
      { name: 'account_id', label: 'Conta', type: 'select', options: () => acctOptions(escopo) }, { name: 'notas', label: 'Notas', type: 'textarea', full: true }],
    onSubmit: async v => { if (entry) await db.set('financial_entries', entry.id, v); else await db.add('financial_entries', { ...v, tipo, escopo }); await saved(entry ? 'Título atualizado.' : 'Lançado.'); } });
}
ACTIONS['new-invoice'] = d => entryForm({ tipo: 'income', preset: d.client ? { client_id: d.client } : {} });
ACTIONS['new-expense'] = d => entryForm({ tipo: 'expense', escopo: d.escopo || 'empresa' });
ACTIONS['new-income-personal'] = () => entryForm({ tipo: 'income', escopo: 'pessoal' });
ACTIONS['edit-entry'] = async d => { const e = (await db.get('financial_entries', `id=eq.${d.id}`))[0]; entryForm({ tipo: e.tipo, escopo: e.escopo, entry: e }); };
ACTIONS['cancel-entry'] = d => confirmSheet('Cancelar título', 'O título sai do a receber/a pagar. O histórico continua guardado.', async () => { await db.set('financial_entries', d.id, { status: 'cancelled' }); await saved('Título cancelado.'); }, { label: 'Cancelar título' });
ACTIONS.settle = async d => {
  const [e] = await db.get('v_entries', `id=eq.${d.id}`);
  openSheet({ title: `${e.tipo === 'income' ? 'Receber' : 'Pagar'}: ${e.descricao}`, html: `<p class="lead-text">Em aberto: <b>${money(e.open_amount)}</b> · vence ${fdate(e.due_date)}</p>`,
    values: { amount: e.open_amount, paid_at: S.today, account_id: e.account_id || defaultAccount(e.escopo), payment_method: 'Pix' }, fields: [
      { name: 'amount', label: 'Valor (R$)', type: 'money', required: true, hint: 'Pode ser parcial.' }, { name: 'paid_at', label: 'Data', type: 'date', required: true },
      { name: 'account_id', label: 'Conta', type: 'select', required: true, options: () => acctOptions() }, { name: 'payment_method', label: 'Forma', type: 'select', options: METODOS },
      { name: 'notes', label: 'Observação', full: true }],
    submit: e.tipo === 'income' ? 'Confirmar recebimento' : 'Confirmar pagamento',
    onSubmit: async v => { await rpc('settle_entry', { p: { ...v, entry_id: e.id } }); await saved(e.tipo === 'income' ? 'Recebimento registrado.' : 'Pagamento registrado.'); } });
};
ACTIONS.payments = async d => {
  const pays = await db.get('v_payments', `entry_id=eq.${d.id}&order=paid_at.desc`);
  openSheet({ title: 'Pagamentos deste título', html: table(['Data', ['Valor', 'r'], 'Conta', ''], pays.map(p => `<tr class="${p.reversed ? 'muted' : ''}"><td>${fdate(p.paid_at)}<small>${esc(p.payment_method || '')}</small></td><td class="r">${money(p.amount)}</td><td>${esc(p.account_nome || '—')}</td>
    <td class="r">${p.reversed ? badge('Estornado', 'mute') + `<small>${esc(p.reverse_reason || '')}</small>` : btn('Estornar', 'reverse', { id: p.id }, 'small subtle')}</td></tr>`)) });
};
ACTIONS.reverse = d => confirmSheet('Estornar pagamento', 'O valor volta a ficar em aberto no título e sai do saldo da conta. O registro original fica guardado como estornado.', async v => { await rpc('reverse_payment', { p_payment: d.id, p_reason: v.motivo }); await saved('Pagamento estornado.'); }, { label: 'Estornar', reason: 'Motivo do estorno' });
function quickForm({ tipo = 'income', escopo = 'empresa', title }) {
  openSheet({ title, values: { tipo, paid_at: S.today, account_id: defaultAccount(escopo), payment_method: 'Pix', ja_pago: true }, fields: [
    { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: [['income', 'Entrada'], ['expense', 'Saída']] },
    { name: 'descricao', label: 'Descrição', required: true }, { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
    { name: 'category_id', label: 'Categoria', type: 'select', options: () => REF.categories.filter(c => c.ativo && c.escopo === escopo).map(c => [c.id, `${c.nome} (${L.tipo[c.tipo]})`]) },
    ...(escopo === 'empresa' ? [{ name: 'client_id', label: 'Cliente', type: 'select', options: clientOptions, placeholder: '— nenhum —' }] : []),
    { name: 'paid_at', label: 'Data', type: 'date', required: true }, { name: 'account_id', label: 'Conta', type: 'select', required: true, options: () => acctOptions(escopo) },
    { name: 'payment_method', label: 'Forma', type: 'select', options: METODOS }, { name: 'ja_pago', label: 'Já foi pago/recebido (movimenta o saldo agora)', type: 'checkbox', full: true }],
    onSubmit: async v => {
      if (v.ja_pago) await rpc('quick_entry', { p: { ...v, escopo } });
      else await db.add('financial_entries', { tipo: v.tipo, escopo, descricao: v.descricao, amount: v.amount, due_date: v.paid_at, category_id: v.category_id, account_id: v.account_id, client_id: v.client_id || null });
      await saved('Lançado.');
    } });
}
ACTIONS['quick-empresa'] = () => quickForm({ title: 'Lançamento avulso (GRAVV)' });
ACTIONS['new-personal-quick'] = () => quickForm({ tipo: 'expense', escopo: 'pessoal', title: 'Lançamento pessoal' });
ACTIONS.retirada = () => openSheet({ title: 'Retirada da GRAVV para o pessoal', html: '<p class="lead-text">Registra a saída na conta da GRAVV e a entrada na sua conta pessoal. Não conta como receita nem despesa da operação.</p>',
  values: { paid_at: S.today, from: defaultAccount('empresa'), to: defaultAccount('pessoal') }, fields: [
    { name: 'amount', label: 'Valor (R$)', type: 'money', required: true }, { name: 'paid_at', label: 'Data', type: 'date', required: true },
    { name: 'from', label: 'Sai de', type: 'select', required: true, options: () => acctOptions('empresa') }, { name: 'to', label: 'Entra em', type: 'select', required: true, options: () => acctOptions('pessoal') }],
  onSubmit: async v => {
    await rpc('quick_entry', { p: { tipo: 'expense', escopo: 'empresa', descricao: 'Retirada para o pessoal', amount: v.amount, paid_at: v.paid_at, account_id: v.from, category_id: REF.categories.find(c => c.nome === 'Retirada para o pessoal')?.id || '', payment_method: 'Transferência' } });
    await rpc('quick_entry', { p: { tipo: 'income', escopo: 'pessoal', descricao: 'Retirada da GRAVV', amount: v.amount, paid_at: v.paid_at, account_id: v.to, category_id: REF.categories.find(c => c.nome === 'Retirada da GRAVV')?.id || '', payment_method: 'Transferência' } });
    await saved('Retirada registrada nas duas contas.');
  } });
ACTIONS['gen-billing'] = async () => { const r = await rpc('generate_recurring_billing', { p_until: addDays(S.today, 30) }); toast(r.criadas ? `${r.criadas} cobrança(s) gerada(s) até ${fdate(r.ate)}.` : 'Nenhuma cobrança nova: tudo já estava gerado.'); await loadRef(); await render(); };

// ---------------------------------------------------------------- dados compartilhados
async function finData(escopo) {
  const sq = scopeQ(escopo);
  const [entries, pays, accts] = await Promise.all([db.get('v_entries', `status=neq.cancelled${sq}&order=due_date.asc`), db.get('v_payments', `reversed=is.false${sq}&order=paid_at.desc`), db.get('v_account_balances', `ativo=is.true${sq}`)]);
  return { entries, pays, accts, saldo: accts.reduce((a, x) => a + num(x.saldo), 0) };
}
const scopeTabs = (cur, def = 'empresa') => tabs([['empresa', 'GRAVV'], ['pessoal', 'Pessoal'], ['tudo', 'Consolidado']], cur || def, 'setq', { k: 'esc' });
const monthsBack = n => Array.from({ length: n }, (_, i) => addMonths(monthStart(S.today), i - n + 1));

route('/financeiro', 'Financeiro', async q => {
  const escopo = q.get('esc') || 'empresa'; const { entries, pays, accts, saldo } = await finData(escopo);
  const ms = monthStart(S.today); const open = entries.filter(e => ['pending', 'partial'].includes(e.status));
  const rec = open.filter(e => e.tipo === 'income'); const pag = open.filter(e => e.tipo === 'expense');
  const mp = pays.filter(p => p.paid_at >= ms); const inM = mp.filter(p => p.tipo === 'income').reduce((a, p) => a + num(p.amount), 0); const outM = mp.filter(p => p.tipo === 'expense').reduce((a, p) => a + num(p.amount), 0);
  const months = monthsBack(6); const byM = (t) => months.map(m => pays.filter(p => p.tipo === t && p.paid_at.slice(0, 7) === m.slice(0, 7)).reduce((a, p) => a + num(p.amount), 0));
  const agingOf = list => AGING.map(([k, t]) => [t, list.filter(e => e.aging === k).reduce((a, e) => a + num(e.open_amount), 0)]);
  const next = open.filter(e => e.due_date <= addDays(S.today, 15)).slice(0, 12);
  return `<div class="toolbar">${scopeTabs(escopo)}<span class="grow"></span>${btn('Retirada → pessoal', 'retirada')}${btn('Lançamento avulso', 'quick-empresa')}${btn('+ Fatura', 'new-invoice')}${btn('+ Despesa', 'new-expense', {}, 'primary')}</div>`
    + balanceHint() + kpis([kpi('Saldo disponível', money(saldo), 'saldo inicial + movimentos', saldo < 0 ? 'bad' : ''), kpi('A receber', money(rec.reduce((a, e) => a + num(e.open_amount), 0)), `${rec.filter(e => e.overdue).length} vencido(s)`),
      kpi('A pagar', money(pag.reduce((a, e) => a + num(e.open_amount), 0)), `${pag.filter(e => e.overdue).length} vencido(s)`), kpi('Resultado de caixa no mês', money(inM - outM), `entrou ${money(inM)} · saiu ${money(outM)}`, inM - outM < 0 ? 'bad' : 'good')])
    + `<div class="grid-2">${panel('Entradas × saídas (caixa realizado)', barChart(months.map(monthLabel), [{ name: 'Entradas', values: byM('income') }, { name: 'Saídas', values: byM('expense') }]))}
      ${panel('Contas', table(['Conta', 'Tipo', ['Saldo', 'r']], accts.map(a => `<tr><td><b>${esc(a.nome)}</b><small>${esc(L.escopo[a.escopo])}</small></td><td>${esc(L.acct[a.tipo])}</td><td class="r ${num(a.saldo) < 0 ? 'bad-text' : ''}">${money(a.saldo)}</td></tr>`)), link('#/configuracoes?tab=financeiro', 'Gerenciar'))}</div>
      <div class="grid-2">${panel('A receber por atraso', hbars(agingOf(rec)))}${panel('A pagar por atraso', hbars(agingOf(pag)))}</div>`
    + panel('Vencendo nos próximos 15 dias (e atrasados)', entryTable(next));
}, 'financeiro');

function titlesPage(tipo) {
  return async q => {
    const inc = tipo === 'income'; const st = q.get('st') || 'abertos'; const busca = (q.get('q') || '').toLowerCase(); const escopo = q.get('esc') || 'empresa';
    const [all, pays] = await Promise.all([db.get('v_entries', `tipo=eq.${tipo}${scopeQ(escopo)}&order=due_date.asc`), db.get('v_payments', `tipo=eq.${tipo}${scopeQ(escopo)}&order=paid_at.desc&limit=40`)]);
    const ms = monthStart(S.today); const open = all.filter(e => ['pending', 'partial'].includes(e.status));
    const f = { abertos: e => ['pending', 'partial'].includes(e.status), vencidos: e => e.overdue, mes: e => e.status !== 'cancelled' && e.due_date >= ms && e.due_date <= monthEnd(S.today), pagos: e => e.status === 'paid', todos: () => true }[st];
    const rows = all.filter(f).filter(e => !busca || `${e.descricao} ${e.client_nome} ${e.category_nome} ${e.debt_nome}`.toLowerCase().includes(busca));
    if (st === 'pagos' || st === 'todos') rows.reverse();
    const pm = pays.filter(p => !p.reversed && p.paid_at >= ms).reduce((a, p) => a + num(p.amount), 0);
    return `<div class="toolbar">${scopeTabs(escopo)}<span class="grow"></span>${inc ? btn('Gerar cobranças recorrentes', 'gen-billing') + btn('Recebimento avulso', 'quick-empresa') + btn('+ Nova fatura', 'new-invoice', {}, 'primary') : btn('Pagamento avulso', 'quick-empresa') + btn('+ Nova despesa', 'new-expense', { escopo: escopo === 'pessoal' ? 'pessoal' : 'empresa' }, 'primary')}</div>`
      + kpis([kpi('Em aberto', money(open.reduce((a, e) => a + num(e.open_amount), 0)), `${open.length} título(s)`), kpi('Vencido', money(open.filter(e => e.overdue).reduce((a, e) => a + num(e.open_amount), 0)), '', open.some(e => e.overdue) ? 'bad' : ''),
        kpi('Vence em 30 dias', money(open.filter(e => !e.overdue && e.due_date <= addDays(S.today, 30)).reduce((a, e) => a + num(e.open_amount), 0))), kpi(inc ? 'Recebido no mês' : 'Pago no mês', money(pm))])
      + `<div class="toolbar">${tabs([['abertos', 'Em aberto'], ['vencidos', 'Vencidos'], ['mes', 'Deste mês'], ['pagos', inc ? 'Recebidos' : 'Pagos'], ['todos', 'Todos']], st, 'setq', { k: 'st' })}<input type="search" data-q="q" placeholder="Buscar…" value="${esc(q.get('q') || '')}"><span class="grow"></span>${btn('Exportar CSV', 'entries-csv', { tipo, st, esc: escopo })}</div>`
      + panel(inc ? 'Contas a receber' : 'Contas a pagar', entryTable(rows))
      + panel(inc ? 'Últimos recebimentos' : 'Últimos pagamentos', table(['Data', 'Título', 'Conta', ['Valor', 'r'], ''], pays.map(p => `<tr class="${p.reversed ? 'muted' : ''}"><td>${fdate(p.paid_at)}</td><td>${esc(p.descricao)}<small>${esc(p.client_nome || p.category_nome || '')}</small></td><td>${esc(p.account_nome || '—')}</td><td class="r">${money(p.amount)}</td><td class="r">${p.reversed ? badge('Estornado', 'mute') : btn('Estornar', 'reverse', { id: p.id }, 'small subtle')}</td></tr>`), 'Nada ainda.'));
  };
}
route('/financeiro/receber', 'Contas a receber', titlesPage('income'), 'receber');
route('/financeiro/pagar', 'Contas a pagar', titlesPage('expense'), 'pagar');
ACTIONS['entries-csv'] = async d => {
  const rows = await db.get('v_entries', `tipo=eq.${d.tipo}${scopeQ(d.esc)}&order=due_date.asc`);
  downloadCSV(d.tipo === 'income' ? 'contas-a-receber' : 'contas-a-pagar', ['Vencimento', 'Descrição', 'Cliente', 'Categoria', 'Escopo', 'Valor', 'Pago', 'Em aberto', 'Status', 'Atraso'],
    rows.map(e => [fdate(e.due_date), e.descricao, e.client_nome || e.debt_nome || '', e.category_nome || '', L.escopo[e.escopo], csvMoney(e.amount), csvMoney(e.paid_amount), csvMoney(e.open_amount), L.entry[e.status], e.aging || '']));
};

route('/financeiro/despesas', 'Despesas', async q => {
  const m = q.get('m') || S.today.slice(0, 7); const escopo = q.get('esc') || 'empresa'; const a = m + '-01'; const b = monthEnd(a); const pa = addMonths(a, -1); const pb = monthEnd(pa);
  const all = await db.get('v_entries', `tipo=eq.expense&status=neq.cancelled${scopeQ(escopo)}&due_date=gte.${pa}&due_date=lte.${b}&order=due_date.asc`);
  const cur = all.filter(e => e.due_date >= a); const prev = all.filter(e => e.due_date < a);
  const total = cur.reduce((s, e) => s + num(e.amount), 0); const ptotal = prev.reduce((s, e) => s + num(e.amount), 0);
  const cats = [...groupSum(cur, e => e.category_nome || 'Sem categoria', e => e.amount)].sort((x, y) => y[1] - x[1]);
  const opt = Array.from({ length: 12 }, (_, i) => addMonths(monthStart(S.today), 3 - i).slice(0, 7));
  return `<div class="toolbar">${scopeTabs(escopo)}<select data-q="m" aria-label="Mês">${opt.map(o => `<option value="${o}" ${o === m ? 'selected' : ''}>${monthLabel(o + '-01')}</option>`).join('')}</select><span class="grow"></span>${btn('+ Despesa', 'new-expense', { escopo: escopo === 'pessoal' ? 'pessoal' : 'empresa' }, 'primary')}</div>`
    + kpis([kpi('Despesas do mês', money(total), ptotal ? `mês anterior ${money(ptotal)}` : ''), kpi('Pagas', money(cur.reduce((s, e) => s + num(e.paid_amount), 0))), kpi('Em aberto', money(cur.reduce((s, e) => s + num(e.open_amount), 0))), kpi('Maior categoria', cats[0]?.[0] || '—', cats[0] ? money(cats[0][1]) : '')])
    + `<div class="grid-2">${panel('Por categoria', hbars(cats))}${panel('Lançamentos do mês', entryTable(cur, { client: false }))}</div>`;
}, 'despesas');

route('/financeiro/fluxo', 'Fluxo de caixa', async q => {
  const h = Number(q.get('h') || 30); const escopo = q.get('esc') || 'empresa'; const past = Number(q.get('p') || 30);
  const { entries, pays, saldo } = await finData(escopo);
  const open = entries.filter(e => ['pending', 'partial'].includes(e.status) && e.due_date <= addDays(S.today, h));
  const weeks = []; for (let d = S.today; d <= addDays(S.today, h); d = addDays(d, 7)) weeks.push(d);
  let bal = saldo; let min = saldo; let minDay = S.today;
  const rows = weeks.map((w, i) => { const end = addDays(w, 6); const inW = open.filter(e => e.tipo === 'income' && (i === 0 ? e.due_date <= end : inRange(e.due_date, w, end))); const outW = open.filter(e => e.tipo === 'expense' && (i === 0 ? e.due_date <= end : inRange(e.due_date, w, end)));
    const ins = inW.reduce((a, e) => a + num(e.open_amount), 0); const outs = outW.reduce((a, e) => a + num(e.open_amount), 0); bal += ins - outs; if (bal < min) { min = bal; minDay = w; }
    return { w, end, ins, outs, bal }; });
  const since = addDays(S.today, -past); const real = pays.filter(p => p.paid_at >= since);
  const days = []; for (let d = since; d <= S.today; d = addDays(d, past > 60 ? 7 : 1)) days.push(d);
  const bucket = (t) => days.map((d, i) => real.filter(p => p.tipo === t && p.paid_at >= d && p.paid_at < (days[i + 1] || addDays(S.today, 1))).reduce((a, p) => a + num(p.amount), 0));
  return `<div class="toolbar">${scopeTabs(escopo)}${tabs([['30', 'Próx. 30 dias'], ['60', '60 dias'], ['90', '90 dias']], String(h), 'setq', { k: 'h' })}</div>`
    + kpis([kpi('Saldo hoje', money(saldo)), kpi('Entradas previstas', money(rows.reduce((a, r) => a + r.ins, 0)), `em ${h} dias (inclui vencidos)`), kpi('Saídas previstas', money(rows.reduce((a, r) => a + r.outs, 0))),
      kpi('Menor saldo previsto', money(min), fdate(minDay), min < 0 ? 'bad' : '')])
    + (min < 0 ? `<div class="notice bad">O saldo previsto fica negativo a partir de <b>${fdate(minDay)}</b>. Cobre os atrasados ou negocie vencimentos antes disso.</div>` : '')
    + panel('Previsão por semana', barChart(rows.map(r => fdate(r.w).slice(0, 5)), [{ name: 'Entradas', values: rows.map(r => r.ins) }, { name: 'Saídas', values: rows.map(r => r.outs) }])
      + table(['Semana', ['Entradas', 'r'], ['Saídas', 'r'], ['Saldo projetado', 'r']], rows.map(r => `<tr><td>${fdate(r.w)} – ${fdate(r.end)}</td><td class="r">${money(r.ins)}</td><td class="r">${money(r.outs)}</td><td class="r ${r.bal < 0 ? 'bad-text' : ''}"><b>${money(r.bal)}</b></td></tr>`)))
    + panel('Realizado', `<div class="toolbar">${tabs([['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['365', 'Ano']], String(past), 'setq', { k: 'p' })}</div>` + barChart(days.map(d => fdate(d).slice(0, 5)), [{ name: 'Entradas', values: bucket('income') }, { name: 'Saídas', values: bucket('expense') }]));
}, 'fluxo');

// ---------------------------------------------------------------- MRR
route('/mrr', 'MRR', async () => {
  const [[sum], svcs, events, runs, byClient] = await Promise.all([db.get('v_mrr_summary'), db.get('v_client_services', 'periodicidade=neq.one_time&order=next_billing_date.asc'),
    db.get('mrr_events', 'order=effective_at.asc,created_at.asc'), db.get('recurring_billing_runs', 'order=run_at.desc&limit=8'), db.get('v_client_mrr', 'mrr=gt.0&order=mrr.desc')]);
  const meta = num(REF.settings.metas?.mrr_meta); const ms = monthStart(S.today);
  const months = [...new Set(events.map(e => e.effective_at.slice(0, 7)))].sort(); let acc = 0;
  const hist = months.map(m => { acc += events.filter(e => e.effective_at.slice(0, 7) === m).reduce((a, e) => a + num(e.mrr_delta), 0); return acc; });
  const mEv = events.filter(e => e.effective_at >= ms); const s = k => mEv.filter(e => e.tipo === k).reduce((a, e) => a + num(e.mrr_delta), 0);
  const active = svcs.filter(x => x.status === 'active'); const pending = active.filter(x => x.next_billing_date && x.next_billing_date <= addDays(S.today, 30));
  const bySvc = [...groupSum(active, x => x.descricao.replace(/ —.*$/, ''), x => x.mrr)].sort((a, b) => b[1] - a[1]);
  const top = num(byClient[0]?.mrr); const conc = num(sum.mrr) ? (100 * top) / num(sum.mrr) : 0;
  const startM = events.filter(e => e.effective_at < ms).reduce((a, e) => a + num(e.mrr_delta), 0);
  return kpis([kpi('MRR', money(sum.mrr), meta ? `meta ${money(meta)} · ${pct((100 * num(sum.mrr)) / meta)}` : 'defina a meta em Configurações'), kpi('ARR', money(sum.arr)), kpi('Clientes recorrentes', sum.clientes_recorrentes, `ticket médio ${money(sum.ticket_medio)}`),
      kpi('Churn no mês', money(Math.abs(s('churn') + s('contraction'))), startM ? `taxa ${pct((100 * (-s('churn'))) / startM)}` : '', s('churn') < 0 ? 'bad' : '')])
    + (meta ? `<div class="goal-line">${bar(num(sum.mrr), meta, 'good')}<small>Faltam ${money(Math.max(0, meta - num(sum.mrr)))} de MRR para a meta.</small></div>` : '')
    + `<div class="grid-2">${panel('Histórico do MRR', lineChart(months.map(m => monthLabel(m + '-01')), hist))}
      ${panel('Movimentações do mês', table(['Tipo', ['MRR', 'r']], [['Novo', s('new')], ['Expansão', s('expansion')], ['Reativação', s('reactivation')], ['Redução', s('contraction')], ['Churn', s('churn')]].map(([t, v]) => `<tr><td>${t}</td><td class="r ${v < 0 ? 'bad-text' : ''}">${money(v)}</td></tr>`).concat(`<tr class="total"><td>Net New MRR</td><td class="r">${money(mEv.reduce((a, e) => a + num(e.mrr_delta), 0))}</td></tr>`)))}</div>`
    + `<div class="grid-2">${panel('Top clientes', hbars(byClient.map(c => [c.nome, c.mrr])), conc ? `<small>${pct(conc)} do MRR no maior cliente</small>` : '')}${panel('MRR por serviço', hbars(bySvc))}</div>`
    + panel('Contratos recorrentes', table(['Cliente', 'Serviço', ['Valor', 'r'], ['MRR', 'r'], 'Próxima cobrança', 'Status', ''], svcs.filter(x => x.status !== 'cancelled').map(x => `<tr><td>${link('#/clientes/' + x.client_id, x.client_nome)}</td><td>${esc(x.descricao)}<small>desde ${fdate(x.started_at)}</small></td><td class="r">${money(x.valor)}<small>${esc(L.per[x.periodicidade])}</small></td><td class="r">${x.status === 'active' ? money(x.mrr) : '—'}</td><td>${fdate(x.next_billing_date)}</td><td>${sbadge('svc', x.status)}</td><td class="r">${btn('Editar', 'edit-svc', { id: x.id }, 'small')}</td></tr>`), 'Nenhum contrato recorrente. Lance uma venda com item mensal ou contrate um serviço no cliente.'), btn('+ Contrato', 'new-svc', {}, 'small'))
    + `<div class="grid-2">${panel('Cobranças a gerar (30 dias)', `${table(['Cliente', 'Serviço', 'Vence', ['Valor', 'r']], pending.map(x => `<tr><td>${esc(x.client_nome)}</td><td>${esc(x.descricao)}</td><td>${fdate(x.next_billing_date)}</td><td class="r">${money(x.valor)}</td></tr>`), 'Nada pendente: as cobranças dos próximos 30 dias já estão em Contas a receber.')}`, btn('Gerar agora', 'gen-billing', {}, 'small primary'))}
      ${panel('Histórico de geração', table(['Quando', 'Até', ['Criadas', 'r']], runs.map(r => `<tr><td>${fdt(r.run_at)}</td><td>${fdate(r.until_date)}</td><td class="r">${r.created_count}</td></tr>`), 'Ainda não rodou.'))}</div>`
    + panel('Eventos de MRR', table(['Data', 'Tipo', 'Serviço', ['Antes', 'r'], ['Depois', 'r'], ['Variação', 'r']], events.slice().reverse().slice(0, 30).map(e => `<tr><td>${fdate(e.effective_at)}</td><td>${badge(L.mrr[e.tipo], e.mrr_delta < 0 ? 'bad' : 'good')}</td><td>${esc(e.metadata?.descricao || '')}</td><td class="r">${money(e.previous_mrr)}</td><td class="r">${money(e.new_mrr)}</td><td class="r">${money(e.mrr_delta)}</td></tr>`)));
}, 'mrr');

// ---------------------------------------------------------------- Minhas finanças (pessoal)
const debtFields = [{ name: 'nome', label: 'Nome', required: true, placeholder: 'Ex.: Financiamento do carro', full: true }, { name: 'credor', label: 'Banco / credor' },
  { name: 'valor_parcela', label: 'Valor da parcela (R$)', type: 'money', required: true }, { name: 'total_parcelas', label: 'Total de parcelas', type: 'number', min: 1 },
  { name: 'parcelas_pagas', label: 'Quantas já pagou', type: 'number', min: 0, value: 0 }, { name: 'parcelas_restantes', label: 'Quantas faltam', type: 'number', min: 1, required: true },
  { name: 'proximo_vencimento', label: 'Vencimento da próxima', type: 'date', required: true },
  { name: 'category_id', label: 'Categoria', type: 'select', options: () => catOptions('expense', 'pessoal') }, { name: 'account_id', label: 'Paga pela conta', type: 'select', options: () => acctOptions('pessoal') },
  { name: 'notas', label: 'Notas', type: 'textarea', full: true }];
ACTIONS['new-debt'] = d => openSheet({ title: 'Nova dívida / financiamento', fields: debtFields, values: { account_id: defaultAccount('pessoal'), category_id: d.cat ? REF.categories.find(c => c.nome === d.cat && c.escopo === 'pessoal')?.id : '' },
  html: '<small class="hint">O CRM cria uma conta a pagar para cada parcela que falta. É só dar baixa quando pagar.</small>',
  onMount: body => { const f = () => { const t = num($('#f-total_parcelas', body).value); const p = num($('#f-parcelas_pagas', body).value); if (t && t > p) $('#f-parcelas_restantes', body).value = t - p; }; $('#f-total_parcelas', body).addEventListener('input', f); $('#f-parcelas_pagas', body).addEventListener('input', f); },
  onSubmit: async v => { if (v.total_parcelas && (v.parcelas_pagas || 0) + v.parcelas_restantes > v.total_parcelas) throw Error('Pagas + faltam passa do total.'); await rpc('create_debt', { p: { ...v, escopo: 'pessoal' } }); await saved('Dívida cadastrada com as parcelas.'); } });
ACTIONS['debt-entries'] = async d => { const rows = await db.get('v_entries', `debt_id=eq.${d.id}&order=due_date.asc`); openSheet({ title: 'Parcelas', wide: true, html: entryTable(rows, { client: false }) }); };
ACTIONS['debt-pay-next'] = async d => { const [e] = await db.get('v_entries', `debt_id=eq.${d.id}&${OPEN}&order=due_date.asc&limit=1`); if (!e) throw Error('Nenhuma parcela em aberto.'); await ACTIONS.settle({ id: e.id }); };
ACTIONS['debt-edit'] = async d => { const x = (await db.get('debts', `id=eq.${d.id}`))[0]; openSheet({ title: 'Editar dívida', values: x, fields: [{ name: 'nome', label: 'Nome', required: true }, { name: 'credor', label: 'Credor' }, { name: 'notas', label: 'Notas', type: 'textarea', full: true }], onSubmit: async v => { await db.set('debts', d.id, v); await saved('Atualizado.'); } }); };
ACTIONS['new-recurring'] = () => openSheet({ title: 'Conta fixa mensal', html: '<small class="hint">Ex.: aluguel, internet, faculdade, academia, assinatura. Cria uma conta a pagar por mês.</small>',
  values: { primeiro_vencimento: S.today, meses: 12, account_id: defaultAccount('pessoal'), escopo: 'pessoal' }, fields: [
    { name: 'descricao', label: 'Descrição', required: true }, { name: 'amount', label: 'Valor (R$)', type: 'money', required: true }, { name: 'primeiro_vencimento', label: '1º vencimento', type: 'date', required: true },
    { name: 'meses', label: 'Quantos meses gerar', type: 'number', min: 1, required: true }, { name: 'escopo', label: 'De quem é', type: 'select', required: true, options: [['pessoal', 'Pessoal'], ['empresa', 'GRAVV']] },
    { name: 'category_id', label: 'Categoria', type: 'select', options: () => REF.categories.filter(c => c.tipo === 'expense' && c.ativo).map(c => [c.id, `${c.nome} (${L.escopo[c.escopo]})`]) },
    { name: 'account_id', label: 'Conta', type: 'select', options: () => acctOptions() }],
  onSubmit: async v => { await rpc('create_recurring_expense', { p: { ...v, tipo: 'expense' } }); await saved('Conta fixa criada.'); } });
const goalFields = [{ name: 'nome', label: 'Meta', required: true, full: true, placeholder: 'Ex.: Quitar o carro / Reserva de emergência' }, { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: [['juntar', 'Juntar dinheiro'], ['quitar', 'Quitar dívida'], ['faturar', 'Faturamento'], ['mrr', 'MRR']] },
  { name: 'valor_alvo', label: 'Valor alvo (R$)', type: 'money', required: true }, { name: 'valor_atual', label: 'Já tenho (R$)', type: 'money' }, { name: 'prazo', label: 'Prazo', type: 'date' },
  { name: 'debt_id', label: 'Dívida ligada (para "quitar")', type: 'select', options: () => (window._debts || []).map(x => [x.id, x.nome]) }, { name: 'notas', label: 'Notas', type: 'textarea', full: true }];
ACTIONS['new-goal'] = () => openSheet({ title: 'Nova meta', fields: goalFields, values: { tipo: 'juntar', valor_atual: 0 }, onSubmit: async v => { await db.add('goals', { ...v, escopo: 'pessoal' }); await saved('Meta criada.'); } });
ACTIONS['edit-goal'] = async d => { const g = (await db.get('goals', `id=eq.${d.id}`))[0]; openSheet({ title: 'Editar meta', fields: [...goalFields, { name: 'status', label: 'Status', type: 'select', required: true, options: [['ativa', 'Ativa'], ['concluida', 'Concluída'], ['cancelada', 'Cancelada']] }], values: g, onSubmit: async v => { await db.set('goals', d.id, v); await saved('Meta atualizada.'); } }); };
ACTIONS['goal-add'] = async d => { const g = (await db.get('goals', `id=eq.${d.id}`))[0]; openSheet({ title: `Guardar para: ${g.nome}`, fields: [{ name: 'valor', label: 'Quanto guardou agora (R$)', type: 'money', required: true }], onSubmit: async v => { await db.set('goals', d.id, { valor_atual: round2(num(g.valor_atual) + v.valor) }); await saved('Meta atualizada.'); } }); };
ACTIONS['del-goal'] = d => confirmSheet('Excluir meta', 'Remove essa meta.', async () => { await db.del('goals', d.id); await saved('Meta excluída.'); }, { label: 'Excluir' });

route('/pessoal', 'Minhas finanças', async () => {
  const [debts, goals, { entries, pays, accts, saldo }] = await Promise.all([db.get('v_debts', 'order=status.asc,created_at.asc'), db.get('goals', 'order=status.asc,created_at.asc'), finData('pessoal')]);
  window._debts = debts;
  const open = entries.filter(e => ['pending', 'partial'].includes(e.status)); const me = monthEnd(S.today); const ms = monthStart(S.today);
  const mesOut = open.filter(e => e.tipo === 'expense' && e.due_date <= me); const mesIn = open.filter(e => e.tipo === 'income' && e.due_date <= me);
  const dividaTotal = debts.filter(x => x.status === 'ativa').reduce((a, x) => a + num(x.restante_valor), 0);
  const gastoMes = pays.filter(p => p.tipo === 'expense' && p.paid_at >= ms).reduce((a, p) => a + num(p.amount), 0);
  const goalProgress = g => { if (g.tipo === 'quitar' && g.debt_id) { const x = debts.find(y => y.id === g.debt_id); if (x) return [num(x.total_parcelas) - num(x.parcelas_restantes), num(x.total_parcelas), `${x.parcelas_pagas}/${x.total_parcelas} parcelas · falta ${money(x.restante_valor)}`]; }
    return [num(g.valor_atual), num(g.valor_alvo), `${money(g.valor_atual)} de ${money(g.valor_alvo)}`]; };
  const cats = [...groupSum(entries.filter(e => e.tipo === 'expense' && e.due_date >= ms && e.due_date <= me), e => e.category_nome || 'Sem categoria', e => e.amount)].sort((a, b) => b[1] - a[1]);
  return `<div class="toolbar"><span class="grow"></span>${btn('Lançamento rápido', 'new-personal-quick')}${btn('+ Conta fixa', 'new-recurring')}${btn('+ Entrada prevista', 'new-income-personal')}${btn('+ Dívida / financiamento', 'new-debt', {}, 'primary')}</div>`
    + balanceHint() + kpis([kpi('Saldo pessoal', money(saldo), accts.map(a => `${a.nome}: ${money(a.saldo)}`).join(' · '), saldo < 0 ? 'bad' : ''), kpi('A pagar até o fim do mês', money(mesOut.reduce((a, e) => a + num(e.open_amount), 0)), `${mesOut.filter(e => e.overdue).length} atrasada(s)`, mesOut.some(e => e.overdue) ? 'bad' : ''),
      kpi('Entradas previstas no mês', money(mesIn.reduce((a, e) => a + num(e.open_amount), 0))), kpi('Total que ainda devo', money(dividaTotal), `${debts.filter(x => x.status === 'ativa').length} dívida(s) · gasto no mês ${money(gastoMes)}`)])
    + panel('Dívidas e financiamentos', debts.length ? `<div class="cards-grid">${debts.map(x => { const done = num(x.parcelas_pagas); const tot = num(x.total_parcelas) || done + num(x.parcelas_restantes);
      return `<article class="debt ${x.status}"><header><b>${esc(x.nome)}</b>${x.status === 'quitada' ? badge('Quitada', 'good') : ''}</header><div class="debt-num"><span>Falta</span><strong>${money(x.restante_valor)}</strong></div>
        ${bar(done, tot, 'good')}<small>${done}/${tot} parcelas pagas · ${x.parcelas_restantes} faltando · parcela ${money(x.valor_parcela)}</small>
        <small>${x.proximo_vencimento ? `Próxima: <b>${fdate(x.proximo_vencimento)}</b>` : 'Nenhuma parcela em aberto'}${x.credor ? ' · ' + esc(x.credor) : ''}</small>
        <footer>${x.status === 'ativa' ? btn('Pagar próxima', 'debt-pay-next', { id: x.id }, 'small primary') : ''}${btn('Parcelas', 'debt-entries', { id: x.id }, 'small')}${btn('Editar', 'debt-edit', { id: x.id }, 'small subtle')}</footer></article>`; }).join('')}</div>`
      : empty('Nenhuma dívida cadastrada', 'Cadastre o financiamento do carro e outras parcelas: o CRM mostra quanto falta, quantas parcelas restam e avisa no vencimento.', 'new-debt', '+ Cadastrar o carro'))
    + panel('Metas', goals.length ? `<div class="cards-grid">${goals.map(g => { const [v, t, txt] = goalProgress(g); return `<article class="goal ${g.status}"><header><b>${esc(g.nome)}</b>${g.status !== 'ativa' ? badge(g.status === 'concluida' ? 'Concluída' : 'Cancelada', g.status === 'concluida' ? 'good' : 'mute') : ''}</header>
        <div class="debt-num"><span>${pct(t ? (100 * v) / t : 0)}</span><strong>${esc(txt)}</strong></div>${bar(v, t, 'good')}<small>${g.prazo ? 'Prazo ' + fdate(g.prazo) : 'Sem prazo'}${g.prazo && g.tipo === 'juntar' && t > v ? ` · guardar ${money((t - v) / Math.max(1, Math.ceil((new Date(g.prazo) - new Date(S.today)) / (30.4 * 864e5))))}/mês` : ''}</small>
        <footer>${g.tipo !== 'quitar' && g.status === 'ativa' ? btn('Guardar', 'goal-add', { id: g.id }, 'small primary') : ''}${btn('Editar', 'edit-goal', { id: g.id }, 'small')}${btn('✕', 'del-goal', { id: g.id }, 'small subtle')}</footer></article>`; }).join('')}</div>` : empty('Nenhuma meta', 'Ex.: quitar o carro, reserva de emergência, juntar para um equipamento.', 'new-goal', '+ Criar meta'), goals.length ? btn('+ Meta', 'new-goal', {}, 'small') : '')
    + `<div class="grid-2">${panel('Próximos vencimentos (30 dias)', entryTable(open.filter(e => e.due_date <= addDays(S.today, 30)), { client: false }))}${panel('Gastos do mês por categoria', hbars(cats))}</div>`;
}, 'pessoal');
