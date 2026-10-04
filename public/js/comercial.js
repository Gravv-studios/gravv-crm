'use strict';
/* Comercial: prospecção (funil), follow-ups, vendas, leads do site e conversas do WhatsApp. */
const ORIGENS = ['Indicação', 'Instagram', 'WhatsApp', 'Site', 'Google', 'Anúncio', 'Prospecção ativa', 'Cliente antigo', 'Outro'].map(o => [o, o]);
const activeStages = () => REF.stages.filter(s => s.ativo);
const stageById = id => REF.stages.find(s => s.id === id) || {};
const waLink = phone => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length <= 11 ? '55' + d : d}` : ''; };
const fuWhen = ts => { if (!ts) return ''; const day = localDay(ts); return day < S.today ? badge('Atrasado ' + fdate(day), 'bad') : day === S.today ? badge('Hoje', 'warn') : badge(fdate(day)); };

// ---------------------------------------------------------------- Lead (formulário único)
const leadFields = (isNew) => [
  { name: 'empresa', label: 'Empresa / nome', required: true, full: true },
  { name: 'contato', label: 'Pessoa de contato' }, { name: 'whatsapp', label: 'WhatsApp', type: 'tel', placeholder: '(61) 99999-9999' },
  { name: 'email', label: 'E-mail', type: 'email' }, { name: 'cidade', label: 'Cidade' },
  { name: 'origem', label: 'Origem', type: 'select', options: ORIGENS }, { name: 'segmento', label: 'Segmento' },
  { name: 'servico_interesse', label: 'Serviço de interesse', full: true },
  ...(isNew ? [{ name: 'stage_id', label: 'Etapa', type: 'select', required: true, options: () => activeStages().filter(s => !s.is_lost).map(s => [s.id, s.nome]) }] : []),
  { name: 'estimated_value', label: 'Valor estimado (R$)', type: 'money' }, { name: 'responsavel', label: 'Responsável', value: S.owner },
  { name: 'client_id', label: 'Já é cliente?', type: 'select', options: clientOptions, placeholder: 'Não' },
  { name: 'notas', label: 'Notas', type: 'textarea', full: true },
];
function openLeadForm(lead) {
  openSheet({ title: lead ? 'Editar lead' : 'Novo lead', fields: leadFields(!lead), values: lead || { stage_id: activeStages()[0]?.id, responsavel: S.owner },
    onSubmit: async v => { if (lead) await db.set('leads', lead.id, v); else { const r = await db.add('leads', v); location.hash = `#/prospeccao/${r.id}`; } await saved(lead ? 'Lead atualizado.' : 'Lead criado.'); } });
}
ACTIONS['new-lead'] = () => openLeadForm();
ACTIONS['edit-lead'] = async d => openLeadForm((await db.get('leads', `id=eq.${d.id}`))[0]);
ACTIONS['del-lead'] = d => confirmSheet('Excluir lead', 'Apaga o lead, o histórico e os follow-ups dele. Não dá pra desfazer.', async () => { await db.del('leads', d.id); location.hash = '#/prospeccao'; await saved('Lead excluído.'); }, { label: 'Excluir' });

async function moveLead(leadId, stageId) {
  const st = stageById(stageId);
  if (st.is_lost) {
    return confirmSheet('Marcar como perdido', 'Por que esse lead foi perdido? Isso alimenta o relatório de motivos de perda.', async v => {
      await rpc('move_lead', { p_lead: leadId, p_stage: stageId, p_reason: v.motivo }); await saved('Lead marcado como perdido.');
    }, { label: 'Marcar perdido', reason: 'Motivo da perda' });
  }
  await rpc('move_lead', { p_lead: leadId, p_stage: stageId });
  if (st.is_won) {
    toast('Lead ganho!'); await render();
    confirmSheet('Lead ganho 🎉', 'Quer lançar a venda agora? O cliente, as parcelas e o MRR já nascem daqui.', async () => { closeSheet(); await openSaleWizard({ leadId }); }, { label: 'Lançar venda', danger: false });
  }
}
ACTIONS['lead-stage'] = async d => { await moveLead(d.id, d.v); if (!stageById(d.v).is_lost && !stageById(d.v).is_won) await saved('Etapa atualizada.'); };
ACTIONS['lead-activity'] = d => openSheet({ title: 'Registrar atividade', fields: [
  { name: 'tipo', label: 'Tipo', type: 'select', required: true, value: 'nota', options: [['nota', 'Nota'], ['ligacao', 'Ligação'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail'], ['reuniao', 'Reunião']] },
  { name: 'descricao', label: 'O que aconteceu', type: 'textarea', required: true, full: true }],
  onSubmit: async v => { await db.add('lead_activities', { ...v, lead_id: d.id }); await saved('Atividade registrada.'); } });

// ---------------------------------------------------------------- Prospecção
route('/prospeccao', 'Prospecção', async q => {
  const view = q.get('view') || 'kanban'; const origem = q.get('origem') || ''; const busca = (q.get('q') || '').toLowerCase();
  const [leads, fus, site] = await Promise.all([db.get('v_leads', 'order=posicao.asc,updated_at.desc'),
    db.get('v_follow_ups', 'select=id,hoje&status=eq.pending'), db.get('crm_leads', 'select=id&status=eq.novo')]);
  const open = leads.filter(l => !l.is_won && !l.is_lost);
  const ms = monthStart(S.today); const won = leads.filter(l => l.is_won && localDay(l.won_at) >= ms);
  const shown = leads.filter(l => (!origem || l.origem === origem) && (!busca || `${l.empresa} ${l.contato} ${l.segmento} ${l.servico_interesse}`.toLowerCase().includes(busca)));
  const card = l => `<a class="card" href="#/prospeccao/${l.id}" draggable="true" data-drag="${l.id}"><strong>${esc(l.empresa)}</strong>
    <small>${esc([l.contato, l.servico_interesse].filter(Boolean).join(' · '))}</small><div class="card-foot"><b>${l.estimated_value ? money(l.estimated_value) : ''}</b>${l.converted_sale_id ? badge('Venda', 'good') : fuWhen(l.next_follow_up_at)}</div></a>`;
  const board = `<div class="kanban" id="board">${activeStages().map(s => { const items = shown.filter(l => l.stage_id === s.id);
    return `<section class="col" data-drop="${s.id}"><header><span class="dot" style="background:${esc(s.cor || '#999')}"></span>${esc(s.nome)}<small>${items.length} · ${money(items.reduce((a, l) => a + num(l.estimated_value), 0))}</small></header><div class="col-body">${items.map(card).join('')}</div></section>`; }).join('')}</div>`;
  const list = panel('Leads', table(['Empresa', 'Etapa', ['Valor', 'r'], 'Origem', 'Próximo follow-up', 'Atualizado'], shown.map(l =>
    `<tr><td><a href="#/prospeccao/${l.id}"><b>${esc(l.empresa)}</b></a><small>${esc(l.contato || '')}</small></td><td>${badge(l.stage_nome, l.is_won ? 'good' : l.is_lost ? 'mute' : '')}</td><td class="r">${money(l.estimated_value)}</td><td>${esc(l.origem || '—')}</td><td>${fuWhen(l.next_follow_up_at) || '—'}</td><td>${fdate(localDay(l.updated_at))}</td></tr>`), 'Nenhum lead encontrado.'));
  return { html: kpis([kpi('Leads ativos', open.length), kpi('Valor em pipeline', money(open.reduce((a, l) => a + num(l.estimated_value), 0))),
      kpi('Follow-ups hoje', fus.filter(f => f.hoje).length), kpi('Ganhos no mês', won.length, money(won.reduce((a, l) => a + num(l.estimated_value), 0)))])
    + `<div class="toolbar">${tabs([['kanban', 'Pipeline'], ['lista', 'Lista']], view, 'setq', { k: 'view' })}<input type="search" id="lead-q" placeholder="Buscar lead…" value="${esc(q.get('q') || '')}">
      <select id="lead-origem" aria-label="Origem"><option value="">Todas as origens</option>${ORIGENS.map(([k]) => `<option ${k === origem ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <span class="grow"></span>${site.length ? `<a class="btn" href="#/leads-site">${site.length} novo(s) do site</a>` : ''}${btn('+ Novo lead', 'new-lead', {}, 'primary')}</div>`
    + (view === 'lista' ? list : board),
    after: root => {
      const b = $('#board', root); if (b) enableDnD(b, (id, stage) => moveLead(id, stage));
      let t; $('#lead-q', root).addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => setQuery({ q: e.target.value }), 350); });
      $('#lead-origem', root).addEventListener('change', e => setQuery({ origem: e.target.value }));
    } };
}, 'prospeccao');

route('/prospeccao/:id', 'Lead', async (q, id) => {
  const [[l], acts, fus] = await Promise.all([db.get('v_leads', `id=eq.${id}`), db.get('lead_activities', `lead_id=eq.${id}&order=created_at.desc`),
    db.get('v_follow_ups', `lead_id=eq.${id}&order=due_at.asc`)]);
  if (!l) return empty('Lead não encontrado.');
  const wa = waLink(l.whatsapp);
  const stageSel = `<select id="stage-sel" aria-label="Etapa" ${l.converted_sale_id ? 'disabled' : ''}>${activeStages().map(s => `<option value="${s.id}" ${s.id === l.stage_id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select>`;
  const acts2 = [btn('Editar', 'edit-lead', { id }), btn('Agendar follow-up', 'new-followup', { lead: id }), btn('Registrar atividade', 'lead-activity', { id })];
  if (l.converted_sale_id) acts2.push(`<a class="btn primary" href="#/vendas/${l.converted_sale_id}">Ver venda</a>`);
  else if (l.is_won) acts2.push(btn('Converter em venda', 'convert-lead', { id }, 'primary'));
  else acts2.push(btn('Marcar ganho', 'lead-stage', { id, v: REF.stages.find(s => s.is_won && s.ativo)?.id || '' }, 'primary'), btn('Marcar perdido', 'lead-stage', { id, v: REF.stages.find(s => s.is_lost && s.ativo)?.id || '' }));
  acts2.push(btn('Excluir', 'del-lead', { id }, 'subtle'));
  return { title: l.empresa, html: `<div class="page-head"><div><a href="#/prospeccao" class="back">← Prospecção</a><h2>${esc(l.empresa)}</h2><p class="muted">${esc([l.segmento, l.cidade, l.origem].filter(Boolean).join(' · '))}</p></div><div class="actions">${acts2.join('')}</div></div>
    <div class="grid-2"><div>${panel('Dados comerciais', `<dl class="dl">
      <dt>Etapa</dt><dd>${stageSel}${l.is_lost && l.lost_reason ? `<small>Motivo: ${esc(l.lost_reason)}</small>` : ''}</dd>
      <dt>Valor estimado</dt><dd>${money(l.estimated_value)}</dd><dt>Contato</dt><dd>${esc(l.contato || '—')}</dd>
      <dt>WhatsApp</dt><dd>${wa ? `<a href="${wa}" target="_blank" rel="noopener">${esc(l.whatsapp)}</a>` : esc(l.whatsapp || '—')}</dd>
      <dt>E-mail</dt><dd>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—'}</dd><dt>Interesse</dt><dd>${esc(l.servico_interesse || '—')}</dd>
      <dt>Responsável</dt><dd>${esc(l.responsavel)}</dd><dt>Cliente</dt><dd>${l.client_id ? link('#/clientes/' + l.client_id, l.client_nome) : '—'}</dd>
      <dt>Criado</dt><dd>${fdate(localDay(l.created_at))}</dd></dl>${l.notas ? `<p class="note">${esc(l.notas)}</p>` : ''}`)}
      ${panel('Follow-ups', table(['Quando', 'O quê', 'Status', ''], fus.map(f => `<tr><td>${fdt(f.due_at)} ${f.atrasado ? badge('Atrasado', 'bad') : ''}</td><td><b>${esc(f.titulo)}</b><small>${esc(L.fu[f.tipo])}</small></td><td>${sbadge('fuStatus', f.status)}</td><td class="r">${f.status === 'pending' ? btn('Concluir', 'fu-done', { id: f.id }, 'small') : ''}</td></tr>`), 'Nenhum follow-up.'), btn('+ Agendar', 'new-followup', { lead: id }, 'small'))}</div>
      ${panel('Linha do tempo', `<ol class="timeline">${acts.map(a => `<li><span class="tl-dot ${a.tipo}"></span><div><b>${esc(L.act[a.tipo] || a.tipo)}</b> · <small>${fdt(a.created_at)}</small><p>${esc(a.descricao)}</p></div></li>`).join('')}</ol>`, btn('+ Atividade', 'lead-activity', { id }, 'small'))}</div>`,
    after: root => $('#stage-sel', root)?.addEventListener('change', async e => { try { await ACTIONS['lead-stage']({ id, v: e.target.value }); } catch (err) { toast(err.message, 'bad'); render(); } }) };
}, 'prospeccao');
ACTIONS['convert-lead'] = d => openSaleWizard({ leadId: d.id });

// ---------------------------------------------------------------- Follow-ups
async function openFollowUp(preset = {}, fu = null) {
  const leads = await db.get('v_leads', 'select=id,empresa&is_won=eq.false&is_lost=eq.false&order=empresa.asc');
  const t = new Date(Date.now() + 864e5); t.setHours(10, 0, 0, 0);
  const localIso = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const values = fu ? { ...fu, due_at: localIso(new Date(fu.due_at)) } : { tipo: 'follow_up', prioridade: 'normal', due_at: localIso(t), ...preset };
  openSheet({ title: fu ? 'Editar follow-up' : preset.tipo === 'contact' ? 'Agendar contato' : 'Agendar follow-up', values, fields: [
    { name: 'lead_id', label: 'Lead', type: 'select', options: () => leads.map(l => [l.id, l.empresa]), placeholder: '— nenhum —' },
    { name: 'client_id', label: 'Cliente', type: 'select', options: clientOptions, placeholder: '— nenhum —' },
    { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: opts(L.fu) }, { name: 'prioridade', label: 'Prioridade', type: 'select', required: true, options: opts(L.prio) },
    { name: 'titulo', label: 'Título', required: true, full: true }, { name: 'due_at', label: 'Data e hora', type: 'datetime', required: true },
    { name: 'responsavel', label: 'Responsável', value: S.owner }, { name: 'observacoes', label: 'Observações', type: 'textarea', full: true }],
    onSubmit: async v => {
      if (!v.lead_id && !v.client_id) throw Error('Escolha um lead ou um cliente.');
      if (fu) await db.set('follow_ups', fu.id, v); else await db.add('follow_ups', v);
      await saved(fu ? 'Follow-up atualizado.' : 'Follow-up agendado.');
    } });
}
ACTIONS['new-followup'] = d => openFollowUp({ ...(d.lead ? { lead_id: d.lead } : {}), ...(d.client ? { client_id: d.client } : {}), ...(d.tipo ? { tipo: d.tipo } : {}) });
ACTIONS['edit-fu'] = async d => openFollowUp({}, (await db.get('follow_ups', `id=eq.${d.id}`))[0]);
ACTIONS['fu-done'] = async d => { await db.set('follow_ups', d.id, { status: 'done' }); await saved('Concluído.'); };
ACTIONS['fu-cancel'] = async d => { await db.set('follow_ups', d.id, { status: 'cancelled' }); await saved('Cancelado.'); };
ACTIONS['fu-reopen'] = async d => { await db.set('follow_ups', d.id, { status: 'pending' }); await saved('Reaberto.'); };
ACTIONS['fu-del'] = d => confirmSheet('Excluir follow-up', 'Remove este compromisso.', async () => { await db.del('follow_ups', d.id); await saved('Excluído.'); }, { label: 'Excluir' });

route('/follow-ups', 'Follow-ups', async q => {
  const tab = q.get('tab') || 'pendentes'; const prio = q.get('prio') || ''; const busca = (q.get('q') || '').toLowerCase();
  const all = await db.get('v_follow_ups', 'order=due_at.asc');
  const ms = monthStart(S.today);
  const f = { pendentes: x => x.status === 'pending', hoje: x => x.hoje, atrasados: x => x.atrasado, concluidos: x => x.status === 'done', todos: () => true }[tab] || (() => true);
  const rows = all.filter(f).filter(x => (!prio || x.prioridade === prio) && (!busca || `${x.titulo} ${x.lead_empresa} ${x.client_nome}`.toLowerCase().includes(busca)));
  if (tab === 'concluidos' || tab === 'todos') rows.reverse();
  return kpis([kpi('Hoje', all.filter(x => x.hoje).length), kpi('Pendentes', all.filter(x => x.status === 'pending').length),
      kpi('Atrasados', all.filter(x => x.atrasado).length, '', all.some(x => x.atrasado) ? 'bad' : ''), kpi('Concluídos no mês', all.filter(x => x.status === 'done' && localDay(x.completed_at) >= ms).length)])
    + `<div class="toolbar">${tabs([['pendentes', 'Pendentes'], ['hoje', 'Hoje'], ['atrasados', 'Atrasados'], ['concluidos', 'Concluídos'], ['todos', 'Todos']], tab, 'setq', { k: 'tab' })}
      <select data-q="prio" aria-label="Prioridade"><option value="">Toda prioridade</option>${opts(L.prio).map(([k, t]) => `<option value="${k}" ${k === prio ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input type="search" data-q="q" placeholder="Buscar…" value="${esc(q.get('q') || '')}"><span class="grow"></span>${btn('Agendar contato', 'new-followup', { tipo: 'contact' })}${btn('+ Follow-up', 'new-followup', {}, 'primary')}</div>`
    + panel('Compromissos', table(['Quando', 'O quê', 'Com quem', 'Prioridade', 'Status', ''], rows.map(x => `<tr class="${x.atrasado ? 'late' : ''}">
      <td>${fdt(x.due_at)}${x.atrasado ? badge('Atrasado', 'bad') : x.hoje ? badge('Hoje', 'warn') : ''}</td><td><b>${esc(x.titulo)}</b><small>${esc(L.fu[x.tipo])}${x.observacoes ? ' · ' + esc(x.observacoes) : ''}</small></td>
      <td>${x.lead_id ? link('#/prospeccao/' + x.lead_id, x.lead_empresa) : ''}${x.client_id ? link('#/clientes/' + x.client_id, x.client_nome) : ''}</td>
      <td>${x.prioridade === 'high' ? badge('Alta', 'bad') : esc(L.prio[x.prioridade])}</td><td>${sbadge('fuStatus', x.status)}</td>
      <td class="r nowrap">${x.status === 'pending' ? btn('Concluir', 'fu-done', { id: x.id }, 'small primary') + btn('Editar', 'edit-fu', { id: x.id }, 'small') + btn('Cancelar', 'fu-cancel', { id: x.id }, 'small subtle') : btn('Reabrir', 'fu-reopen', { id: x.id }, 'small') + btn('Excluir', 'fu-del', { id: x.id }, 'small subtle')}</td></tr>`), 'Nada nesta lista. 👌'));
}, 'follow-ups');
// filtros simples que gravam na URL
document.addEventListener('change', e => { const k = e.target.dataset?.q; if (k) setQuery({ [k]: e.target.value }); });
document.addEventListener('input', e => { const k = e.target.dataset?.q; if (k && e.target.type === 'search') { clearTimeout(e.target._t); e.target._t = setTimeout(() => setQuery({ [k]: e.target.value }), 400); } });

// ---------------------------------------------------------------- Vendas
route('/vendas', 'Vendas', async q => {
  const st = q.get('st') || 'confirmed'; const busca = (q.get('q') || '').toLowerCase();
  const sales = await db.get('v_sales', 'order=data_venda.desc,numero.desc');
  const ms = monthStart(S.today); const mes = sales.filter(s => s.status === 'confirmed' && s.data_venda >= ms);
  const valor = mes.reduce((a, s) => a + num(s.total), 0);
  const rows = sales.filter(s => (st === 'todas' || s.status === st) && (!busca || `${s.numero} ${s.client_nome}`.toLowerCase().includes(busca)));
  return kpis([kpi('Vendas no mês', mes.length), kpi('Valor vendido no mês', money(valor)), kpi('Ticket médio', money(mes.length ? valor / mes.length : 0)),
      kpi('Novo MRR vendido', money(mes.reduce((a, s) => a + num(s.mrr_novo), 0)), 'no mês')])
    + `<div class="toolbar">${tabs([['confirmed', 'Confirmadas'], ['cancelled', 'Canceladas'], ['todas', 'Todas']], st, 'setq', { k: 'st' })}<input type="search" data-q="q" placeholder="Buscar venda ou cliente…" value="${esc(q.get('q') || '')}"><span class="grow"></span>
      ${btn('Exportar CSV', 'sales-csv')}${btn('+ Nova venda', 'new-sale', {}, 'primary')}</div>`
    + panel('Vendas', table(['Venda', 'Cliente', 'Data', ['Total', 'r'], ['Novo MRR', 'r'], ['Recebido', 'r'], ['Em aberto', 'r'], 'Status'], rows.map(s => `<tr>
      <td><a href="#/vendas/${s.id}"><b>${esc(s.numero)}</b></a></td><td>${link('#/clientes/' + s.client_id, s.client_nome)}</td><td>${fdate(s.data_venda)}</td>
      <td class="r">${money(s.total)}<small>${s.parcelas}x · ${esc(s.forma_pagamento || '')}</small></td><td class="r">${num(s.mrr_novo) ? money(s.mrr_novo) : '—'}</td>
      <td class="r">${money(s.recebido)}</td><td class="r">${money(s.em_aberto)}</td><td>${sbadge('sale', s.status)}</td></tr>`), 'Nenhuma venda ainda.'));
}, 'vendas');
ACTIONS['sales-csv'] = async () => { const s = await db.get('v_sales', 'order=data_venda.desc'); downloadCSV('vendas', ['Venda', 'Cliente', 'Data', 'Total', 'Avulso', 'Novo MRR', 'Parcelas', 'Recebido', 'Em aberto', 'Status'], s.map(x => [x.numero, x.client_nome, fdate(x.data_venda), csvMoney(x.total), csvMoney(x.total_avulso), csvMoney(x.mrr_novo), x.parcelas, csvMoney(x.recebido), csvMoney(x.em_aberto), L.sale[x.status]])); };

route('/vendas/:id', 'Venda', async (q, id) => {
  const [[s], items, entries, svcs] = await Promise.all([db.get('v_sales', `id=eq.${id}`), db.get('sale_items', `sale_id=eq.${id}`),
    db.get('v_entries', `sale_id=eq.${id}&order=due_date.asc`), db.get('client_services', `sale_id=eq.${id}`)]);
  if (!s) return empty('Venda não encontrada.');
  return { title: s.numero, html: `<div class="page-head"><div><a href="#/vendas" class="back">← Vendas</a><h2>${esc(s.numero)} · ${esc(s.client_nome)}</h2><p class="muted">${fdate(s.data_venda)} · ${esc(s.forma_pagamento || 'forma não informada')} · origem ${esc(s.origem || '—')} ${s.status === 'cancelled' ? badge('Cancelada', 'mute') : ''}</p></div>
    <div class="actions">${link('#/clientes/' + s.client_id, 'Ver cliente')}${btn('Criar projeto', 'new-project', { client: s.client_id, sale: s.id })}${s.status === 'confirmed' ? btn('Cancelar venda', 'cancel-sale', { id }, 'subtle') : ''}</div></div>
    ${kpis([kpi('Total', money(s.total)), kpi('Avulso', money(s.total_avulso), `${s.parcelas} parcela(s)`), kpi('Novo MRR', money(s.mrr_novo)), kpi('Recebido', money(s.recebido), `em aberto ${money(s.em_aberto)}`)])}
    ${panel('Itens', table(['Descrição', ['Qtd', 'r'], ['Preço', 'r'], ['Total', 'r'], 'Cobrança'], items.map(i => `<tr><td>${esc(i.descricao)}</td><td class="r">${num(i.quantidade)}</td><td class="r">${money(i.preco_unit)}</td><td class="r">${money(i.total)}</td><td>${esc(L.per[i.periodicidade])}</td></tr>`)))}
    ${panel('Parcelas', entryTable(entries, { client: false }))}
    ${svcs.length ? panel('Serviços recorrentes criados', table(['Serviço', 'Valor', 'MRR', 'Próxima cobrança', 'Status'], svcs.map(v => `<tr><td>${esc(v.descricao)}</td><td>${money(v.valor)} ${esc(L.per[v.periodicidade])}</td><td>${money(v.mrr)}</td><td>${fdate(v.next_billing_date)}</td><td>${sbadge('svc', v.status)}</td></tr>`))) : ''}
    ${s.notas ? panel('Notas', `<p class="note">${esc(s.notas)}</p>`) : ''}` };
}, 'vendas');
ACTIONS['cancel-sale'] = d => confirmSheet('Cancelar venda', 'Cancela as parcelas ainda não pagas e os serviços recorrentes dessa venda. Pagamentos já recebidos ficam registrados (sem estorno automático).',
  async v => { await rpc('cancel_sale', { p_sale: d.id, p_reason: v.motivo }); await saved('Venda cancelada.'); }, { label: 'Cancelar venda', reason: 'Motivo do cancelamento' });

// Assistente de venda: 1 Cliente · 2 Itens · 3 Pagamento · 4 Revisão
async function openSaleWizard({ leadId, clientId } = {}) {
  const lead = leadId ? (await db.get('leads', `id=eq.${leadId}`))[0] : null;
  const key = crypto.randomUUID(); const cid = clientId || lead?.client_id || '';
  const svcOpts = `<option value="">Serviço do catálogo…</option>${REF.services.filter(s => s.ativo).map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('')}`;
  const perSel = v => `<select name="per">${opts(L.per).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const itemRow = (it = {}) => `<div class="item-row"><select name="svc" aria-label="Serviço">${svcOpts}</select><input name="desc" placeholder="Descrição" value="${esc(it.desc || '')}"><input name="qtd" type="number" min="0.01" step="0.01" value="${it.qtd || 1}" aria-label="Quantidade"><input name="preco" type="number" min="0" step="0.01" placeholder="Preço" value="${it.preco ?? ''}" aria-label="Preço">${perSel(it.per || 'one_time')}<button type="button" class="icon-btn" data-rm aria-label="Remover">✕</button></div>`;
  const html = `<div class="wizard">
    <h3><span>1</span> Cliente</h3>
    <div class="seg"><label><input type="radio" name="cmode" value="old" ${cid || !lead ? 'checked' : ''}> Cliente existente</label><label><input type="radio" name="cmode" value="new" ${!cid && lead ? 'checked' : ''}> Novo cliente</label></div>
    <div data-mode="old" class="form-grid"><label class="field full">Cliente<select name="client_id"><option value="">Selecione…</option>${clientOptions().map(([k, t]) => `<option value="${k}" ${k === cid ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
    <div data-mode="new" class="form-grid"><label class="field full">Nome / empresa<input name="nc_nome" value="${esc(lead?.empresa || '')}"></label>
      <label class="field">Tipo<select name="nc_tipo"><option value="pj">Empresa (PJ)</option><option value="pf">Pessoa (PF)</option></select></label><label class="field">CPF/CNPJ <em>(opcional)</em><input name="nc_doc"></label>
      <label class="field">WhatsApp<input name="nc_tel" value="${esc(lead?.whatsapp || '')}"></label><label class="field">E-mail<input name="nc_email" type="email" value="${esc(lead?.email || '')}"></label>
      <label class="field">Cidade<input name="nc_cidade" value="${esc(lead?.cidade || '')}"></label><label class="field">Contato principal<input name="ct_nome" value="${esc(lead?.contato || '')}"></label></div>
    <h3><span>2</span> Serviços / itens</h3><div id="items">${itemRow({ desc: lead ? (lead.servico_interesse || 'Projeto ' + lead.empresa) : '', preco: lead?.estimated_value ?? '' })}</div>
    <button type="button" class="small" data-add-item>+ Item</button><small class="hint">Itens mensais/trimestrais/anuais viram contrato recorrente (MRR) e são cobrados automaticamente. Itens avulsos viram parcelas.</small>
    <h3><span>3</span> Pagamento</h3>
    <div class="form-grid"><label class="field">Data da venda<input type="date" name="data_venda" value="${S.today}"></label>
      <label class="field">Forma<select name="forma">${['Pix', 'Boleto', 'Cartão', 'Transferência', 'Dinheiro'].map(x => `<option>${x}</option>`).join('')}</select></label>
      <label class="field">Parcelas (avulso)<input type="number" name="n" min="1" max="24" value="1"></label><label class="field">1º vencimento<input type="date" name="first" value="${S.today}"></label>
      <label class="field">1ª cobrança recorrente<input type="date" name="rec_first" value="${addMonths(S.today, 1)}"></label>
      <label class="field">Conta de recebimento<select name="account">${acctOptions('empresa').map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select></label></div>
    <div id="parcelas"></div>
    <h3><span>4</span> Revisão</h3><div id="review" class="review"></div>
    <label class="field full">Notas <em>(opcional)</em><textarea name="notas" rows="2"></textarea></label></div>`;
  openSheet({ title: lead ? `Converter ${lead.empresa} em venda` : 'Nova venda', html, wide: true, submit: 'Confirmar venda',
    onMount: body => {
      const upd = () => {
        const mode = body.querySelector('[name=cmode]:checked').value;
        body.querySelectorAll('[data-mode]').forEach(x => (x.hidden = x.dataset.mode !== mode));
        const items = readItems(body); const one = round2(items.filter(i => i.periodicidade === 'one_time').reduce((a, i) => a + i.quantidade * i.preco_unit, 0));
        const mrr = items.filter(i => i.periodicidade !== 'one_time').reduce((a, i) => a + i.quantidade * i.preco_unit / ({ monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 }[i.periodicidade]), 0);
        const n = Math.min(24, Math.max(1, Number(body.querySelector('[name=n]').value) || 1)); const first = body.querySelector('[name=first]').value || S.today;
        const box = $('#parcelas', body);
        if (box.dataset.sig !== `${one}|${n}|${first}`) {
          box.dataset.sig = `${one}|${n}|${first}`;
          const cents = Math.round(one * 100); const base = Math.floor(cents / n); const rest = cents - base * n;
          box.innerHTML = one > 0 ? `<table class="mini"><thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th></tr></thead><tbody>${Array.from({ length: n }, (_, i) => `<tr><td>${i + 1}/${n}</td><td><input type="number" step="0.01" min="0.01" data-p-amount value="${((base + (i < rest ? 1 : 0)) / 100).toFixed(2)}"></td><td><input type="date" data-p-date value="${addMonths(first, i)}"></td></tr>`).join('')}</tbody></table><small class="hint">Pode ajustar valor e data de cada parcela (ex.: R$ 1.500 na entrega + R$ 500 depois). A soma precisa fechar.</small>` : '';
        }
        const sum = round2($$('[data-p-amount]', box).reduce((a, x) => a + num(x.value), 0));
        $('#review', body).innerHTML = `<div><span>Total da venda</span><b>${money(one + items.filter(i => i.periodicidade !== 'one_time').reduce((a, i) => a + i.quantidade * i.preco_unit, 0))}</b></div><div><span>Avulso em parcelas</span><b>${money(one)}</b>${one && Math.abs(sum - one) > 0.004 ? `<small class="bad-text">Parcelas somam ${money(sum)}</small>` : ''}</div><div><span>Novo MRR</span><b>${money(mrr)}</b></div>`;
      };
      body.addEventListener('input', upd); body.addEventListener('change', e => {
        if (e.target.name === 'svc' && e.target.value) { const s = REF.services.find(x => x.id === e.target.value); const row = e.target.closest('.item-row');
          if (s) { row.querySelector('[name=desc]').value = s.nome; if (s.preco != null) row.querySelector('[name=preco]').value = s.preco; row.querySelector('[name=per]').value = s.periodicidade; } }
        upd(); });
      body.addEventListener('click', e => {
        if (e.target.closest('[data-add-item]')) { $('#items', body).insertAdjacentHTML('beforeend', itemRow()); upd(); }
        if (e.target.closest('[data-rm]')) { if ($$('.item-row', body).length > 1) e.target.closest('.item-row').remove(); upd(); }
      });
      upd();
    },
    onSubmit: async () => {
      const body = $('#sheet-body'); const g = n => body.querySelector(`[name=${n}]`)?.value.trim() || '';
      const mode = body.querySelector('[name=cmode]:checked').value; const items = readItems(body, true);
      if (!items.length) throw Error('Inclua pelo menos um item com descrição e preço.');
      if (mode === 'old' && !g('client_id')) throw Error('Escolha o cliente.');
      if (mode === 'new' && !g('nc_nome')) throw Error('Informe o nome do novo cliente.');
      const custom = $$('#parcelas tbody tr', body).map(tr => ({ amount: round2(tr.querySelector('[data-p-amount]').value), due_date: tr.querySelector('[data-p-date]').value }));
      const p = { idempotency_key: key, lead_id: lead?.id || '', data_venda: g('data_venda'), forma_pagamento: g('forma'), parcelas: Number(g('n')) || 1,
        primeiro_vencimento: g('first'), primeira_cobranca_recorrente: g('rec_first'), account_id: g('account'), notas: g('notas'), items,
        ...(custom.length ? { parcelas_custom: custom } : {}),
        ...(mode === 'old' ? { client_id: g('client_id') } : { new_client: { nome: g('nc_nome'), tipo: g('nc_tipo'), documento: g('nc_doc'), telefone: g('nc_tel'), email: g('nc_email'), cidade: g('nc_cidade'), origem: lead?.origem || '' } }),
        ...(g('ct_nome') && mode === 'new' ? { contact: { nome: g('ct_nome'), telefone: g('nc_tel'), email: g('nc_email') } } : {}) };
      const r = await rpc('create_sale', { p });
      location.hash = `#/vendas/${r.sale_id}`; await saved(`Venda ${r.numero} lançada.`);
    } });
}
function readItems(body, strict = false) {
  const rows = $$('.item-row', body).map(r => ({ service_id: r.querySelector('[name=svc]').value, descricao: r.querySelector('[name=desc]').value.trim(),
    quantidade: Number(r.querySelector('[name=qtd]').value) || 1, preco_unit: round2(r.querySelector('[name=preco]').value), periodicidade: r.querySelector('[name=per]').value }));
  if (strict) for (const i of rows) {
    if (i.descricao && !(i.preco_unit > 0)) throw Error(`Informe o preço de "${i.descricao}".`);
    if (!i.descricao && i.preco_unit > 0) throw Error('Tem item com preço mas sem descrição.');
  }
  return rows.filter(i => i.descricao && i.preco_unit > 0);
}
ACTIONS['new-sale'] = d => openSaleWizard({ clientId: d.client });

// ---------------------------------------------------------------- Leads do site (formulário do gravv.com.br)
route('/leads-site', 'Leads do site', async q => {
  const st = q.get('st') || 'novo';
  const rows = await db.get('crm_leads', 'select=id,criado_em,nome,empresa,contato,interesse,mensagem,origem,status&order=criado_em.desc&limit=500');
  const shown = rows.filter(r => st === 'todos' || r.status === st);
  return `<div class="toolbar">${tabs([['novo', `Novos (${rows.filter(r => r.status === 'novo').length})`], ['convertido', 'No funil'], ['arquivado', 'Arquivados'], ['todos', 'Todos']], st, 'setq', { k: 'st' })}</div>`
    + panel('Pedidos de contato do site', table(['Recebido', 'Nome / empresa', 'Contato', 'Interesse', ''], shown.map(r => { const wa = waLink(r.contato);
      return `<tr><td>${fdt(r.criado_em)}</td><td><b>${esc(r.nome)}</b><small>${esc(r.empresa || '')}</small></td><td>${wa ? `<a href="${wa}" target="_blank" rel="noopener">${esc(r.contato)}</a>` : r.contato.includes('@') ? `<a href="mailto:${esc(r.contato)}">${esc(r.contato)}</a>` : esc(r.contato)}</td>
      <td>${esc(r.interesse || '—')}${r.mensagem ? `<small>${esc(r.mensagem)}</small>` : ''}</td><td class="r nowrap">${r.status === 'novo' ? btn('Levar pro funil', 'site-to-lead', { id: r.id }, 'small primary') + btn('Arquivar', 'site-status', { id: r.id, v: 'arquivado' }, 'small subtle') : btn('Reabrir', 'site-status', { id: r.id, v: 'novo' }, 'small')}</td></tr>`; }), 'Nenhum contato nesta lista.'))
    + `<p class="muted small-text">Quem preenche o formulário do gravv.com.br cai aqui. "Levar pro funil" cria o lead na primeira etapa da Prospecção.</p>`;
}, 'leads-site');
ACTIONS['site-to-lead'] = async d => { const r = await rpc('site_lead_to_pipeline', { p_site: d.id }); location.hash = `#/prospeccao/${r.lead_id}`; toast('Lead criado no funil.'); };
ACTIONS['site-status'] = async d => { await db.set('crm_leads', d.id, { status: d.v }); await saved('Atualizado.'); };

// ---------------------------------------------------------------- Conversas (WhatsApp API oficial)
const CHAT = { list: [], config: {}, open: '' };
const fmtPhone = p => { const d = String(p || ''); return d.startsWith('55') && d.length >= 12 ? `(${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}` : '+' + d; };
const chatClient = phone => REF.clients.find(c => (c.telefone || '').replace(/\D/g, '').endsWith(String(phone).slice(-8)));
route('/conversas', 'Conversas', async q => {
  try { const r = await api('/api/conversas'); CHAT.list = r.mensagens || []; CHAT.config = r.configuracao || {}; } catch (e) { CHAT.list = []; CHAT.config = { erro: e.message }; }
  const missing = Object.entries(CHAT.config).filter(([k, v]) => k !== 'erro' && !v).map(([k]) => k);
  const top = CHAT.config.erro ? `<div class="notice">${esc(CHAT.config.erro)}</div>` : missing.length ? `<div class="notice">Falta configurar na Vercel: <b>${esc(missing.join(', '))}</b>. Enquanto isso as conversas não chegam.</div>` : '';
  const map = new Map(); for (const m of CHAT.list) { const t = map.get(m.telefone) || { tel: m.telefone, nome: '', last: m }; if (m.nome && !t.nome) t.nome = m.nome; if (m.enviado_em > t.last.enviado_em) t.last = m; map.set(m.telefone, t); }
  const threads = [...map.values()].sort((a, b) => b.last.enviado_em.localeCompare(a.last.enviado_em));
  const open = q.get('tel') || threads[0]?.tel || '';
  const actions = `<div class="toolbar"><span class="grow"></span>${btn('Ligar webhook', 'chat-subscribe')}${btn('Atualizar', 'reload', {}, 'primary')}</div>`;
  if (!threads.length) return top + actions + panel('Conversas do WhatsApp', empty('Nenhuma mensagem ainda', 'Quando o webhook estiver ligado, cada mensagem do número profissional aparece aqui.'));
  const msgs = CHAT.list.filter(m => m.telefone === open).sort((a, b) => a.enviado_em.localeCompare(b.enviado_em));
  const c = chatClient(open);
  return { html: top + actions + `<section class="panel chat"><div class="chat-list">${threads.map(t => { const cl = chatClient(t.tel); return `<a class="chat-item ${t.tel === open ? 'on' : ''}" href="#/conversas?tel=${t.tel}"><b>${esc(cl?.nome || t.nome || fmtPhone(t.tel))}</b><small>${t.last.direcao === 'saida' ? 'Você: ' : ''}${esc(t.last.texto.slice(0, 70))}</small><em>${fdt(t.last.enviado_em)}</em></a>`; }).join('')}</div>
    <div class="chat-main"><div class="chat-head"><b>${esc(c?.nome || threads.find(t => t.tel === open)?.nome || fmtPhone(open))}</b><small>${esc(fmtPhone(open))}${c ? ' · cliente' : ''}</small></div>
    <div class="chat-thread" id="chat-thread">${msgs.map(m => `<div class="bubble ${m.direcao === 'saida' ? 'out' : 'in'}"><p>${esc(m.texto)}</p><small>${fdt(m.enviado_em)}${m.origem === 'app' ? ' · celular' : m.origem === 'crm' ? ' · CRM' : m.origem === 'historico' ? ' · histórico' : ''}${m.status ? ' · ' + esc(m.status) : ''}</small></div>`).join('')}</div>
    <div class="chat-compose"><textarea id="chat-text" rows="2" placeholder="Escreva a resposta…" aria-label="Mensagem"></textarea>${btn('Enviar', 'chat-send', { tel: open }, 'primary')}</div></div></section>`,
    after: root => { const b = $('#chat-thread', root); if (b) b.scrollTop = b.scrollHeight; } };
}, 'conversas');
ACTIONS['chat-send'] = async d => { const t = $('#chat-text').value.trim(); if (!t) return; await api('/api/conversas/enviar', { method: 'POST', body: { telefone: d.tel, texto: t } }); toast('Mensagem enviada.'); await render(); };
ACTIONS['chat-subscribe'] = async () => { const r = await api('/api/conversas/assinar', { method: 'POST' }); toast('Webhook ligado' + ((r.numeros || []).length ? ' no número ' + r.numeros.map(n => n.numero).join(', ') : '') + '.'); };

// ---------------------------------------------------------------- Avisos de cobrança (WhatsApp, modelos aprovados pela Meta)
const AV = { data: null };
const avTone = { antes: 'mute', no_dia: 'warn', atrasado: 'bad' };
const avWhen = a => (a.dias > 0 ? `vence em ${a.dias} dia${a.dias > 1 ? 's' : ''}` : a.dias === 0 ? 'vence hoje' : `venceu há ${-a.dias} dia${a.dias < -1 ? 's' : ''}`);
route('/avisos', 'Avisos de cobrança', async () => {
  let r; try { r = await api('/api/avisos'); } catch (e) { return `<div class="notice bad">${esc(e.message)}</div>`; }
  AV.data = r; const cfg = r.config || {}; const list = r.avisos || [];
  const missing = Object.entries(r.whatsapp || {}).filter(([, v]) => !v).map(([k]) => k);
  const notes = [
    missing.length ? `<div class="notice">O envio automático (pela API) libera quando <b>${esc(missing.join(', '))}</b> estiver na Vercel. Enquanto isso, use <b>Mandar pelo meu WhatsApp</b>: abre o seu WhatsApp com a mensagem pronta, é só tocar em enviar.</div>` : '',
    !cfg.pix ? `<div class="notice">Coloque a <b>chave Pix da GRAVV</b> em Ajustes — ela vai em todas as mensagens.</div>` : '',
    list.some(a => !a.telefone) ? `<div class="notice">Tem cliente sem WhatsApp no cadastro. Coloque o número no cliente ou no contato principal (com DDD).</div>` : ''].join('');
  const toolbar = `<div class="toolbar"><p class="muted grow">Avisa ${cfg.dias_antes} dia(s) antes, no dia e ${cfg.dias_depois} dia(s) depois do vencimento. Cada aviso sai uma vez só. Você confere e manda.</p>${btn('Ajustes', 'av-config')}${btn('Modelos da Meta', 'av-models')}${btn('Atualizar', 'reload', {}, 'primary')}</div>`;
  const rows = list.map((a, i) => `<tr><td data-label="Cliente"><b>${esc(a.cliente)}</b><small>${a.telefone ? esc(fmtPhone(a.telefone)) : '<em>sem WhatsApp</em>'}</small></td>
    <td data-label="O quê">${esc(a.descricao)}<small>${esc(avWhen(a))} · ${fdate(a.vencimento)}</small></td><td class="r" data-label="Valor">${money(a.valor)}</td>
    <td data-label="Aviso">${badge(a.etapa_nome, avTone[a.etapa])}</td>
    <td class="r" data-label=""><div class="actions">${btn('Ver mensagem', 'av-preview', { i })}${btn('Mandar pelo meu WhatsApp', 'av-manual', { i }, missing.length ? 'primary small' : 'small')}${a.telefone && !missing.length ? btn('Enviar pela API', 'av-send', { i }, 'primary small') : ''}${!a.telefone && a.client_id ? `<a href="#/clientes/${esc(a.client_id)}">Colocar WhatsApp</a>` : ''}${btn('Ignorar', 'av-skip', { i }, 'small subtle')}</div></td></tr>`);
  const hist = (r.historico || []).map(h => `<tr><td data-label="Quando">${fdt(h.created_at)}</td><td data-label="Cliente">${esc(clientName(h.client_id))}</td><td data-label="Aviso">${badge(ETAPA_LABEL[h.etapa] || h.etapa, avTone[h.etapa])}</td>
    <td data-label="Status">${h.status === 'enviado' ? badge('Enviado', 'good') : badge('Ignorado', 'mute')}</td><td data-label="Mensagem"><small>${esc((h.texto || '').slice(0, 90))}</small></td></tr>`);
  return notes + toolbar + panel(`Pra enviar agora (${list.length})`, table(['Cliente', 'O quê', ['Valor', 'r'], 'Aviso', ''], rows, 'Nenhum aviso pendente. Tudo em dia.'))
    + panel('Últimos avisos', table(['Quando', 'Cliente', 'Aviso', 'Status', 'Mensagem'], hist, 'Nenhum aviso enviado ainda.'));
}, 'avisos');
const ETAPA_LABEL = { antes: 'Vai vencer', no_dia: 'Vence hoje', atrasado: 'Vencido' };
const avItem = d => AV.data?.avisos?.[Number(d.i)];
ACTIONS['av-preview'] = d => { const a = avItem(d); if (!a) return;
  openSheet({ title: `Aviso para ${a.cliente}`, html: `<p class="muted">Para ${a.telefone ? esc(fmtPhone(a.telefone)) : 'sem WhatsApp'} · modelo "${esc(a.etapa_nome)}"</p><div class="bubble out" style="max-width:none;white-space:pre-wrap"><p>${esc(a.texto)}</p></div>`,
    submit: 'Enviar no WhatsApp', onSubmit: async () => { await avSend(a); } }); };
async function avSend(a) { await api('/api/avisos/enviar', { method: 'POST', body: { entry_id: a.entry_id, etapa: a.etapa } }); await saved(`Aviso enviado para ${a.cliente}.`); }
ACTIONS['av-send'] = d => { const a = avItem(d); if (a) confirmSheet('Enviar aviso', `Mandar o aviso "${a.etapa_nome}" de ${money(a.valor)} para ${a.cliente} (${fmtPhone(a.telefone)})?`, async () => { await avSend(a); }, { label: 'Enviar', danger: false }); };
ACTIONS['av-manual'] = d => { const a = avItem(d); if (!a) return;
  if (!AV.data?.config?.pix) return toast('Coloque a chave Pix em Ajustes antes de mandar.', 'bad');
  window.open(`https://wa.me/${a.telefone || ''}?text=${encodeURIComponent(a.texto)}`, '_blank', 'noopener');
  confirmSheet('Mandou a mensagem?', `Se você enviou o aviso pra ${a.cliente} no WhatsApp, confirme aqui pra ele sair da lista e ficar no histórico.${a.telefone ? '' : ' (Sem número no cadastro: escolha o contato no WhatsApp.)'}`,
    async () => { await api('/api/avisos/manual', { method: 'POST', body: { entry_id: a.entry_id, etapa: a.etapa } }); await saved('Aviso registrado como enviado.'); }, { label: 'Sim, mandei', danger: false }); };
ACTIONS['av-skip'] = async d => { const a = avItem(d); if (!a) return; await api('/api/avisos/ignorar', { method: 'POST', body: { entry_id: a.entry_id, etapa: a.etapa } }); await saved('Aviso ignorado.'); };
ACTIONS['av-config'] = () => { const c = AV.data?.config || {};
  openSheet({ title: 'Ajustes dos avisos', values: c, fields: [
    { name: 'pix', label: 'Chave Pix (com nome e banco)', required: true, full: true, hint: 'Vai escrita em todas as mensagens. Ex.: chave · nome do favorecido · banco.' },
    { name: 'dias_antes', label: 'Avisar quantos dias antes', type: 'number', min: 0, required: true },
    { name: 'dias_depois', label: 'Cobrar quantos dias depois de vencido', type: 'number', min: 1, required: true }],
    onSubmit: async v => { await db.add('settings', { key: 'lembretes', value: { pix: v.pix, dias_antes: Number(v.dias_antes), dias_depois: Number(v.dias_depois) } }); await saved('Ajustes salvos.'); } }); };
const MODEL_ST = { APPROVED: ['Aprovado', 'good'], PENDING: ['Em análise na Meta', 'warn'], REJECTED: ['Recusado', 'bad'], NAO_CRIADO: ['Ainda não criado', 'mute'], PAUSED: ['Pausado', 'warn'], DISABLED: ['Desativado', 'bad'] };
function modelsHTML(r) {
  return `<p class="muted">A Meta só deixa a empresa começar conversa com mensagem de modelo aprovado. A aprovação costuma sair em minutos ou poucas horas.</p>`
    + table(['Aviso', 'Modelo', 'Status'], (r.modelos || []).map(m => { const [t, tone] = MODEL_ST[m.status] || [m.status, 'mute']; return `<tr><td>${esc(m.etapa_nome)}</td><td><small>${esc(m.nome)}</small></td><td>${badge(t, tone)}${m.motivo && m.motivo !== 'NONE' ? `<small>${esc(m.motivo)}</small>` : ''}</td></tr>`; }))
    + ((r.erros || []).length ? `<div class="notice bad">${r.erros.map(esc).join('<br>')}</div>` : '');
}
ACTIONS['av-models'] = async () => { const r = await api('/api/avisos/modelos'); const falta = (r.modelos || []).some(m => m.status === 'NAO_CRIADO');
  openSheet({ title: 'Modelos de mensagem (Meta)', html: modelsHTML(r), submit: falta ? 'Criar modelos na Meta' : 'Fechar',
    onSubmit: async () => { if (!falta) return closeSheet(); const c = await api('/api/avisos/modelos', { method: 'POST' }); closeSheet();
      toast(c.erros?.length ? 'A Meta recusou: ' + c.erros.join(' | ') : c.criados.length ? `${c.criados.length} modelo(s) enviados pra aprovação da Meta.` : 'Nada novo pra criar.', c.erros?.length ? 'bad' : ''); } }); };
