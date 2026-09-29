-- CRM GRAVV v2 — dados reais iniciais (clientes, contratos, projetos e cobranças). Rodar UMA vez depois do 03.
-- Só roda se a tabela de clientes estiver vazia (não duplica).
do $$
declare
  c_studart uuid; c_doctor uuid; c_cabinet uuid; c_faith uuid; c_welder uuid; c_junior uuid; c_foco uuid; c_loja uuid;
  c_nathan uuid; c_aqui uuid; p uuid; st uuid;
begin
  if exists (select 1 from public.clients) then
    raise notice 'Clientes já cadastrados — nada foi feito.';
    return;
  end if;

  insert into public.clients (nome, segmento, joined_at, notas) values ('Casa Studart', 'Cachaças / bebidas', '2026-08-01',
    'Primeiro cliente da GRAVV. Site WooCommerce entregue; preços e frete grátis ajustados em 25/09.') returning id into c_studart;
  insert into public.clients (nome, segmento, cidade, joined_at, notas) values ('Doctor & Cia', 'Jalecos e roupas médicas', 'Brasília/DF', '2026-09-10',
    'Loja na Nuvemshop (doctorecia.com.br). Site novo entregue; proposta de implantação + acompanhamento mensal.') returning id into c_doctor;
  insert into public.clients (nome, segmento, joined_at, notas) values ('Le Cabinet', 'Aulas de francês', '2026-09-01',
    'Site + CRM prontos. R$ 500/mês todo dia 7, sem prazo final. Próximos módulos: área de membros, pagamento no site, disparo da agenda.') returning id into c_cabinet;
  insert into public.clients (nome, segmento, joined_at, notas) values ('Faith Gôndolas', 'Gôndolas e móveis', '2026-09-24',
    'Site Divulga Móveis + modelagem 3D de todos os produtos.') returning id into c_faith;
  insert into public.clients (nome, segmento, joined_at) values ('Welder — Fight', 'Luta / academia', '2026-09-01') returning id into c_welder;
  insert into public.clients (nome, segmento, tipo, joined_at) values ('Júnior Rios', 'Corretor de imóveis', 'pf', '2026-09-01') returning id into c_junior;
  insert into public.clients (nome, segmento, joined_at) values ('Foco Imóveis', 'Imóveis rurais e terrenos', '2026-09-01') returning id into c_foco;
  insert into public.clients (nome, segmento, cidade, joined_at) values ('Instrumental e Tal', 'Loja de instrumentos musicais', 'Taguatinga/DF', '2026-09-01') returning id into c_loja;
  insert into public.clients (nome, segmento, status, joined_at) values ('Nathan Advogados', 'Advocacia', 'pausado', '2026-08-01') returning id into c_nathan;
  insert into public.clients (nome, segmento, joined_at, notas) values ('Aqui na Rede Pescados', 'Pescados', '2026-09-01',
    'Projeto Integrador I (faculdade) — e-commerce de pescados.') returning id into c_aqui;

  insert into public.client_contacts (client_id, nome, principal) values
    (c_studart, 'Hugo Studart', true), (c_doctor, 'Elaine Hermuche', true), (c_cabinet, 'Carlos', true),
    (c_faith, 'Eldo', true), (c_welder, 'Welder', true), (c_junior, 'Júnior Rios', true), (c_foco, 'Marcelo', true),
    (c_nathan, 'Nathan', true), (c_aqui, 'Flávia', true);

  -- Le Cabinet: mensalidade (MRR) — cobranças geradas automaticamente todo dia 7
  insert into public.client_services (client_id, service_id, descricao, valor, periodicidade, started_at, next_billing_date, notas)
  values (c_cabinet, (select id from public.services where nome = 'Manutenção de site/CRM'), 'Mensalidade Le Cabinet', 500, 'monthly',
          '2026-09-24', '2026-10-07', 'Sem prazo final: encerra quando o cliente quiser.');

  -- Faith Gôndolas: venda de R$ 2.000 — R$ 1.500 na entrega + R$ 500 em 19/10
  perform public.create_sale(jsonb_build_object(
    'client_id', c_faith, 'data_venda', '2026-09-24', 'forma_pagamento', 'Pix', 'origem', 'Indicação',
    'idempotency_key', 'seed-faith-divulga',
    'items', jsonb_build_array(jsonb_build_object('descricao', 'Site Divulga Móveis + modelagem 3D dos produtos',
             'preco_unit', 2000, 'quantidade', 1, 'service_id', (select id from public.services where nome = 'Site institucional'))),
    'parcelas_custom', jsonb_build_array(jsonb_build_object('amount', 1500, 'due_date', '2026-09-25'),
                                         jsonb_build_object('amount', 500, 'due_date', '2026-10-19')),
    'account_id', (select id from public.financial_accounts where nome = 'Conta GRAVV')));

  perform public.generate_recurring_billing(public.hoje_br() + 30);

  -- Projetos e próximos passos
  insert into public.projects (client_id, nome, status, prioridade, due_date, descricao)
  values (c_faith, 'Divulga Móveis — site + modelagem 3D', 'development', 'high', '2026-09-25',
          'Entrega libera o pagamento de R$ 1.500.') returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Modelar em 3D todos os produtos', 1),
    (p, 'Subir os modelos no site', 2), (p, 'Entregar e cobrar R$ 1.500', 3);

  insert into public.projects (client_id, nome, status, prioridade, descricao)
  values (c_cabinet, 'Le Cabinet — próximos módulos', 'development', 'normal', 'Site e CRM prontos e integrados.') returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Área de membros', 1), (p, 'Pagamento no site', 2),
    (p, 'Disparo da agenda do aluno no WhatsApp', 3);

  insert into public.projects (client_id, nome, status, prioridade, descricao)
  values (c_studart, 'Casa Studart — site e loja', 'review', 'normal', 'Preços novos e frete grátis R$ 299 (SP, RJ, MG, GO, DF) aplicados em 25/09.') returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Texto novo da barra do topo (frete)', 1),
    (p, 'Preço novo do Kit Dueto', 2), (p, 'Trocar WhatsApp do carrossel para +55 61 99109-2121', 3),
    (p, 'CRM com disparo WhatsApp/e-mail (escopo)', 4);

  insert into public.projects (client_id, nome, status, prioridade, descricao)
  values (c_doctor, 'Doctor & Cia — site novo e loja', 'approval', 'normal', 'Site novo entregue; aguardando decisão da proposta.') returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Resolver titularidade da loja Nuvemshop', 1),
    (p, 'Configurar GA4', 2), (p, 'Guia de tamanhos', 3);

  insert into public.projects (client_id, nome, status, prioridade, due_date) values
    (c_welder, 'Fight — site + catálogo', 'development', 'normal', '2026-09-10');
  insert into public.projects (client_id, nome, status, prioridade, descricao)
  values (c_junior, 'Júnior Rios — criativos, Instagram e site', 'waiting_materials', 'high', 'Atrasado.') returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Criativos com as fotos', 1), (p, 'Organizar o Instagram', 2),
    (p, 'Site com catálogo', 3);
  insert into public.projects (client_id, nome, status, prioridade) values (c_foco, 'Foco Imóveis — site com busca por região', 'planning', 'normal')
  returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Site com busca por região (fazenda GO/BR, lote DF/GO, área de prédio)', 1),
    (p, 'Vídeo de valor da fazenda', 2);
  insert into public.projects (client_id, nome, status, prioridade) values (c_loja, 'Instrumental e Tal — site, Instagram e criativos', 'development', 'normal')
  returning id into p;
  insert into public.project_tasks (project_id, titulo, posicao) values (p, 'Site da loja', 1), (p, 'Instagram', 2),
    (p, 'Criativos: microfone novo, luthieria, PLV', 3);
  insert into public.projects (client_id, nome, status, prioridade, notas) values (c_nathan, 'Nathan — ajustes do site', 'review', 'low', 'Cliente pausado.');

  -- Follow-ups de cobrança e contrato
  insert into public.follow_ups (client_id, tipo, titulo, observacoes, due_at, prioridade) values
    (c_studart, 'charge', 'Cobrar o Hugo (Casa Studart)', 'Valor ainda não lançado no CRM — lançar em A receber quando ele confirmar.', '2026-09-25 18:00-03', 'high'),
    (c_cabinet, 'alignment', 'Fechar renovação do contrato Le Cabinet (R$ 500/mês)', null, '2026-10-07 18:00-03', 'normal'),
    (c_faith, 'charge', 'Confirmar recebimento dos R$ 1.500 da Faith', 'Se já caiu, dar baixa em Contas a receber.', '2026-09-29 18:00-03', 'high');

  -- Funil: Doctor & Cia (proposta de implantação + acompanhamento mensal)
  select id into st from public.pipeline_stages where nome = 'Proposta enviada';
  insert into public.leads (empresa, contato, origem, segmento, servico_interesse, stage_id, estimated_value, client_id, notas)
  values ('Doctor & Cia', 'Elaine Hermuche', 'Indicação', 'Jalecos e roupas médicas', 'Implantação + acompanhamento mensal', st, 1670, c_doctor,
          'Implantação proposta R$ 1.670 + mensalidade. Confirmar condições, parte contratante e adesão ao acompanhamento mensal.');
end $$;
