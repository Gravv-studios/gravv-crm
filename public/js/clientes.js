'use strict';
/* Clientes (carteira, contatos, serviços contratados, notas), catálogo de serviços e projetos. */
const clientFields = [
  { name: 'nome', label: 'Nome / marca', required: true, full: true }, { name: 'razao_social', label: 'Razão social' },
  { name: 'tipo', label: 'Tipo', type: 'select', required: true, options: [['pj', 'Empresa (PJ)'], ['pf', 'Pessoa (PF)']] },
  { name: 'documento', label: 'CPF / CNPJ' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'telefone', label: 'WhatsApp / telefone', type: 'tel' },
  { name: 'cidade', label: 'Cidade' }, { name: 'segmento', label: 'Segmento' }, { name: 'origem', label: 'Origem', type: 'select', options: ORIGENS },
  { name: 'status', label: 'Status', type: 'select', required: true, options: opts(L.client) }, { name: 'joined_at', label: 'Cliente desde', type: 'date' },
  { name: 'notas', label: 'Notas', type: 'textarea', full: true }];
function openClientForm(c) {
  openSheet({ title: c ? 'Editar cliente' : 'Novo cliente', fields: clientFields, values: c || { tipo: 'pj', status: 'ativo', joined_at: S.today },
    onSubmit: async v => { if (c) await db.set('clients', c.id, v); else { const r = await db.add('clients', v); location.hash = '#/clientes/' + r.id; } await saved(c ? 'Cliente atualizado.' : 'Cliente cadastrado.'); } });
}
ACTIONS['new-client'] = () => openClientForm();
ACTIONS['edit-client'] = async d => openClientForm((await db.get('clients', `id=eq.${d.id}`))[0]);

route('/clientes', 'Clientes', async q => {
  const st = q.get('st') || 'ativos'; const busca = (q.get('q') || '').toLowerCase(); const origem = q.get('origem') || '';
  const all = await db.get('v_clients', 'order=nome.asc'); const ms = monthStart(S.today);
  const rows = all.filter(c => (st === 'todos' ? true : st === 'ativos' ? c.status === 'ativo' : c.status === st) && (!origem || c.origem === origem)
    && (!busca || `${c.nome} ${c.razao_social} ${c.documento} ${c.email} ${c.contato_principal} ${c.segmento}`.toLowerCase().includes(busca)));
  return kpis([kpi('Total', all.filter(c => c.status !== 'arquivado').length), kpi('Ativos', all.filter(c => c.status === 'ativo').length),
      kpi('Pausados', all.filter(c => c.status === 'pausado').length), kpi('Novos no mês', all.filter(c => c.joined_at >= ms).length)])
    + `<div class="toolbar">${tabs([['ativos', 'Ativos'], ['pausado', 'Pausados'], ['inativo', 'Inativos'], ['arquivado', 'Arquivados'], ['todos', 'Todos']], st, 'setq', { k: 'st' })}
      <input type="search" data-q="q" placeholder="Nome, documento, e-mail…" value="${esc(q.get('q') || '')}"><select data-q="origem" aria-label="Origem"><option value="">Toda origem</option>${ORIGENS.map(([k]) => `<option ${k === origem ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <span class="grow"></span>${btn('Exportar CSV', 'clients-csv')}${btn('+ Novo cliente', 'new-client', {}, 'primary')}</div>`
    + panel('Carteira', table(['Cliente', 'Contato', 'Segmento', ['MRR', 'r'], ['A receber', 'r'], 'Status'], rows.map(c => `<tr><td><a href="#/clientes/${c.id}"><b>${esc(c.nome)}</b></a><small>${esc(c.cidade || '')}</small></td>
      <td>${esc(c.contato_principal || '—')}<small>${esc(c.telefone || c.email || '')}</small></td><td>${esc(c.segmento || '—')}</td><td class="r">${num(c.mrr) ? money(c.mrr) : '—'}</td>
      <td class="r">${num(c.a_receber) ? money(c.a_receber) : '—'}${num(c.vencido) ? `<small class="bad-text">${money(c.vencido)} vencido</small>` : ''}</td><td>${sbadge('client', c.status)}</td></tr>`), 'Nenhum cliente nesta seleção.'));
}, 'clientes');
ACTIONS['clients-csv'] = async () => { const r = await db.get('v_clients', 'order=nome.asc'); downloadCSV('clientes', ['Cliente', 'Razão social', 'Tipo', 'Documento', 'E-mail', 'Telefone', 'Cidade', 'Segmento', 'Origem', 'Status', 'Cliente desde', 'MRR', 'A receber'], r.map(c => [c.nome, c.razao_social, c.tipo, c.documento, c.email, c.telefone, c.cidade, c.segmento, c.origem, L.client[c.status], fdate(c.joined_at), csvMoney(c.mrr), csvMoney(c.a_receber)])); };

route('/clientes/:id', 'Cliente', async (q, id) => {
  const tab = q.get('tab') || 'resumo';
  const [[c], contacts, svcs, notes, entries, projects, sales, fus] = await Promise.all([db.get('v_clients', `id=eq.${id}`), db.get('client_contacts', `client_id=eq.${id}&order=principal.desc,nome.asc`),
    db.get('client_services', `client_id=eq.${id}&order=status.asc,created_at.desc`), db.get('client_notes', `client_id=eq.${id}&order=created_at.desc`),
    db.get('v_entries', `client_id=eq.${id}&order=due_date.desc`), db.get('v_projects', `client_id=eq.${id}&order=created_at.desc`),
    db.get('v_sales', `client_id=eq.${id}&order=data_venda.desc`), db.get('v_follow_ups', `client_id=eq.${id}&status=eq.pending&order=due_at.asc`)]);
  if (!c) return empty('Cliente não encontrado.');
  const recebido = entries.filter(e => e.tipo === 'income').reduce((a, e) => a + num(e.paid_amount), 0);
  const head = `<div class="page-head"><div><a href="#/clientes" class="back">← Clientes</a><h2>${esc(c.nome)} ${sbadge('client', c.status)}</h2><p class="muted">${esc([c.segmento, c.cidade, c.origem && 'via ' + c.origem, 'cliente desde ' + fdate(c.joined_at)].filter(Boolean).join(' · '))}</p></div>
    <div class="actions">${btn('Editar', 'edit-client', { id })}${btn('Agendar', 'new-followup', { client: id })}${btn('Nova fatura', 'new-invoice', { client: id })}${btn('Nova venda', 'new-sale', { client: id }, 'primary')}</div></div>
    ${kpis([kpi('MRR', money(c.mrr), `${svcs.filter(s => s.status === 'active' && s.periodicidade !== 'one_time').length} contrato(s)`), kpi('A receber', money(c.a_receber)), kpi('Vencido', money(c.vencido), '', num(c.vencido) ? 'bad' : ''), kpi('Recebido (total)', money(recebido))])}
    ${tabs([['resumo', 'Resumo'], ['financeiro', `Financeiro (${entries.length})`], ['projetos', `Projetos (${projects.length})`], ['vendas', `Vendas (${sales.length})`], ['notas', `Notas (${notes.length})`]], tab, 'setq', { k: 'tab' })}`;
  let body = '';
  if (tab === 'resumo') {
    body = `<div class="grid-2"><div>${panel('Dados', `<dl class="dl"><dt>Razão social</dt><dd>${esc(c.razao_social || '—')}</dd><dt>${c.tipo === 'pf' ? 'CPF' : 'CNPJ'}</dt><dd>${esc(c.documento || '—')}</dd>
      <dt>E-mail</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd><dt>Telefone</dt><dd>${waLink(c.telefone) ? `<a href="${waLink(c.telefone)}" target="_blank" rel="noopener">${esc(c.telefone)}</a>` : esc(c.telefone || '—')}</dd></dl>${c.notas ? `<p class="note">${esc(c.notas)}</p>` : ''}`)}
      ${panel('Contatos', table(['Nome', 'Contato', ''], contacts.map(k => `<tr><td><b>${esc(k.nome)}</b>${k.principal ? badge('Principal', 'good') : ''}<small>${esc(k.cargo || '')}</small></td><td>${esc(k.telefone || '')}<small>${esc(k.email || '')}</small></td><td class="r nowrap">${btn('Editar', 'edit-contact', { id: k.id, client: id }, 'small')}${btn('✕', 'del-contact', { id: k.id }, 'small subtle')}</td></tr>`), 'Nenhum contato.'), btn('+ Contato', 'new-contact', { client: id }, 'small'))}
      ${panel('Próximos compromissos', table(['Quando', 'O quê', ''], fus.map(f => `<tr><td>${fdt(f.due_at)} ${f.atrasado ? badge('Atrasado', 'bad') : ''}</td><td>${esc(f.titulo)}</td><td class="r">${btn('Concluir', 'fu-done', { id: f.id }, 'small')}</td></tr>`), 'Nada agendado.'), btn('+ Agendar', 'new-followup', { client: id }, 'small'))}</div>
      <div>${panel('Serviços contratados', table(['Serviço', ['Valor', 'r'], ['MRR', 'r'], 'Próx. cobrança', 'Status', ''], svcs.map(s => `<tr><td><b>${esc(s.descricao)}</b><small>desde ${fdate(s.started_at)}${s.ended_at ? ' até ' + fdate(s.ended_at) : ''}</small></td>
        <td class="r">${money(s.valor)}<small>${esc(L.per[s.periodicidade])}</small></td><td class="r">${s.status === 'active' ? money(s.mrr) : '—'}</td><td>${s.status === 'active' ? fdate(s.next_billing_date) : '—'}</td><td>${sbadge('svc', s.status)}</td>
        <td class="r nowrap">${btn('Editar', 'edit-svc', { id: s.id }, 'small')}${s.status === 'active' ? btn('Pausar', 'svc-status', { id: s.id, v: 'paused' }, 'small') + btn('Cancelar', 'svc-cancel', { id: s.id }, 'small subtle') : s.status === 'paused' ? btn('Reativar', 'svc-status', { id: s.id, v: 'active' }, 'small') + btn('Cancelar', 'svc-cancel', { id: s.id }, 'small subtle') : btn('Reativar', 'svc-status', { id: s.id, v: 'active' }, 'small')}</td></tr>`), 'Nenhum serviço contratado.'), btn('+ Serviço', 'new-svc', { client: id }, 'small'))}
      ${panel('Projetos ativos', table(['Projeto', 'Status', 'Prazo', 'Progresso'], projects.filter(p => !['completed', 'cancelled'].includes(p.status)).map(p => `<tr><td><a href="#/projetos/${p.id}"><b>${esc(p.nome)}</b></a></td><td>${sbadge('proj', p.status)}</td><td>${fdate(p.due_date)} ${p.atrasado ? badge('Atrasado', 'bad') : ''}</td><td>${bar(p.progress, 100)}</td></tr>`), 'Nenhum projeto ativo.'), btn('+ Projeto', 'new-project', { client: id }, 'small'))}</div></div>`;
  } else if (tab === 'financeiro') body = panel('Títulos do cliente', entryTable(entries, { client: false }), btn('+ Fatura', 'new-invoice', { client: id }, 'small'));
  else if (tab === 'projetos') body = panel('Projetos', projectTable(projects), btn('+ Projeto', 'new-project', { client: id }, 'small'));
  else if (tab === 'vendas') body = panel('Vendas', table(['Venda', 'Data', ['Total', 'r'], ['Novo MRR', 'r'], ['Em aberto', 'r'], 'Status'], sales.map(s => `<tr><td><a href="#/vendas/${s.id}"><b>${esc(s.numero)}</b></a></td><td>${fdate(s.data_venda)}</td><td class="r">${money(s.total)}</td><td class="r">${money(s.mrr_novo)}</td><td class="r">${money(s.em_aberto)}</td><td>${sbadge('sale', s.status)}</td></tr>`), 'Nenhuma venda.'), btn('+ Venda', 'new-sale', { client: id }, 'small'));
  else body = panel('Notas e histórico', `<div class="note-add"><textarea id="note-text" rows="2" placeholder="Escreva uma nota sobre o cliente…"></textarea>${btn('Adicionar', 'add-note', { client: id }, 'primary')}</div>${notes.map(n => `<div class="note-item"><p>${esc(n.texto)}</p><small>${fdt(n.created_at)} ${btn('Apagar', 'del-note', { id: n.id }, 'link')}</small></div>`).join('') || '<p class="muted pad">Sem notas.</p>'}`);
  return { title: c.nome, html: head + body };
}, 'clientes');

// Contatos
const contactFields = [{ name: 'nome', label: 'Nome', required: true }, { name: 'cargo', label: 'Cargo / papel' }, { name: 'telefone', label: 'WhatsApp', type: 'tel' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'principal', label: 'Contato principal', type: 'checkbox', full: true }];
async function saveContact(clientId, v, id) {
  if (v.principal) for (const k of await db.get('client_contacts', `client_id=eq.${clientId}&principal=is.true`)) if (k.id !== id) await db.set('client_contacts', k.id, { principal: false });
  if (id) await db.set('client_contacts', id, v); else await db.add('client_contacts', { ...v, client_id: clientId });
}
ACTIONS['new-contact'] = d => openSheet({ title: 'Novo contato', fields: contactFields, onSubmit: async v => { await saveContact(d.client, v); await saved('Contato salvo.'); } });
ACTIONS['edit-contact'] = async d => { const k = (await db.get('client_contacts', `id=eq.${d.id}`))[0]; openSheet({ title: 'Editar contato', fields: contactFields, values: k, onSubmit: async v => { await saveContact(d.client, v, d.id); await saved('Contato salvo.'); } }); };
ACTIONS['del-contact'] = d => confirmSheet('Remover contato', 'Remove este contato do cliente.', async () => { await db.del('client_contacts', d.id); await saved('Contato removido.'); }, { label: 'Remover' });
ACTIONS['add-note'] = async d => { const t = $('#note-text').value.trim(); if (!t) throw Error('Escreva a nota.'); await db.add('client_notes', { client_id: d.client, texto: t }); await saved('Nota salva.'); };
ACTIONS['del-note'] = d => confirmSheet('Apagar nota', 'Remove esta nota.', async () => { await db.del('client_notes', d.id); await saved('Nota apagada.'); }, { label: 'Apagar' });

// Serviços contratados (a base do MRR)
const svcFields = [
  { name: 'service_id', label: 'Do catálogo', type: 'select', options: () => REF.services.filter(s => s.ativo).map(s => [s.id, s.nome]), placeholder: '— livre —' },
  { name: 'descricao', label: 'Descrição', required: true }, { name: 'valor', label: 'Valor por cobrança (R$)', type: 'money', required: true },
  { name: 'periodicidade', label: 'Periodicidade', type: 'select', required: true, options: opts(L.per) },
  { name: 'started_at', label: 'Início', type: 'date', required: true }, { name: 'next_billing_date', label: 'Próxima cobrança', type: 'date', hint: 'As cobranças são geradas a partir dessa data.' },
  { name: 'notas', label: 'Notas', type: 'textarea', full: true }];
const svcMount = body => $('#f-service_id', body)?.addEventListener('change', e => { const s = REF.services.find(x => x.id === e.target.value); if (!s) return; $('#f-descricao', body).value = s.nome; if (s.preco != null) $('#f-valor', body).value = s.preco; $('#f-periodicidade', body).value = s.periodicidade; });
ACTIONS['new-svc'] = d => openSheet({ title: 'Novo serviço contratado', fields: [...(d.client ? [] : [{ name: 'client_id', label: 'Cliente', type: 'select', required: true, options: clientOptions }]), ...svcFields],
  values: { periodicidade: 'monthly', started_at: S.today, next_billing_date: addMonths(S.today, 1) }, onMount: svcMount,
  onSubmit: async v => { await db.add('client_services', { ...v, client_id: d.client || v.client_id, next_billing_date: v.periodicidade === 'one_time' ? null : v.next_billing_date }); await saved('Serviço contratado. MRR atualizado.'); } });
ACTIONS['edit-svc'] = async d => { const s = (await db.get('client_services', `id=eq.${d.id}`))[0]; openSheet({ title: 'Editar serviço contratado', fields: svcFields, values: s, onMount: svcMount, onSubmit: async v => { await db.set('client_services', d.id, v); await saved('Serviço atualizado.'); } }); };
ACTIONS['svc-status'] = async d => { await db.set('client_services', d.id, { status: d.v }); await saved(d.v === 'active' ? 'Serviço reativado.' : 'Serviço pausado. Cobranças futuras em aberto foram canceladas.'); };
ACTIONS['svc-cancel'] = d => confirmSheet('Cancelar serviço', 'O MRR desse serviço sai do total (churn) e as cobranças futuras ainda não pagas são canceladas.', async () => { await db.set('client_services', d.id, { status: 'cancelled', ended_at: S.today }); await saved('Serviço cancelado.'); }, { label: 'Cancelar serviço' });

// ---------------------------------------------------------------- Serviços (catálogo + contratados)
const serviceFields = [{ name: 'nome', label: 'Nome', required: true, full: true }, { name: 'periodicidade', label: 'Cobrança', type: 'select', required: true, options: opts(L.per) },
  { name: 'preco', label: 'Preço (R$)', type: 'money' }, { name: 'custo', label: 'Custo (R$)', type: 'money', hint: 'Quanto custa entregar (terceiros, ferramentas).' },
  { name: 'ativo', label: 'Ativo no catálogo', type: 'checkbox' }, { name: 'descricao', label: 'Descrição', type: 'textarea', full: true }];
ACTIONS['new-service'] = () => openSheet({ title: 'Novo serviço', fields: serviceFields, values: { periodicidade: 'one_time', ativo: true }, onSubmit: async v => { await db.add('services', v); await saved('Serviço criado.'); } });
ACTIONS['edit-service'] = async d => { const s = REF.services.find(x => x.id === d.id); openSheet({ title: 'Editar serviço', fields: serviceFields, values: s, onSubmit: async v => { await db.set('services', d.id, v); await saved('Serviço atualizado.'); } }); };
route('/servicos', 'Serviços', async q => {
  const tab = q.get('tab') || 'contratados';
  const head = `<div class="toolbar">${tabs([['contratados', 'Contratos ativos'], ['catalogo', 'Catálogo'], ['todos', 'Todos os contratos']], tab, 'setq', { k: 'tab' })}<span class="grow"></span>${tab === 'catalogo' ? btn('+ Serviço no catálogo', 'new-service', {}, 'primary') : btn('+ Contratar serviço', 'new-svc', {}, 'primary')}</div>`;
  if (tab === 'catalogo') return head + panel('Catálogo', table(['Serviço', 'Cobrança', ['Preço', 'r'], ['Custo', 'r'], ['Margem', 'r'], 'Status', ''], REF.services.map(s => `<tr><td><b>${esc(s.nome)}</b><small>${esc(s.descricao || '')}</small></td><td>${esc(L.per[s.periodicidade])}</td>
    <td class="r">${money(s.preco)}</td><td class="r">${money(s.custo)}</td><td class="r">${s.preco ? pct(100 * (num(s.preco) - num(s.custo)) / num(s.preco)) : '—'}</td><td>${s.ativo ? badge('Ativo', 'good') : badge('Arquivado', 'mute')}</td><td class="r">${btn('Editar', 'edit-service', { id: s.id }, 'small')}</td></tr>`)));
  const all = await db.get('v_client_services', 'order=client_nome.asc');
  const rows = tab === 'todos' ? all : all.filter(s => s.status === 'active');
  return head + panel(tab === 'todos' ? 'Todos os contratos' : 'Contratos ativos', table(['Cliente', 'Serviço', ['Valor', 'r'], ['MRR', 'r'], 'Próx. cobrança', 'Status', ''], rows.map(s => `<tr><td>${link('#/clientes/' + s.client_id, s.client_nome)}</td><td>${esc(s.descricao)}</td>
    <td class="r">${money(s.valor)}<small>${esc(L.per[s.periodicidade])}</small></td><td class="r">${s.status === 'active' ? money(s.mrr) : '—'}</td><td>${fdate(s.next_billing_date)}</td><td>${sbadge('svc', s.status)}</td><td class="r">${btn('Editar', 'edit-svc', { id: s.id }, 'small')}</td></tr>`), 'Nenhum contrato.'),
    `<b>${money(rows.filter(s => s.status === 'active').reduce((a, s) => a + num(s.mrr), 0))}</b> de MRR`);
}, 'servicos');

// ---------------------------------------------------------------- Projetos
const PROJ_FLOW = ['waiting_materials', 'planning', 'design', 'development', 'review', 'approval', 'published', 'completed'];
async function openProjectForm(p, preset = {}) {
  openSheet({ title: p ? 'Editar projeto' : 'Novo projeto', values: p || { status: 'planning', prioridade: 'normal', responsavel: S.owner, start_date: S.today, ...preset }, fields: [
    { name: 'client_id', label: 'Cliente', type: 'select', required: true, options: clientOptions }, { name: 'nome', label: 'Nome do projeto', required: true },
    { name: 'status', label: 'Status', type: 'select', required: true, options: opts(L.proj) }, { name: 'prioridade', label: 'Prioridade', type: 'select', required: true, options: opts(L.prio) },
    { name: 'responsavel', label: 'Responsável' }, { name: 'start_date', label: 'Início', type: 'date' }, { name: 'due_date', label: 'Prazo', type: 'date' },
    { name: 'descricao', label: 'Descrição / escopo', type: 'textarea', full: true }, { name: 'notas', label: 'Notas', type: 'textarea', full: true }],
    onSubmit: async v => { if (p) await db.set('projects', p.id, v); else { const r = await db.add('projects', { ...v, sale_id: preset.sale_id || null }); location.hash = '#/projetos/' + r.id; } await saved(p ? 'Projeto atualizado.' : 'Projeto criado.'); } });
}
ACTIONS['new-project'] = d => openProjectForm(null, { client_id: d.client || '', sale_id: d.sale || null });
ACTIONS['edit-project'] = async d => openProjectForm((await db.get('projects', `id=eq.${d.id}`))[0]);
ACTIONS['del-project'] = d => confirmSheet('Excluir projeto', 'Apaga o projeto e as tarefas. Para guardar o histórico, prefira mudar o status para Cancelado.', async () => { await db.del('projects', d.id); location.hash = '#/projetos'; await saved('Projeto excluído.'); }, { label: 'Excluir' });
const projectTable = rows => table(['Projeto', 'Cliente', 'Status', 'Prioridade', 'Prazo', 'Progresso'], rows.map(p => `<tr><td><a href="#/projetos/${p.id}"><b>${esc(p.nome)}</b></a><small>${esc(p.responsavel)}</small></td><td>${link('#/clientes/' + p.client_id, p.client_nome)}</td>
  <td>${sbadge('proj', p.status)}</td><td>${p.prioridade === 'high' ? badge('Alta', 'bad') : esc(L.prio[p.prioridade])}</td><td>${fdate(p.due_date)} ${p.atrasado ? badge('Atrasado', 'bad') : ''}</td><td>${bar(p.progress, 100)}<small>${p.tarefas_feitas}/${p.tarefas_total} tarefas</small></td></tr>`), 'Nenhum projeto.');

route('/projetos', 'Projetos', async q => {
  const view = q.get('view') || 'kanban'; const busca = (q.get('q') || '').toLowerCase(); const prio = q.get('prio') || ''; const cli = q.get('cliente') || '';
  const all = await db.get('v_projects', 'order=due_date.asc.nullslast'); const ms = monthStart(S.today);
  const rows = all.filter(p => (!busca || `${p.nome} ${p.client_nome}`.toLowerCase().includes(busca)) && (!prio || p.prioridade === prio) && (!cli || p.client_id === cli));
  const active = all.filter(p => !['completed', 'cancelled'].includes(p.status));
  const card = p => `<a class="card" href="#/projetos/${p.id}" draggable="true" data-drag="${p.id}"><strong>${esc(p.nome)}</strong><small>${esc(p.client_nome)} · ${esc(p.responsavel)}</small>${bar(p.progress, 100)}
    <div class="card-foot">${p.due_date ? (p.atrasado ? badge('Atrasado ' + fdate(p.due_date), 'bad') : badge(fdate(p.due_date))) : ''}${p.prioridade === 'high' ? badge('Alta', 'bad') : ''}</div></a>`;
  const board = `<div class="kanban" id="pboard">${PROJ_FLOW.map(s => { const items = rows.filter(p => p.status === s); return `<section class="col" data-drop="${s}"><header>${esc(L.proj[s])}<small>${items.length}</small></header><div class="col-body">${items.map(card).join('')}</div></section>`; }).join('')}</div>`;
  return { html: kpis([kpi('Ativos', active.length), kpi('Atrasados', all.filter(p => p.atrasado).length, '', all.some(p => p.atrasado) ? 'bad' : ''), kpi('Aguardando aprovação', all.filter(p => p.status === 'approval').length), kpi('Concluídos no mês', all.filter(p => p.status === 'completed' && localDay(p.completed_at) >= ms).length)])
    + `<div class="toolbar">${tabs([['kanban', 'Pipeline'], ['lista', 'Lista']], view, 'setq', { k: 'view' })}<input type="search" data-q="q" placeholder="Buscar projeto…" value="${esc(q.get('q') || '')}">
      <select data-q="cliente" aria-label="Cliente"><option value="">Todos os clientes</option>${clientOptions().map(([k, t]) => `<option value="${k}" ${k === cli ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select data-q="prio" aria-label="Prioridade"><option value="">Toda prioridade</option>${opts(L.prio).map(([k, t]) => `<option value="${k}" ${k === prio ? 'selected' : ''}>${t}</option>`).join('')}</select><span class="grow"></span>${btn('+ Novo projeto', 'new-project', {}, 'primary')}</div>`
    + (view === 'lista' ? panel('Projetos', projectTable(rows)) : board),
    after: root => { const b = $('#pboard', root); if (b) enableDnD(b, (id, status) => db.set('projects', id, { status })); } };
}, 'projetos');

route('/projetos/:id', 'Projeto', async (q, id) => {
  const [[p], tasks] = await Promise.all([db.get('v_projects', `id=eq.${id}`), db.get('project_tasks', `project_id=eq.${id}&order=posicao.asc,created_at.asc`)]);
  if (!p) return empty('Projeto não encontrado.');
  const sel = `<select id="proj-status" aria-label="Status">${opts(L.proj).map(([k, t]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  return { title: p.nome, html: `<div class="page-head"><div><a href="#/projetos" class="back">← Projetos</a><h2>${esc(p.nome)}</h2><p class="muted">${link('#/clientes/' + p.client_id, p.client_nome)} · ${esc(p.responsavel)}${p.sale_id ? ' · ' + link('#/vendas/' + p.sale_id, 'venda') : ''}</p></div>
    <div class="actions">${sel}${btn('Editar', 'edit-project', { id })}${btn('Excluir', 'del-project', { id }, 'subtle')}</div></div>
    ${kpis([kpi('Progresso', pct(p.progress), `${p.tarefas_feitas}/${p.tarefas_total} tarefas`), kpi('Prazo', fdate(p.due_date), p.atrasado ? 'atrasado' : '', p.atrasado ? 'bad' : ''), kpi('Prioridade', L.prio[p.prioridade]), kpi('Início', fdate(p.start_date))])}
    <div class="grid-2"><div>${panel('Tarefas', `<form class="quick-add" id="task-add"><input name="titulo" placeholder="Nova tarefa… (Enter)" aria-label="Nova tarefa" required><input name="due" type="date" aria-label="Prazo"><button class="primary" type="submit">Adicionar</button></form>
      <ul class="checklist">${tasks.map((t, i) => `<li class="${t.completed ? 'done' : ''}"><label><input type="checkbox" data-task="${t.id}" ${t.completed ? 'checked' : ''}> <span>${esc(t.titulo)}</span></label>
        <small>${t.due_date ? fdate(t.due_date) : ''}${t.responsavel ? ' · ' + esc(t.responsavel) : ''}</small><span class="row-tools">${i ? btn('↑', 'task-move', { id: t.id, dir: -1, pid: id }, 'small subtle') : ''}${i < tasks.length - 1 ? btn('↓', 'task-move', { id: t.id, dir: 1, pid: id }, 'small subtle') : ''}${btn('✎', 'task-edit', { id: t.id }, 'small subtle')}${btn('✕', 'task-del', { id: t.id }, 'small subtle')}</span></li>`).join('') || '<li class="muted">Nenhuma tarefa ainda.</li>'}</ul>`)}</div>
    <div>${panel('Detalhes', `<dl class="dl"><dt>Status</dt><dd>${sbadge('proj', p.status)}</dd><dt>Concluído em</dt><dd>${p.completed_at ? fdate(localDay(p.completed_at)) : '—'}</dd></dl>${p.descricao ? `<p class="note">${esc(p.descricao)}</p>` : ''}${p.notas ? `<p class="note">${esc(p.notas)}</p>` : ''}`)}</div></div>`,
    after: root => {
      $('#proj-status', root).addEventListener('change', async e => { try { await db.set('projects', id, { status: e.target.value }); await saved('Status atualizado.'); } catch (err) { toast(err.message, 'bad'); } });
      $('#task-add', root).addEventListener('submit', async e => { e.preventDefault(); const f = e.target; try { await db.add('project_tasks', { project_id: id, titulo: f.titulo.value, due_date: f.due.value || null, posicao: tasks.length + 1 }); await render(); } catch (err) { toast(err.message, 'bad'); } });
      root.querySelectorAll('[data-task]').forEach(cb => cb.addEventListener('change', async e => { try { await db.set('project_tasks', e.target.dataset.task, { completed: e.target.checked }); await render(); } catch (err) { toast(err.message, 'bad'); } }));
    } };
}, 'projetos');
ACTIONS['task-del'] = async d => { await db.del('project_tasks', d.id); await render(); };
ACTIONS['task-edit'] = async d => { const t = (await db.get('project_tasks', `id=eq.${d.id}`))[0]; openSheet({ title: 'Editar tarefa', values: t, fields: [{ name: 'titulo', label: 'Título', required: true, full: true }, { name: 'responsavel', label: 'Responsável' }, { name: 'due_date', label: 'Prazo', type: 'date' }, { name: 'descricao', label: 'Descrição', type: 'textarea', full: true }], onSubmit: async v => { await db.set('project_tasks', d.id, v); await saved('Tarefa atualizada.'); } }); };
ACTIONS['task-move'] = async d => {
  const list = await db.get('project_tasks', `project_id=eq.${d.pid}&order=posicao.asc,created_at.asc`); const i = list.findIndex(t => t.id === d.id); const j = i + Number(d.dir);
  if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map((t, k) => (t.posicao !== k + 1 ? db.set('project_tasks', t.id, { posicao: k + 1 }) : null))); await render();
};
