'use strict';
/* Dashboard executivo, relatórios gerenciais e configurações. Inicia o app no final. */

route('/', 'Dashboard', async q => {
  const p = Number(q.get('p') || 30); const ms = monthStart(S.today);
  const [sales, [mrr], entries, pays, accts, clients, leads, fus, svcs] = await Promise.all([
    db.get('v_sales', `status=eq.confirmed&data_venda=gte.${ms}`), db.get('v_mrr_summary'), db.get('v_entries', `${OPEN}&order=due_date.asc`),
    db.get('v_payments', `reversed=is.false&escopo=eq.empresa&paid_at=gte.${addDays(S.today, -Math.max(p, 31))}&order=paid_at.desc`), db.get('v_account_balances', 'ativo=is.true&escopo=eq.empresa'),
    db.get('clients', 'select=id,status,joined_at'), db.get('v_leads', 'select=id,estimated_value,is_won,is_lost,stage_id,stage_nome'),
    db.get('v_follow_ups', `status=eq.pending&order=due_at.asc&limit=40`), db.get('v_client_services', `status=eq.active&periodicidade=neq.one_time&next_billing_date=lte.${addDays(S.today, 30)}`)]);
  const emp = entries.filter(e => e.escopo === 'empresa'); const rec = emp.filter(e => e.tipo === 'income'); const pag = emp.filter(e => e.tipo === 'expense');
  const sum = (l, f = 'open_amount') => l.reduce((a, x) => a + num(x[f]), 0);
  const openLeads = leads.filter(l => !l.is_won && !l.is_lost);
  const since = addDays(S.today, -p); const step = p > 90 ? 30 : p > 30 ? 7 : 1; const buckets = []; for (let d = since; d <= S.today; d = addDays(d, step)) buckets.push(d);
  const flow = t => buckets.map((d, i) => pays.filter(x => x.tipo === t && x.paid_at >= d && x.paid_at < (buckets[i + 1] || addDays(S.today, 1))).reduce((a, x) => a + num(x.amount), 0));
  const soon = addDays(S.today, 7);
  const actions = [
    ...fus.filter(f => localDay(f.due_at) <= S.today).map(f => [f.atrasado ? 'bad' : 'warn', `${f.atrasado ? 'Atrasado' : 'Hoje'} · ${f.titulo}`, f.lead_empresa || f.client_nome || '', f.lead_id ? `#/prospeccao/${f.lead_id}` : '#/follow-ups']),
    ...entries.filter(e => e.overdue).map(e => ['bad', `Vencido · ${e.descricao}`, `${L.escopo[e.escopo]} · ${money(e.open_amount)}`, e.escopo === 'pessoal' ? '#/pessoal' : e.tipo === 'income' ? '#/financeiro/receber?st=vencidos' : '#/financeiro/pagar?st=vencidos']),
    ...entries.filter(e => !e.overdue && e.due_date <= soon).map(e => ['', `Vence ${fdate(e.due_date)} · ${e.descricao}`, `${L.escopo[e.escopo]} · ${e.tipo === 'income' ? 'receber' : 'pagar'} ${money(e.open_amount)}`, e.escopo === 'pessoal' ? '#/pessoal' : e.tipo === 'income' ? '#/financeiro/receber' : '#/financeiro/pagar']),
    ...(svcs.length ? [['', `${svcs.length} cobrança(s) recorrente(s) para gerar`, 'MRR · próximos 30 dias', '#/mrr']] : [])];
  const byStage = activeStages().filter(s => !s.is_lost && !s.is_won).map(s => { const l = openLeads.filter(x => x.stage_id === s.id); return [s.nome, sum(l, 'estimated_value'), `${l.length} lead(s)`]; });
  return `<div class="hello"><h2>Olá, ${esc(S.owner)}.</h2><p class="muted">${new Date(S.today + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>`
    + kpis([kpi('Vendas no mês', money(sum(sales, 'total')), `${sales.length} venda(s)`), kpi('MRR atual', money(mrr.mrr), `ARR ${money(mrr.arr)}`), kpi('A receber', money(sum(rec)), `${rec.filter(e => e.overdue).length} vencido(s)`, rec.some(e => e.overdue) ? 'warn' : ''), kpi('A pagar', money(sum(pag)), `${pag.filter(e => e.overdue).length} vencido(s)`)])
    + `<div class="kpis small">${kpi('Saldo disponível', money(sum(accts, 'saldo')))}${kpi('Clientes ativos', clients.filter(c => c.status === 'ativo').length)}${kpi('Novos clientes no mês', clients.filter(c => c.joined_at >= ms).length)}${kpi('Pipeline aberto', money(sum(openLeads, 'estimated_value')), `${openLeads.length} lead(s)`)}</div>`
    + `<div class="grid-2 wide-left">${panel('Fluxo de caixa (realizado)', barChart(buckets.map(d => fdate(d).slice(0, 5)), [{ name: 'Entradas', values: flow('income') }, { name: 'Saídas', values: flow('expense') }]), tabs([['7', '7d'], ['30', '30d'], ['90', '90d'], ['365', 'Ano']], String(p), 'setq', { k: 'p' }))}
      ${panel('Próximas ações', actions.length ? `<ul class="actions-list">${actions.slice(0, 12).map(([t, a, b, h]) => `<li class="${t}"><a href="${esc(h)}"><b>${esc(a)}</b><small>${esc(b)}</small></a></li>`).join('')}</ul>` : '<p class="muted pad">Nada urgente. Bom momento para prospectar. 🚀</p>', `<span class="count">${actions.length}</span>`)}</div>`
    + `<div class="grid-3">${panel('Pipeline', hbars(byStage), link('#/prospeccao', 'Abrir'))}${panel('MRR', `<div class="mini-mrr"><strong>${money(mrr.mrr)}</strong><span>${mrr.clientes_recorrentes} cliente(s) recorrente(s) · ticket ${money(mrr.ticket_medio)}</span>${num(REF.settings.metas?.mrr_meta) ? bar(num(mrr.mrr), num(REF.settings.metas.mrr_meta), 'good') + `<small>Meta ${money(REF.settings.metas.mrr_meta)}</small>` : ''}</div>`, link('#/mrr', 'Detalhes'))}
      ${panel('Últimas movimentações', table(['Data', 'Descrição', ['Valor', 'r']], pays.slice(0, 7).map(x => `<tr><td>${fdate(x.paid_at)}</td><td>${esc(x.descricao)}<small>${esc(x.client_nome || x.category_nome || '')}</small></td><td class="r ${x.tipo === 'expense' ? 'bad-text' : 'good-text'}">${x.tipo === 'expense' ? '−' : '+'}${money(x.amount)}</td></tr>`), 'Nenhuma movimentação ainda.'))}</div>`;
}, 'dashboard');

// ---------------------------------------------------------------- Relatórios
function periodRange(q) {
  const t = S.today; const per = q.get('per') || 'mes';
  const r = { mes: [monthStart(t), t], anterior: [addMonths(monthStart(t), -1), addDays(monthStart(t), -1)], '3m': [addMonths(monthStart(t), -2), t], '6m': [addMonths(monthStart(t), -5), t],
    ano: [t.slice(0, 4) + '-01-01', t], ano_ant: [(Number(t.slice(0, 4)) - 1) + '-01-01', (Number(t.slice(0, 4)) - 1) + '-12-31'], custom: [q.get('de') || monthStart(t), q.get('ate') || t] }[per];
  return { per, a: r[0], b: r[1] };
}
const monthsIn = (a, b) => { const out = []; for (let m = monthStart(a); m <= b; m = addMonths(m, 1)) out.push(m); return out; };
let REPORT_CSV = null;
route('/relatorios', 'Relatórios', async q => {
  const tab = q.get('tab') || 'geral'; const { per, a, b } = periodRange(q); const inP = d => d && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
  const [sales, pays, entries, leads, clients, [mrr], events, items, svcs, acts] = await Promise.all([db.get('v_sales', 'status=eq.confirmed'), db.get('v_payments', 'reversed=is.false&escopo=eq.empresa'),
    db.get('v_entries', 'status=neq.cancelled&escopo=eq.empresa'), db.get('v_leads'), db.get('v_clients'), db.get('v_mrr_summary'), db.get('mrr_events', 'order=effective_at.asc'),
    db.get('sale_items'), db.get('v_client_services', 'status=eq.active&periodicidade=neq.one_time'), db.get('lead_activities', 'tipo=eq.perdido')]);
  const S2 = sales.filter(s => inP(s.data_venda)); const P = pays.filter(x => inP(x.paid_at)); const sum = (l, f) => l.reduce((s, x) => s + num(x[f]), 0);
  const recebido = sum(P.filter(x => x.tipo === 'income'), 'amount'); const pago = sum(P.filter(x => x.tipo === 'expense'), 'amount');
  const won = leads.filter(l => l.is_won && inP(localDay(l.won_at))); const lost = leads.filter(l => l.is_lost && inP(localDay(l.lost_at)));
  const conv = won.length + lost.length ? (100 * won.length) / (won.length + lost.length) : 0;
  const months = monthsIn(a, b); const perMonth = (list, dateF, valF) => months.map(m => list.filter(x => (dateF(x) || '').slice(0, 7) === m.slice(0, 7)).reduce((s, x) => s + num(valF(x)), 0));
  const head = `<div class="toolbar">${tabs([['mes', 'Este mês'], ['anterior', 'Mês anterior'], ['3m', '3 meses'], ['6m', '6 meses'], ['ano', 'Ano'], ['ano_ant', 'Ano anterior'], ['custom', 'Personalizado']], per, 'setq', { k: 'per' })}
    ${per === 'custom' ? `<input type="date" data-q="de" value="${a}" aria-label="De"><input type="date" data-q="ate" value="${b}" aria-label="Até">` : `<span class="muted">${fdate(a)} – ${fdate(b)}</span>`}<span class="grow"></span>${btn('Exportar CSV', 'report-csv')}</div>
    ${tabs([['geral', 'Visão geral'], ['comercial', 'Comercial'], ['vendas', 'Vendas'], ['clientes', 'Clientes'], ['financeiro', 'Financeiro'], ['mrr', 'MRR']], tab, 'setq', { k: 'tab' })}`;
  let html = '';
  if (tab === 'geral') {
    REPORT_CSV = ['visao-geral', ['Mês', 'Vendas', 'Recebido', 'Pago'], months.map((m, i) => [monthLabel(m), csvMoney(perMonth(sales, s => s.data_venda, s => s.total)[i]), csvMoney(perMonth(P.filter(x => x.tipo === 'income'), x => x.paid_at, x => x.amount)[i]), csvMoney(perMonth(P.filter(x => x.tipo === 'expense'), x => x.paid_at, x => x.amount)[i])])];
    html = kpis([kpi('Vendas', money(sum(S2, 'total')), `${S2.length} venda(s)`), kpi('Recebido', money(recebido)), kpi('Resultado de caixa', money(recebido - pago), '', recebido - pago < 0 ? 'bad' : 'good'), kpi('MRR atual', money(mrr.mrr))])
      + `<div class="kpis small">${kpi('Clientes novos', clients.filter(c => inP(c.joined_at)).length)}${kpi('Conversão', pct(conv), `${won.length} ganho(s) · ${lost.length} perdido(s)`)}${kpi('Pago', money(pago))}${kpi('Novo MRR vendido', money(sum(S2, 'mrr_novo')))}</div>`
      + panel('Vendas × recebido', barChart(months.map(monthLabel), [{ name: 'Vendas', values: perMonth(sales, s => s.data_venda, s => s.total) }, { name: 'Recebido', values: perMonth(P.filter(x => x.tipo === 'income'), x => x.paid_at, x => x.amount) }]));
  } else if (tab === 'comercial') {
    const novos = leads.filter(l => inP(localDay(l.created_at))); const open = leads.filter(l => !l.is_won && !l.is_lost);
    const closeDays = won.map(l => (new Date(l.won_at) - new Date(l.created_at)) / 864e5); const reasons = [...groupSum(lost, l => l.lost_reason || 'Sem motivo', () => 1)];
    REPORT_CSV = ['comercial', ['Lead', 'Etapa', 'Origem', 'Valor', 'Criado', 'Ganho', 'Perdido', 'Motivo'], leads.filter(l => inP(localDay(l.created_at)) || won.includes(l) || lost.includes(l)).map(l => [l.empresa, l.stage_nome, l.origem, csvMoney(l.estimated_value), fdate(localDay(l.created_at)), fdate(localDay(l.won_at)), fdate(localDay(l.lost_at)), l.lost_reason])];
    html = kpis([kpi('Leads novos', novos.length), kpi('Ganhos', won.length, money(sum(won, 'estimated_value'))), kpi('Perdidos', lost.length), kpi('Conversão', pct(conv))])
      + `<div class="kpis small">${kpi('Pipeline aberto', money(sum(open, 'estimated_value')))}${kpi('Ticket potencial', money(open.length ? sum(open, 'estimated_value') / open.length : 0))}${kpi('Tempo médio p/ fechar', closeDays.length ? Math.round(closeDays.reduce((s, x) => s + x, 0) / closeDays.length) + ' dias' : '—')}${kpi('Motivos de perda', reasons.length)}</div>`
      + `<div class="grid-2">${panel('Funil por etapa (hoje)', hbars(activeStages().map(s => [s.nome, leads.filter(l => l.stage_id === s.id).length]), v => String(v)))}${panel('Origem dos leads (período)', hbars([...groupSum(novos, l => l.origem || 'Sem origem', () => 1)], v => String(v)))}</div>`
      + `<div class="grid-2">${panel('Vendas por origem', hbars([...groupSum(S2, s => s.origem || 'Sem origem', s => s.total)]))}${panel('Motivos de perda', hbars(reasons, v => String(v)))}</div>`;
  } else if (tab === 'vendas') {
    const ids = new Set(S2.map(s => s.id)); const its = items.filter(i => ids.has(i.sale_id));
    REPORT_CSV = ['vendas', ['Venda', 'Cliente', 'Data', 'Total', 'Novo MRR', 'Origem'], S2.map(s => [s.numero, s.client_nome, fdate(s.data_venda), csvMoney(s.total), csvMoney(s.mrr_novo), s.origem])];
    html = kpis([kpi('Valor vendido', money(sum(S2, 'total'))), kpi('Quantidade', S2.length), kpi('Ticket médio', money(S2.length ? sum(S2, 'total') / S2.length : 0)), kpi('Novo MRR', money(sum(S2, 'mrr_novo')))])
      + panel('Vendas por mês', barChart(months.map(monthLabel), [{ name: 'Vendas', values: perMonth(sales, s => s.data_venda, s => s.total) }]))
      + `<div class="grid-2">${panel('Serviços vendidos', hbars([...groupSum(its, i => i.descricao, i => i.total)].sort((x, y) => y[1] - x[1]).slice(0, 10)))}${panel('Top clientes', hbars([...groupSum(S2, s => s.client_nome, s => s.total)].sort((x, y) => y[1] - x[1]).slice(0, 10)))}</div>`;
  } else if (tab === 'clientes') {
    const fat = [...groupSum(P.filter(x => x.tipo === 'income' && x.client_nome), x => x.client_nome, x => x.amount)].sort((x, y) => y[1] - x[1]);
    const inad = clients.filter(c => num(c.vencido) > 0);
    REPORT_CSV = ['clientes', ['Cliente', 'Status', 'Origem', 'MRR', 'A receber', 'Vencido'], clients.map(c => [c.nome, L.client[c.status], c.origem, csvMoney(c.mrr), csvMoney(c.a_receber), csvMoney(c.vencido)])];
    html = kpis([kpi('Ativos', clients.filter(c => c.status === 'ativo').length), kpi('Novos no período', clients.filter(c => inP(c.joined_at)).length), kpi('Pausados', clients.filter(c => c.status === 'pausado').length), kpi('Recorrentes', clients.filter(c => num(c.mrr) > 0).length)])
      + `<div class="grid-2">${panel('Top faturamento (recebido no período)', hbars(fat.slice(0, 10)))}${panel('Origem dos clientes', hbars([...groupSum(clients, c => c.origem || 'Sem origem', () => 1)], v => String(v)))}</div>`
      + panel('Inadimplentes', table(['Cliente', ['Vencido', 'r'], ['A receber', 'r']], inad.map(c => `<tr><td>${link('#/clientes/' + c.id, c.nome)}</td><td class="r bad-text">${money(c.vencido)}</td><td class="r">${money(c.a_receber)}</td></tr>`), 'Ninguém em atraso. 👏'));
  } else if (tab === 'financeiro') {
    const open = entries.filter(e => ['pending', 'partial'].includes(e.status)); const n30 = open.filter(e => e.due_date <= addDays(S.today, 30));
    const cats = [...groupSum(entries.filter(e => e.tipo === 'expense' && inP(e.due_date)), e => e.category_nome || 'Sem categoria', e => e.amount)].sort((x, y) => y[1] - x[1]);
    REPORT_CSV = ['financeiro', ['Data', 'Tipo', 'Descrição', 'Cliente', 'Categoria', 'Valor'], P.map(x => [fdate(x.paid_at), L.tipo[x.tipo], x.descricao, x.client_nome, x.category_nome, csvMoney(x.amount)])];
    html = kpis([kpi('Recebido', money(recebido)), kpi('Pago', money(pago)), kpi('Resultado de caixa', money(recebido - pago), '', recebido - pago < 0 ? 'bad' : 'good'), kpi('Vencido', money(sum(open.filter(e => e.overdue), 'open_amount')), '', 'bad')])
      + `<div class="kpis small">${kpi('A receber', money(sum(open.filter(e => e.tipo === 'income'), 'open_amount')))}${kpi('A pagar', money(sum(open.filter(e => e.tipo === 'expense'), 'open_amount')))}${kpi('Entra em 30 dias', money(sum(n30.filter(e => e.tipo === 'income'), 'open_amount')))}${kpi('Sai em 30 dias', money(sum(n30.filter(e => e.tipo === 'expense'), 'open_amount')))}</div>`
      + `<div class="grid-2">${panel('Despesas por categoria', hbars(cats))}${panel('Atraso (a receber)', hbars(AGING.map(([k, t]) => [t, sum(open.filter(e => e.tipo === 'income' && e.aging === k), 'open_amount')])))}</div>`;
  } else {
    const ev = events.filter(e => inP(e.effective_at)); const s = k => sum(ev.filter(e => e.tipo === k), 'mrr_delta'); const start = sum(events.filter(e => e.effective_at < a), 'mrr_delta');
    const mh = [...new Set(events.map(e => e.effective_at.slice(0, 7)))].sort(); let acc = 0; const hist = mh.map(m => (acc += sum(events.filter(e => e.effective_at.slice(0, 7) === m), 'mrr_delta')));
    const byC = [...groupSum(svcs, x => x.client_nome, x => x.mrr)].sort((x, y) => y[1] - x[1]);
    REPORT_CSV = ['mrr', ['Data', 'Tipo', 'Serviço', 'Antes', 'Depois', 'Variação'], ev.map(e => [fdate(e.effective_at), L.mrr[e.tipo], e.metadata?.descricao, csvMoney(e.previous_mrr), csvMoney(e.new_mrr), csvMoney(e.mrr_delta)])];
    html = kpis([kpi('MRR', money(mrr.mrr)), kpi('ARR', money(mrr.arr)), kpi('Net New MRR', money(sum(ev, 'mrr_delta'))), kpi('Churn', money(s('churn')), start ? `taxa ${pct((100 * -s('churn')) / start)}` : '', s('churn') < 0 ? 'bad' : '')])
      + `<div class="grid-2">${panel('Histórico', lineChart(mh.map(m => monthLabel(m + '-01')), hist))}${panel('Concentração por cliente', hbars(byC), num(mrr.mrr) && byC[0] ? `<small>${pct((100 * byC[0][1]) / num(mrr.mrr))} no maior</small>` : '')}</div>`;
  }
  return head + html;
}, 'relatorios');
ACTIONS['report-csv'] = () => { if (!REPORT_CSV) throw Error('Nada para exportar.'); const [n, h, r] = REPORT_CSV; downloadCSV('relatorio-' + n, h, r); };

// ---------------------------------------------------------------- Configurações
route('/configuracoes', 'Configurações', async q => {
  const tab = q.get('tab') || 'agencia';
  const head = tabs([['agencia', 'Agência'], ['metas', 'Metas'], ['pipeline', 'Pipeline'], ['financeiro', 'Financeiro'], ['servicos', 'Serviços'], ['equipe', 'Equipe'], ['perfil', 'Perfil'], ['backup', 'Backup']], tab, 'setq', { k: 'tab' });
  const ag = REF.settings.agencia || {}; const mt = REF.settings.metas || {};
  let body = '';
  if (tab === 'agencia') body = panel('Agência', `<dl class="dl"><dt>Nome</dt><dd>${esc(ag.nome || 'GRAVV')}</dd><dt>Moeda</dt><dd>${esc(ag.moeda || 'BRL')}</dd><dt>Idioma</dt><dd>${esc(ag.locale || 'pt-BR')}</dd><dt>Fuso</dt><dd>${esc(ag.timezone || 'America/Sao_Paulo')}</dd></dl>`, btn('Editar', 'cfg-agencia', {}, 'small'));
  else if (tab === 'metas') body = panel('Metas da GRAVV', `<dl class="dl"><dt>Meta de MRR</dt><dd>${money(mt.mrr_meta)}</dd><dt>Meta de faturamento mensal</dt><dd>${money(mt.faturamento_meta)}</dd></dl><p class="muted pad">A meta de MRR aparece no Dashboard e na tela de MRR com a barra de progresso.</p>`, btn('Editar', 'cfg-metas', {}, 'small'));
  else if (tab === 'pipeline') {
    const counts = await db.get('leads', 'select=stage_id');
    body = panel('Etapas do funil', table(['Ordem', 'Etapa', 'Tipo', ['Leads', 'r'], 'Status', ''], REF.stages.map((s, i) => `<tr class="${s.ativo ? '' : 'muted'}"><td>${i + 1}</td><td><span class="dot" style="background:${esc(s.cor || '#999')}"></span> <b>${esc(s.nome)}</b></td><td>${s.is_won ? badge('Ganho', 'good') : s.is_lost ? badge('Perdido', 'mute') : 'Aberta'}</td>
      <td class="r">${counts.filter(c => c.stage_id === s.id).length}</td><td>${s.ativo ? 'Ativa' : 'Desativada'}</td><td class="r nowrap">${i ? btn('↑', 'stage-move', { id: s.id, dir: -1 }, 'small subtle') : ''}${i < REF.stages.length - 1 ? btn('↓', 'stage-move', { id: s.id, dir: 1 }, 'small subtle') : ''}${btn('Editar', 'stage-edit', { id: s.id }, 'small')}${!s.is_won && !s.is_lost ? btn(s.ativo ? 'Desativar' : 'Ativar', 'stage-toggle', { id: s.id }, 'small subtle') : ''}</td></tr>`)), btn('+ Etapa', 'stage-new', {}, 'small primary'))
      + '<p class="muted pad">As etapas Ganho e Perdido são fixas: é por elas que o CRM sabe quando um lead virou venda ou foi perdido.</p>';
  } else if (tab === 'financeiro') {
    body = panel('Contas', table(['Conta', 'Tipo', 'De quem', ['Saldo inicial', 'r'], ['Saldo atual', 'r'], ''], REF.accounts.map(a => `<tr class="${a.ativo ? '' : 'muted'}"><td><b>${esc(a.nome)}</b></td><td>${esc(L.acct[a.tipo])}</td><td>${esc(L.escopo[a.escopo])}</td><td class="r">${money(a.opening_balance)}</td><td class="r">${money(a.saldo)}</td><td class="r">${btn('Editar', 'acct-edit', { id: a.id }, 'small')}</td></tr>`)), btn('+ Conta', 'acct-new', {}, 'small primary'))
      + panel('Categorias', table(['Categoria', 'Tipo', 'De quem', 'Status', ''], REF.categories.map(c => `<tr class="${c.ativo ? '' : 'muted'}"><td>${esc(c.nome)}</td><td>${esc(L.tipo[c.tipo])}</td><td>${esc(L.escopo[c.escopo])}</td><td>${c.ativo ? 'Ativa' : 'Desativada'}</td><td class="r">${btn(c.ativo ? 'Desativar' : 'Ativar', 'cat-toggle', { id: c.id }, 'small subtle')}</td></tr>`)), btn('+ Categoria', 'cat-new', {}, 'small primary'));
  } else if (tab === 'servicos') { location.hash = '#/servicos?tab=catalogo'; return ''; }
  else if (tab === 'equipe') body = panel('Quem acessa', table(['E-mail', 'Papel'], S.owners.map(o => `<tr><td>${esc(o)}</td><td>${badge('Admin', 'good')}</td></tr>`)) + '<p class="muted pad">Só entra quem estiver na variável OWNER_EMAILS da Vercel e tiver login no Supabase. Para colocar alguém da equipe, adicione o e-mail lá.</p>');
  else if (tab === 'perfil') body = panel('Perfil', `<dl class="dl"><dt>Nome</dt><dd>${esc(S.owner)}</dd><dt>E-mail</dt><dd>${esc(S.email)}</dd><dt>Papel</dt><dd>Admin</dd></dl>`);
  else body = panel('Backup', `<p class="pad">Baixa um arquivo com todos os dados do CRM (clientes, vendas, financeiro, projetos…). Guarde num lugar seguro de vez em quando.</p><p class="pad"><a class="btn primary" href="/api/backup" download>Baixar backup agora</a></p>`);
  return head + body;
}, 'configuracoes');
async function saveSetting(key, value) { await db.add('settings', { key, value }); }
ACTIONS['cfg-agencia'] = () => { const ag = REF.settings.agencia || {}; openSheet({ title: 'Agência', values: ag, fields: [{ name: 'nome', label: 'Nome', required: true }, { name: 'moeda', label: 'Moeda', value: 'BRL', readonly: true }, { name: 'locale', label: 'Idioma', value: 'pt-BR', readonly: true }, { name: 'timezone', label: 'Fuso', value: 'America/Sao_Paulo', readonly: true }], onSubmit: async v => { await saveSetting('agencia', { ...ag, ...v }); await saved('Salvo.'); } }); };
ACTIONS['cfg-metas'] = () => { const mt = REF.settings.metas || {}; openSheet({ title: 'Metas', values: mt, fields: [{ name: 'mrr_meta', label: 'Meta de MRR (R$/mês)', type: 'money' }, { name: 'faturamento_meta', label: 'Meta de faturamento mensal (R$)', type: 'money' }], onSubmit: async v => { await saveSetting('metas', v); await saved('Metas salvas.'); } }); };
const stageFields = [{ name: 'nome', label: 'Nome', required: true }, { name: 'cor', label: 'Cor', type: 'color' }];
ACTIONS['stage-new'] = () => openSheet({ title: 'Nova etapa', fields: stageFields, values: { cor: '#6b7f99' }, onSubmit: async v => {
  const pos = Math.min(...REF.stages.filter(s => s.is_won || s.is_lost).map(s => s.posicao));
  for (const s of REF.stages.filter(s => s.posicao >= pos)) await db.set('pipeline_stages', s.id, { posicao: s.posicao + 1 });
  await db.add('pipeline_stages', { ...v, posicao: pos }); await saved('Etapa criada.'); } });
ACTIONS['stage-edit'] = d => openSheet({ title: 'Editar etapa', fields: stageFields, values: REF.stages.find(s => s.id === d.id), onSubmit: async v => { await db.set('pipeline_stages', d.id, v); await saved('Etapa salva.'); } });
ACTIONS['stage-toggle'] = async d => { const s = REF.stages.find(x => x.id === d.id); if (s.ativo && (await db.get('leads', `select=id&stage_id=eq.${d.id}&limit=1`)).length) throw Error('Tem leads nessa etapa. Mova-os antes de desativar.'); await db.set('pipeline_stages', d.id, { ativo: !s.ativo }); await saved('Etapa atualizada.'); };
ACTIONS['stage-move'] = async d => { const list = REF.stages.slice(); const i = list.findIndex(s => s.id === d.id); const j = i + Number(d.dir); if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; await Promise.all(list.map((s, k) => (s.posicao !== k + 1 ? db.set('pipeline_stages', s.id, { posicao: k + 1 }) : null))); await saved('Ordem salva.'); };
const acctFields = [{ name: 'nome', label: 'Nome', required: true }, { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: opts(L.acct) }, { name: 'escopo', label: 'De quem', type: 'select', required: true, options: [['empresa', 'GRAVV'], ['pessoal', 'Pessoal']] },
  { name: 'opening_balance', label: 'Saldo inicial (R$)', type: 'money', hint: 'Quanto tinha na conta quando começou a usar o CRM. Não mude depois de ter movimentos.' }, { name: 'ativo', label: 'Ativa', type: 'checkbox' }];
ACTIONS['acct-new'] = () => openSheet({ title: 'Nova conta', fields: acctFields, values: { tipo: 'banco', escopo: 'pessoal', opening_balance: 0, ativo: true }, onSubmit: async v => { await db.add('financial_accounts', { ...v, opening_balance: v.opening_balance || 0 }); await saved('Conta criada.'); } });
ACTIONS['acct-edit'] = d => openSheet({ title: 'Editar conta', fields: acctFields, values: REF.accounts.find(a => a.id === d.id), onSubmit: async v => { await db.set('financial_accounts', d.id, { ...v, opening_balance: v.opening_balance || 0 }); await saved('Conta salva.'); } });
ACTIONS['cat-new'] = () => openSheet({ title: 'Nova categoria', fields: [{ name: 'nome', label: 'Nome', required: true }, { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: opts(L.tipo) }, { name: 'escopo', label: 'De quem', type: 'select', required: true, options: [['empresa', 'GRAVV'], ['pessoal', 'Pessoal']] }], values: { tipo: 'expense', escopo: 'pessoal' }, onSubmit: async v => { await db.add('financial_categories', v); await saved('Categoria criada.'); } });
ACTIONS['cat-toggle'] = async d => { const c = REF.categories.find(x => x.id === d.id); await db.set('financial_categories', d.id, { ativo: !c.ativo }); await saved('Categoria atualizada.'); };

boot();
