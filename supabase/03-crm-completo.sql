-- CRM GRAVV v2 — estrutura completa (clientes, comercial, vendas, projetos, financeiro, MRR, pessoal).
-- Rodar UMA vez no Supabase (SQL Editor > New query > Run). Não mexe nas tabelas antigas.
-- Tudo trancado: RLS ligado e sem acesso das chaves públicas. Só a API do CRM (chave secreta) acessa.

create or replace function public.hoje_br() returns date language sql stable as
$$ select (now() at time zone 'America/Sao_Paulo')::date $$;

create or replace function public.set_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- Configurações
create table if not exists public.settings (
  key text primary key check (char_length(key) between 1 and 60),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Clientes
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 160),
  razao_social text check (char_length(razao_social) <= 200),
  tipo text not null default 'pj' check (tipo in ('pf', 'pj')),
  documento text check (char_length(documento) <= 30),
  email text check (char_length(email) <= 200),
  telefone text check (char_length(telefone) <= 40),
  cidade text check (char_length(cidade) <= 100),
  segmento text check (char_length(segmento) <= 100),
  origem text check (char_length(origem) <= 60),
  status text not null default 'ativo' check (status in ('ativo', 'pausado', 'inativo', 'arquivado')),
  notas text check (char_length(notas) <= 5000),
  joined_at date not null default public.hoje_br(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 120),
  cargo text check (char_length(cargo) <= 80),
  email text check (char_length(email) <= 200),
  telefone text check (char_length(telefone) <= 40),
  principal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists client_contacts_um_principal on public.client_contacts (client_id) where principal;
create index if not exists client_contacts_client on public.client_contacts (client_id);

create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists client_notes_client on public.client_notes (client_id, created_at desc);

-- ---------------------------------------------------------------- Serviços
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 120),
  descricao text check (char_length(descricao) <= 2000),
  periodicidade text not null default 'one_time'
    check (periodicidade in ('one_time', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  preco numeric(14,2) check (preco >= 0),
  custo numeric(14,2) check (custo >= 0),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Pipeline
create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 60),
  posicao integer not null default 0,
  cor text check (cor ~ '^#[0-9A-Fa-f]{6}$'),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  check (not (is_won and is_lost))
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  empresa text not null check (char_length(empresa) between 1 and 160),
  contato text check (char_length(contato) <= 120),
  whatsapp text check (char_length(whatsapp) <= 40),
  email text check (char_length(email) <= 200),
  cidade text check (char_length(cidade) <= 100),
  origem text check (char_length(origem) <= 60),
  segmento text check (char_length(segmento) <= 100),
  servico_interesse text check (char_length(servico_interesse) <= 200),
  stage_id uuid not null references public.pipeline_stages(id),
  responsavel text not null default 'Marcos' check (char_length(responsavel) <= 80),
  estimated_value numeric(14,2) check (estimated_value >= 0),
  notas text check (char_length(notas) <= 5000),
  client_id uuid references public.clients(id) on delete set null,
  site_lead_id uuid,
  next_follow_up_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text check (char_length(lost_reason) <= 500),
  converted_client_id uuid references public.clients(id) on delete set null,
  converted_sale_id uuid,
  posicao integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_stage on public.leads (stage_id, posicao);

create table if not exists public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  tipo text not null check (tipo in ('criado', 'nota', 'etapa', 'ligacao', 'whatsapp', 'email', 'reuniao',
                                     'follow_up', 'ganho', 'perdido', 'convertido')),
  descricao text not null check (char_length(descricao) between 1 and 2000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_activities_lead on public.lead_activities (lead_id, created_at desc);

create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  tipo text not null default 'follow_up' check (tipo in ('follow_up', 'contact', 'meeting', 'proposal', 'alignment', 'charge')),
  titulo text not null check (char_length(titulo) between 1 and 200),
  observacoes text check (char_length(observacoes) <= 2000),
  due_at timestamptz not null,
  responsavel text not null default 'Marcos' check (char_length(responsavel) <= 80),
  prioridade text not null default 'normal' check (prioridade in ('low', 'normal', 'high')),
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (lead_id is not null or client_id is not null)
);
create index if not exists follow_ups_due on public.follow_ups (status, due_at);

-- ---------------------------------------------------------------- Vendas
create sequence if not exists public.sale_number_seq;

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique default ('VEN-' || lpad(nextval('public.sale_number_seq')::text, 6, '0')),
  client_id uuid not null references public.clients(id),
  lead_id uuid references public.leads(id) on delete set null,
  data_venda date not null default public.hoje_br(),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  total numeric(14,2) not null check (total >= 0),
  total_avulso numeric(14,2) not null default 0,
  mrr_novo numeric(14,2) not null default 0,
  parcelas integer not null default 1 check (parcelas between 1 and 24),
  forma_pagamento text check (char_length(forma_pagamento) <= 40),
  origem text check (char_length(origem) <= 60),
  notas text check (char_length(notas) <= 2000),
  idempotency_key text unique,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_client on public.sales (client_id);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  descricao text not null check (char_length(descricao) between 1 and 200),
  quantidade numeric(10,2) not null default 1 check (quantidade > 0),
  preco_unit numeric(14,2) not null check (preco_unit >= 0),
  total numeric(14,2) not null check (total >= 0),
  periodicidade text not null default 'one_time'
    check (periodicidade in ('one_time', 'monthly', 'quarterly', 'semiannual', 'yearly'))
);
create index if not exists sale_items_sale on public.sale_items (sale_id);

-- Serviços contratados (a base do MRR)
create table if not exists public.client_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  sale_id uuid references public.sales(id) on delete set null,
  descricao text not null check (char_length(descricao) between 1 and 200),
  valor numeric(14,2) not null check (valor >= 0),
  periodicidade text not null default 'monthly'
    check (periodicidade in ('one_time', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  mrr numeric(14,2) generated always as (case periodicidade
      when 'monthly' then valor when 'quarterly' then round(valor / 3, 2)
      when 'semiannual' then round(valor / 6, 2) when 'yearly' then round(valor / 12, 2) else 0 end) stored,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  started_at date not null default public.hoje_br(),
  ended_at date,
  next_billing_date date,
  notas text check (char_length(notas) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_services_client on public.client_services (client_id);
create index if not exists client_services_billing on public.client_services (status, next_billing_date);

create table if not exists public.mrr_events (
  id uuid primary key default gen_random_uuid(),
  client_service_id uuid references public.client_services(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  tipo text not null check (tipo in ('new', 'expansion', 'contraction', 'churn', 'reactivation')),
  previous_mrr numeric(14,2) not null,
  new_mrr numeric(14,2) not null,
  mrr_delta numeric(14,2) not null,
  effective_at date not null default public.hoje_br(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists mrr_events_effective on public.mrr_events (effective_at);

-- ---------------------------------------------------------------- Projetos
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  sale_id uuid references public.sales(id) on delete set null,
  nome text not null check (char_length(nome) between 1 and 160),
  descricao text check (char_length(descricao) <= 3000),
  responsavel text not null default 'Marcos' check (char_length(responsavel) <= 80),
  status text not null default 'planning' check (status in ('waiting_materials', 'planning', 'design', 'development',
                                                            'review', 'approval', 'published', 'completed', 'cancelled')),
  prioridade text not null default 'normal' check (prioridade in ('low', 'normal', 'high')),
  start_date date,
  due_date date,
  progress integer not null default 0 check (progress between 0 and 100),
  notas text check (char_length(notas) <= 3000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_client on public.projects (client_id);

create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  titulo text not null check (char_length(titulo) between 1 and 200),
  descricao text check (char_length(descricao) <= 2000),
  responsavel text check (char_length(responsavel) <= 80),
  due_date date,
  posicao integer not null default 0,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists project_tasks_project on public.project_tasks (project_id, posicao);

-- ---------------------------------------------------------------- Financeiro
create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 80),
  tipo text not null default 'banco' check (tipo in ('banco', 'carteira', 'investimento', 'cartao', 'outro')),
  escopo text not null default 'empresa' check (escopo in ('empresa', 'pessoal')),
  opening_balance numeric(14,2) not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 80),
  tipo text not null check (tipo in ('income', 'expense')),
  escopo text not null default 'empresa' check (escopo in ('empresa', 'pessoal')),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (nome, tipo, escopo)
);

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 120),
  escopo text not null default 'pessoal' check (escopo in ('empresa', 'pessoal')),
  credor text check (char_length(credor) <= 120),
  valor_parcela numeric(14,2) not null check (valor_parcela > 0),
  total_parcelas integer check (total_parcelas between 1 and 600),
  parcelas_pagas_antes integer not null default 0 check (parcelas_pagas_antes >= 0),
  dia_vencimento integer check (dia_vencimento between 1 and 31),
  category_id uuid references public.financial_categories(id),
  account_id uuid references public.financial_accounts(id),
  status text not null default 'ativa' check (status in ('ativa', 'quitada', 'cancelada')),
  notas text check (char_length(notas) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('income', 'expense')),
  escopo text not null default 'empresa' check (escopo in ('empresa', 'pessoal')),
  descricao text not null check (char_length(descricao) between 1 and 200),
  client_id uuid references public.clients(id) on delete set null,
  sale_id uuid references public.sales(id) on delete set null,
  client_service_id uuid references public.client_services(id) on delete set null,
  debt_id uuid references public.debts(id) on delete cascade,
  category_id uuid references public.financial_categories(id),
  account_id uuid references public.financial_accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'partial', 'paid', 'cancelled')),
  parcela_num integer,
  parcela_total integer,
  billing_period text,
  recorrente_fixa boolean not null default false,
  notas text check (char_length(notas) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (paid_amount <= amount),
  unique (client_service_id, billing_period)
);
create index if not exists financial_entries_due on public.financial_entries (status, due_date);
create index if not exists financial_entries_client on public.financial_entries (client_id);
create index if not exists financial_entries_sale on public.financial_entries (sale_id);
create index if not exists financial_entries_debt on public.financial_entries (debt_id);

create table if not exists public.financial_payments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.financial_entries(id) on delete cascade,
  account_id uuid references public.financial_accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  payment_method text check (char_length(payment_method) <= 40),
  paid_at date not null default public.hoje_br(),
  notes text check (char_length(notes) <= 500),
  reversed boolean not null default false,
  reversed_at timestamptz,
  reverse_reason text check (char_length(reverse_reason) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists financial_payments_entry on public.financial_payments (entry_id);
create index if not exists financial_payments_paid on public.financial_payments (paid_at);

create table if not exists public.recurring_billing_runs (
  id uuid primary key default gen_random_uuid(),
  until_date date not null,
  created_count integer not null default 0,
  details jsonb not null default '[]'::jsonb,
  run_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 120),
  escopo text not null default 'pessoal' check (escopo in ('empresa', 'pessoal')),
  tipo text not null default 'juntar' check (tipo in ('juntar', 'quitar', 'faturar', 'mrr')),
  valor_alvo numeric(14,2) not null check (valor_alvo > 0),
  valor_atual numeric(14,2) not null default 0 check (valor_atual >= 0),
  debt_id uuid references public.debts(id) on delete set null,
  prazo date,
  status text not null default 'ativa' check (status in ('ativa', 'concluida', 'cancelada')),
  notas text check (char_length(notas) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- updated_at
do $$ declare t text; begin
  foreach t in array array['settings','clients','client_contacts','services','leads','follow_ups','sales','client_services',
                           'projects','project_tasks','debts','financial_entries','goals'] loop
    execute format('drop trigger if exists %1$s_updated on public.%1$s', t);
    execute format('create trigger %1$s_updated before update on public.%1$s for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- Regras automáticas
-- MRR: todo novo serviço recorrente, aumento, redução, pausa, cancelamento e retorno vira evento.
create or replace function public.trg_client_services_mrr() returns trigger language plpgsql as $$
declare old_mrr numeric := 0; new_mrr numeric := 0; kind text;
begin
  if tg_op = 'UPDATE' and old.status = 'active' then old_mrr := old.mrr; end if;
  if new.status = 'active' then new_mrr := new.mrr; end if;
  if old_mrr = new_mrr then return new; end if;
  if old_mrr = 0 then
    kind := case when tg_op = 'UPDATE' and old.status in ('paused', 'cancelled') then 'reactivation' else 'new' end;
  elsif new_mrr = 0 then kind := 'churn';
  elsif new_mrr > old_mrr then kind := 'expansion';
  else kind := 'contraction';
  end if;
  insert into public.mrr_events (client_service_id, client_id, tipo, previous_mrr, new_mrr, mrr_delta, effective_at, metadata)
  values (new.id, new.client_id, kind, old_mrr, new_mrr, new_mrr - old_mrr,
          case when tg_op = 'INSERT' then least(new.started_at, public.hoje_br())
               when kind = 'churn' and new.ended_at is not null then new.ended_at else public.hoje_br() end,
          jsonb_build_object('descricao', new.descricao, 'status', new.status));
  return new;
end $$;
-- Serviço pausado/cancelado: cobranças futuras ainda não pagas deixam de valer.
create or replace function public.trg_client_services_stop() returns trigger language plpgsql as $$
declare v_min date;
begin
  if new.status <> 'active' and old.status = 'active' then
    update public.financial_entries set status = 'cancelled'
    where client_service_id = new.id and status = 'pending' and paid_amount = 0
      and due_date > coalesce(new.ended_at, public.hoje_br());
  end if;
  if new.status = 'active' and old.status <> 'active' then
    select min(due_date) into v_min from public.financial_entries
      where client_service_id = new.id and status = 'cancelled' and paid_amount = 0 and due_date >= public.hoje_br();
    delete from public.financial_entries
      where client_service_id = new.id and status = 'cancelled' and paid_amount = 0 and due_date >= public.hoje_br();
    new.next_billing_date := greatest(public.hoje_br(), coalesce(least(v_min, new.next_billing_date), v_min, new.next_billing_date, public.hoje_br()));
    new.ended_at := null;
  end if;
  return new;
end $$;
drop trigger if exists client_services_stop on public.client_services;
create trigger client_services_stop before update on public.client_services
  for each row execute function public.trg_client_services_stop();
drop trigger if exists client_services_mrr on public.client_services;
create trigger client_services_mrr after insert or update on public.client_services
  for each row execute function public.trg_client_services_mrr();

-- Progresso do projeto = tarefas concluídas / total (100% não conclui o projeto sozinho).
create or replace function public.trg_project_progress() returns trigger language plpgsql as $$
declare pid uuid := coalesce(new.project_id, old.project_id);
begin
  update public.projects p set progress = coalesce((
    select round(100.0 * count(*) filter (where completed) / nullif(count(*), 0))::int
    from public.project_tasks where project_id = pid), 0)
  where p.id = pid;
  if tg_op = 'UPDATE' and old.project_id <> new.project_id then
    update public.projects p set progress = coalesce((
      select round(100.0 * count(*) filter (where completed) / nullif(count(*), 0))::int
      from public.project_tasks where project_id = old.project_id), 0) where p.id = old.project_id;
  end if;
  return null;
end $$;
drop trigger if exists project_tasks_progress on public.project_tasks;
create trigger project_tasks_progress after insert or update or delete on public.project_tasks
  for each row execute function public.trg_project_progress();

-- Lead: registra criação e mantém a data do próximo follow-up.
create or replace function public.trg_lead_created() returns trigger language plpgsql as $$
begin
  insert into public.lead_activities (lead_id, tipo, descricao) values (new.id, 'criado', 'Lead cadastrado');
  return null;
end $$;
drop trigger if exists leads_created on public.leads;
create trigger leads_created after insert on public.leads for each row execute function public.trg_lead_created();

create or replace function public.trg_follow_up_lead() returns trigger language plpgsql as $$
declare lid uuid := coalesce(new.lead_id, old.lead_id);
begin
  if lid is not null then
    update public.leads set next_follow_up_at = (
      select min(due_at) from public.follow_ups where lead_id = lid and status = 'pending') where id = lid;
    if tg_op = 'INSERT' then
      insert into public.lead_activities (lead_id, tipo, descricao, metadata)
      values (lid, 'follow_up', 'Agendado: ' || new.titulo, jsonb_build_object('follow_up_id', new.id, 'due_at', new.due_at));
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status <> 'pending' then
      insert into public.lead_activities (lead_id, tipo, descricao, metadata)
      values (lid, 'follow_up', (case new.status when 'done' then 'Concluído: ' else 'Cancelado: ' end) || new.titulo,
              jsonb_build_object('follow_up_id', new.id));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists follow_ups_lead on public.follow_ups;
create trigger follow_ups_lead after insert or update or delete on public.follow_ups
  for each row execute function public.trg_follow_up_lead();

create or replace function public.trg_follow_up_done() returns trigger language plpgsql as $$
begin
  if new.status = 'done' and old.status <> 'done' then new.completed_at := now(); end if;
  if new.status = 'pending' then new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists follow_ups_done on public.follow_ups;
create trigger follow_ups_done before update on public.follow_ups for each row execute function public.trg_follow_up_done();

create or replace function public.trg_project_done() returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status <> 'completed' then new.completed_at := now(); end if;
  if new.status <> 'completed' then new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists projects_done on public.projects;
create trigger projects_done before update on public.projects for each row execute function public.trg_project_done();

-- Título financeiro: valor não pode ficar abaixo do que já foi pago; status acompanha.
create or replace function public.trg_entry_guard() returns trigger language plpgsql as $$
begin
  if new.status <> 'cancelled' then
    new.status := case when new.paid_amount = 0 then 'pending' when new.paid_amount >= new.amount then 'paid' else 'partial' end;
  elsif new.paid_amount > 0 then
    raise exception 'Este título já tem pagamento. Estorne os pagamentos antes de cancelar.';
  end if;
  return new;
end $$;
drop trigger if exists financial_entries_guard on public.financial_entries;
create trigger financial_entries_guard before insert or update on public.financial_entries
  for each row execute function public.trg_entry_guard();

-- ---------------------------------------------------------------- Funções (operações atômicas)
create or replace function public.split_amount(total numeric, n integer) returns numeric[] language plpgsql immutable as $$
declare cents bigint := round(total * 100); base bigint; rest bigint; result numeric[] := '{}'; i integer;
begin
  if n < 1 then raise exception 'Número de parcelas inválido.'; end if;
  base := cents / n; rest := cents % n;
  for i in 1..n loop
    result := result || ((base + case when i <= rest then 1 else 0 end)::numeric / 100);
  end loop;
  return result;
end $$;

create or replace function public.add_period(d date, per text) returns date language sql immutable as $$
  select (d + case per when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months'
                       when 'semiannual' then interval '6 months' when 'yearly' then interval '1 year' end)::date
$$;

create or replace function public.category_id(p_nome text, p_tipo text, p_escopo text) returns uuid language sql stable as $$
  select id from public.financial_categories where nome = p_nome and tipo = p_tipo and escopo = p_escopo limit 1
$$;

-- Move o lead no funil e registra atividade (ganho/perdido pelas flags da etapa).
create or replace function public.move_lead(p_lead uuid, p_stage uuid, p_reason text default null, p_posicao integer default null)
returns jsonb language plpgsql as $$
declare l public.leads; s_old public.pipeline_stages; s_new public.pipeline_stages;
begin
  select * into l from public.leads where id = p_lead for update;
  if not found then raise exception 'Lead não encontrado.'; end if;
  select * into s_new from public.pipeline_stages where id = p_stage and ativo;
  if not found then raise exception 'Etapa não encontrada.'; end if;
  select * into s_old from public.pipeline_stages where id = l.stage_id;
  if l.converted_sale_id is not null and not s_new.is_won then
    raise exception 'Lead já convertido em venda; não volta no funil.';
  end if;
  if s_new.is_lost and coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo da perda.'; end if;
  update public.leads set stage_id = p_stage, posicao = coalesce(p_posicao, posicao),
    won_at = case when s_new.is_won then coalesce(won_at, now()) else null end,
    lost_at = case when s_new.is_lost then now() else null end,
    lost_reason = case when s_new.is_lost then p_reason else null end
  where id = p_lead;
  if s_old.id is distinct from s_new.id then
    insert into public.lead_activities (lead_id, tipo, descricao, metadata)
    values (p_lead, case when s_new.is_won then 'ganho' when s_new.is_lost then 'perdido' else 'etapa' end,
            s_old.nome || ' → ' || s_new.nome,
            jsonb_build_object('de', s_old.id, 'para', s_new.id, 'motivo', p_reason));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Venda completa numa operação só: cliente, contato, itens, serviços recorrentes, parcelas e lead convertido.
create or replace function public.create_sale(p jsonb) returns jsonb language plpgsql as $$
declare
  v_key text := nullif(p->>'idempotency_key', '');
  v_existing public.sales; v_sale public.sales; v_lead public.leads; v_stage public.pipeline_stages;
  v_client uuid := nullif(p->>'client_id', '')::uuid;
  v_date date := coalesce(nullif(p->>'data_venda', '')::date, public.hoje_br());
  v_first date := coalesce(nullif(p->>'primeiro_vencimento', '')::date, v_date);
  v_rec_first date := coalesce(nullif(p->>'primeira_cobranca_recorrente', '')::date, v_first);
  v_n integer := coalesce(nullif(p->>'parcelas', '')::int, 1);
  v_item jsonb; v_total numeric := 0; v_one numeric := 0; v_mrr numeric := 0; v_line numeric;
  v_amounts numeric[]; v_custom jsonb := p->'parcelas_custom'; v_cat uuid; i integer; v_entry uuid;
  v_account uuid := nullif(p->>'account_id', '')::uuid; v_per text;
begin
  if v_key is not null then
    select * into v_existing from public.sales where idempotency_key = v_key;
    if found then return jsonb_build_object('sale_id', v_existing.id, 'numero', v_existing.numero, 'repetido', true); end if;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Inclua pelo menos um item na venda.';
  end if;
  if v_n < 1 or v_n > 24 then raise exception 'Parcelas: de 1 a 24.'; end if;

  if nullif(p->>'lead_id', '') is not null then
    select * into v_lead from public.leads where id = (p->>'lead_id')::uuid for update;
    if not found then raise exception 'Lead não encontrado.'; end if;
    if v_lead.converted_sale_id is not null then raise exception 'Este lead já virou venda.'; end if;
    select * into v_stage from public.pipeline_stages where id = v_lead.stage_id;
    if not v_stage.is_won then raise exception 'Só lead ganho pode ser convertido. Mova para a etapa de ganho antes.'; end if;
    v_client := coalesce(v_client, v_lead.client_id);
  end if;

  if v_client is null then
    if coalesce(trim(p->'new_client'->>'nome'), '') = '' then raise exception 'Escolha um cliente ou informe o nome do novo cliente.'; end if;
    insert into public.clients (nome, tipo, documento, email, telefone, cidade, segmento, origem)
    values (trim(p->'new_client'->>'nome'), coalesce(nullif(p->'new_client'->>'tipo', ''), 'pj'),
            nullif(p->'new_client'->>'documento', ''), nullif(p->'new_client'->>'email', ''),
            nullif(p->'new_client'->>'telefone', ''), nullif(p->'new_client'->>'cidade', ''),
            nullif(p->'new_client'->>'segmento', ''), nullif(p->'new_client'->>'origem', ''))
    returning id into v_client;
  elsif not exists (select 1 from public.clients where id = v_client) then
    raise exception 'Cliente não encontrado.';
  end if;

  if coalesce(trim(p->'contact'->>'nome'), '') <> '' then
    insert into public.client_contacts (client_id, nome, email, telefone, cargo, principal)
    values (v_client, trim(p->'contact'->>'nome'), nullif(p->'contact'->>'email', ''), nullif(p->'contact'->>'telefone', ''),
            nullif(p->'contact'->>'cargo', ''), not exists (select 1 from public.client_contacts where client_id = v_client and principal));
  end if;

  for v_item in select * from jsonb_array_elements(p->'items') loop
    v_per := coalesce(nullif(v_item->>'periodicidade', ''), 'one_time');
    v_line := round(coalesce((v_item->>'quantidade')::numeric, 1) * (v_item->>'preco_unit')::numeric, 2);
    if v_line < 0 then raise exception 'Valor de item inválido.'; end if;
    v_total := v_total + v_line;
    if v_per = 'one_time' then v_one := v_one + v_line;
    else v_mrr := v_mrr + case v_per when 'monthly' then v_line when 'quarterly' then round(v_line / 3, 2)
                                   when 'semiannual' then round(v_line / 6, 2) else round(v_line / 12, 2) end;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'A venda precisa ter valor.'; end if;

  insert into public.sales (client_id, lead_id, data_venda, total, total_avulso, mrr_novo, parcelas, forma_pagamento, origem, notas, idempotency_key)
  values (v_client, v_lead.id, v_date, v_total, v_one, v_mrr,
          case when jsonb_typeof(v_custom) = 'array' and jsonb_array_length(v_custom) > 0 then jsonb_array_length(v_custom) else v_n end,
          nullif(p->>'forma_pagamento', ''), coalesce(nullif(p->>'origem', ''), v_lead.origem), nullif(p->>'notas', ''), v_key)
  returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p->'items') loop
    v_per := coalesce(nullif(v_item->>'periodicidade', ''), 'one_time');
    v_line := round(coalesce((v_item->>'quantidade')::numeric, 1) * (v_item->>'preco_unit')::numeric, 2);
    insert into public.sale_items (sale_id, service_id, descricao, quantidade, preco_unit, total, periodicidade)
    values (v_sale.id, nullif(v_item->>'service_id', '')::uuid, v_item->>'descricao',
            coalesce((v_item->>'quantidade')::numeric, 1), (v_item->>'preco_unit')::numeric, v_line, v_per);
    if v_per <> 'one_time' then
      insert into public.client_services (client_id, service_id, sale_id, descricao, valor, periodicidade, started_at, next_billing_date)
      values (v_client, nullif(v_item->>'service_id', '')::uuid, v_sale.id, v_item->>'descricao', v_line, v_per, v_date, v_rec_first);
    end if;
  end loop;

  if v_one > 0 then
    v_cat := public.category_id('Projetos e serviços', 'income', 'empresa');
    if jsonb_typeof(v_custom) = 'array' and jsonb_array_length(v_custom) > 0 then
      if (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_custom) x) <> v_one then
        raise exception 'A soma das parcelas (%) precisa fechar com o valor avulso da venda (%).',
          (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_custom) x), v_one;
      end if;
      i := 0;
      for v_item in select * from jsonb_array_elements(v_custom) loop
        i := i + 1;
        insert into public.financial_entries (tipo, escopo, descricao, client_id, sale_id, category_id, account_id, amount, due_date, parcela_num, parcela_total)
        values ('income', 'empresa', v_sale.numero || ' — parcela ' || i || '/' || jsonb_array_length(v_custom), v_client, v_sale.id, v_cat, v_account,
                (v_item->>'amount')::numeric, (v_item->>'due_date')::date, i, jsonb_array_length(v_custom));
      end loop;
    else
      v_amounts := public.split_amount(v_one, v_n);
      for i in 1..v_n loop
        insert into public.financial_entries (tipo, escopo, descricao, client_id, sale_id, category_id, account_id, amount, due_date, parcela_num, parcela_total)
        values ('income', 'empresa', v_sale.numero || ' — parcela ' || i || '/' || v_n, v_client, v_sale.id, v_cat, v_account,
                v_amounts[i], (v_first + ((i - 1) || ' months')::interval)::date, i, v_n)
        returning id into v_entry;
      end loop;
    end if;
  end if;

  if v_lead.id is not null then
    update public.leads set converted_client_id = v_client, converted_sale_id = v_sale.id, client_id = v_client where id = v_lead.id;
    insert into public.lead_activities (lead_id, tipo, descricao, metadata)
    values (v_lead.id, 'convertido', 'Convertido na venda ' || v_sale.numero, jsonb_build_object('sale_id', v_sale.id));
  end if;
  return jsonb_build_object('sale_id', v_sale.id, 'numero', v_sale.numero, 'client_id', v_client);
end $$;

create or replace function public.cancel_sale(p_sale uuid, p_reason text default null) returns jsonb language plpgsql as $$
declare s public.sales; n_entries integer; n_services integer;
begin
  select * into s from public.sales where id = p_sale for update;
  if not found then raise exception 'Venda não encontrada.'; end if;
  if s.status = 'cancelled' then return jsonb_build_object('ok', true, 'repetido', true); end if;
  update public.sales set status = 'cancelled', cancelled_at = now(),
    notas = concat_ws(E'\n', notas, 'Cancelada: ' || coalesce(p_reason, 'sem motivo informado')) where id = p_sale;
  update public.financial_entries set status = 'cancelled' where sale_id = p_sale and paid_amount = 0 and status = 'pending';
  get diagnostics n_entries = row_count;
  update public.client_services set status = 'cancelled', ended_at = public.hoje_br() where sale_id = p_sale and status <> 'cancelled';
  get diagnostics n_services = row_count;
  return jsonb_build_object('ok', true, 'titulos_cancelados', n_entries, 'servicos_cancelados', n_services);
end $$;

-- Baixa (total ou parcial) de um título. Nunca aceita mais do que o saldo.
create or replace function public.settle_entry(p jsonb) returns jsonb language plpgsql as $$
declare e public.financial_entries; v_amount numeric := round((p->>'amount')::numeric, 2); v_pay uuid;
begin
  select * into e from public.financial_entries where id = (p->>'entry_id')::uuid for update;
  if not found then raise exception 'Título não encontrado.'; end if;
  if e.status = 'cancelled' then raise exception 'Título cancelado não recebe pagamento.'; end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Informe um valor positivo.'; end if;
  if v_amount > e.amount - e.paid_amount then
    raise exception 'Valor maior que o saldo em aberto (R$ %).', replace(to_char(e.amount - e.paid_amount, 'FM999999990.00'), '.', ',');
  end if;
  insert into public.financial_payments (entry_id, account_id, amount, payment_method, paid_at, notes)
  values (e.id, coalesce(nullif(p->>'account_id', '')::uuid, e.account_id), v_amount, nullif(p->>'payment_method', ''),
          coalesce(nullif(p->>'paid_at', '')::date, public.hoje_br()), nullif(p->>'notes', ''))
  returning id into v_pay;
  update public.financial_entries set paid_amount = paid_amount + v_amount where id = e.id;
  if e.debt_id is not null and not exists (select 1 from public.financial_entries
      where debt_id = e.debt_id and status in ('pending', 'partial')) then
    update public.debts set status = 'quitada' where id = e.debt_id;
  end if;
  return jsonb_build_object('ok', true, 'payment_id', v_pay);
end $$;

create or replace function public.reverse_payment(p_payment uuid, p_reason text) returns jsonb language plpgsql as $$
declare pay public.financial_payments; e public.financial_entries;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo do estorno.'; end if;
  select * into pay from public.financial_payments where id = p_payment for update;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  if pay.reversed then raise exception 'Pagamento já estornado.'; end if;
  select * into e from public.financial_entries where id = pay.entry_id for update;
  update public.financial_payments set reversed = true, reversed_at = now(), reverse_reason = p_reason where id = p_payment;
  update public.financial_entries set paid_amount = paid_amount - pay.amount where id = pay.entry_id;
  if e.debt_id is not null then update public.debts set status = 'ativa' where id = e.debt_id and status = 'quitada'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Lançamento avulso já pago (entrada ou saída na hora).
create or replace function public.quick_entry(p jsonb) returns jsonb language plpgsql as $$
declare v_entry uuid; v_date date := coalesce(nullif(p->>'paid_at', '')::date, public.hoje_br());
begin
  insert into public.financial_entries (tipo, escopo, descricao, client_id, category_id, account_id, amount, due_date, notas)
  values (p->>'tipo', coalesce(nullif(p->>'escopo', ''), 'empresa'), p->>'descricao', nullif(p->>'client_id', '')::uuid,
          nullif(p->>'category_id', '')::uuid, nullif(p->>'account_id', '')::uuid, (p->>'amount')::numeric, v_date, nullif(p->>'notas', ''))
  returning id into v_entry;
  perform public.settle_entry(jsonb_build_object('entry_id', v_entry, 'amount', p->>'amount', 'paid_at', v_date,
                              'account_id', p->>'account_id', 'payment_method', p->>'payment_method'));
  return jsonb_build_object('ok', true, 'entry_id', v_entry);
end $$;

-- Gera as cobranças dos serviços recorrentes até a data. Pode rodar quantas vezes quiser: não duplica.
create or replace function public.generate_recurring_billing(p_until date default null) returns jsonb language plpgsql as $$
declare v_until date := coalesce(p_until, public.hoje_br() + 30); s public.client_services; v_next date; v_loops integer;
        v_count integer := 0; v_details jsonb := '[]'; v_new uuid; v_cat uuid := public.category_id('Mensalidades', 'income', 'empresa');
begin
  for s in select * from public.client_services where status = 'active' and periodicidade <> 'one_time'
             and next_billing_date is not null and next_billing_date <= v_until for update loop
    v_next := greatest(s.next_billing_date, s.started_at); v_loops := 0;
    while v_next <= v_until and (s.ended_at is null or v_next <= s.ended_at) and v_loops < 24 loop
      v_new := null;
      insert into public.financial_entries (tipo, escopo, descricao, client_id, client_service_id, category_id, amount, due_date, billing_period)
      values ('income', 'empresa', s.descricao || ' — ' || to_char(v_next, 'MM/YYYY'), s.client_id, s.id, v_cat, s.valor, v_next,
              to_char(v_next, 'YYYY-MM-DD'))
      on conflict (client_service_id, billing_period) do nothing returning id into v_new;
      if v_new is not null then
        v_count := v_count + 1;
        v_details := v_details || jsonb_build_object('servico', s.descricao, 'vencimento', v_next, 'valor', s.valor);
      end if;
      v_next := public.add_period(v_next, s.periodicidade); v_loops := v_loops + 1;
    end loop;
    update public.client_services set next_billing_date = v_next where id = s.id;
  end loop;
  insert into public.recurring_billing_runs (until_date, created_count, details) values (v_until, v_count, v_details);
  return jsonb_build_object('ok', true, 'criadas', v_count, 'ate', v_until, 'detalhes', v_details);
end $$;

-- Dívida parcelada (carro, empréstimo, cartão parcelado...): gera um título por parcela restante.
create or replace function public.create_debt(p jsonb) returns jsonb language plpgsql as $$
declare d public.debts; v_rest integer := (p->>'parcelas_restantes')::int; v_first date := (p->>'proximo_vencimento')::date;
        v_paid integer := coalesce(nullif(p->>'parcelas_pagas', '')::int, 0); i integer;
        v_total integer := coalesce(nullif(p->>'total_parcelas', '')::int, v_paid + v_rest);
        v_escopo text := coalesce(nullif(p->>'escopo', ''), 'pessoal');
begin
  if v_rest is null or v_rest < 1 or v_rest > 600 then raise exception 'Informe quantas parcelas faltam.'; end if;
  if v_first is null then raise exception 'Informe o vencimento da próxima parcela.'; end if;
  if v_paid + v_rest > v_total then raise exception 'Pagas + restantes passa do total de parcelas.'; end if;
  insert into public.debts (nome, escopo, credor, valor_parcela, total_parcelas, parcelas_pagas_antes, dia_vencimento, category_id, account_id, notas)
  values (p->>'nome', v_escopo, nullif(p->>'credor', ''), (p->>'valor_parcela')::numeric, v_total, v_total - v_rest,
          extract(day from v_first)::int, nullif(p->>'category_id', '')::uuid, nullif(p->>'account_id', '')::uuid, nullif(p->>'notas', ''))
  returning * into d;
  for i in 1..v_rest loop
    insert into public.financial_entries (tipo, escopo, descricao, debt_id, category_id, account_id, amount, due_date, parcela_num, parcela_total)
    values ('expense', v_escopo, d.nome || ' — parcela ' || (d.parcelas_pagas_antes + i) || '/' || v_total, d.id, d.category_id, d.account_id,
            d.valor_parcela, (v_first + ((i - 1) || ' months')::interval)::date, d.parcelas_pagas_antes + i, v_total);
  end loop;
  return jsonb_build_object('ok', true, 'debt_id', d.id);
end $$;

-- Conta fixa mensal (aluguel, internet, faculdade...): gera os próximos N meses.
create or replace function public.create_recurring_expense(p jsonb) returns jsonb language plpgsql as $$
declare v_first date := (p->>'primeiro_vencimento')::date; v_n integer := coalesce(nullif(p->>'meses', '')::int, 12); i integer;
begin
  if v_first is null then raise exception 'Informe o primeiro vencimento.'; end if;
  if v_n < 1 or v_n > 36 then raise exception 'Meses: de 1 a 36.'; end if;
  for i in 1..v_n loop
    insert into public.financial_entries (tipo, escopo, descricao, category_id, account_id, amount, due_date, recorrente_fixa, notas)
    values (coalesce(nullif(p->>'tipo', ''), 'expense'), coalesce(nullif(p->>'escopo', ''), 'pessoal'),
            (p->>'descricao') || ' — ' || to_char((v_first + ((i - 1) || ' months')::interval)::date, 'MM/YYYY'),
            nullif(p->>'category_id', '')::uuid, nullif(p->>'account_id', '')::uuid, (p->>'amount')::numeric,
            (v_first + ((i - 1) || ' months')::interval)::date, true, nullif(p->>'notas', ''));
  end loop;
  return jsonb_build_object('ok', true, 'criados', v_n);
end $$;

-- Converte um contato do formulário do site em lead do funil.
create or replace function public.site_lead_to_pipeline(p_site uuid) returns jsonb language plpgsql as $$
declare s record; v_stage uuid; v_lead uuid;
begin
  select * into s from public.crm_leads where id = p_site for update;
  if not found then raise exception 'Contato do site não encontrado.'; end if;
  select id into v_lead from public.leads where site_lead_id = p_site;
  if v_lead is not null then return jsonb_build_object('lead_id', v_lead, 'repetido', true); end if;
  select id into v_stage from public.pipeline_stages where ativo and not is_won and not is_lost order by posicao limit 1;
  insert into public.leads (empresa, contato, whatsapp, email, origem, servico_interesse, stage_id, notas, site_lead_id)
  values (coalesce(nullif(s.empresa, ''), s.nome), s.nome,
          case when s.contato like '%@%' then null else s.contato end,
          case when s.contato like '%@%' then s.contato else null end,
          'Site', s.interesse, v_stage, s.mensagem, p_site)
  returning id into v_lead;
  update public.crm_leads set status = 'convertido', atualizado_em = now() where id = p_site;
  return jsonb_build_object('lead_id', v_lead);
end $$;

-- ---------------------------------------------------------------- Visões (as mesmas contas em todas as telas)
create or replace view public.v_entries as
select e.*, round(e.amount - e.paid_amount, 2) as open_amount,
  (e.status in ('pending', 'partial') and e.due_date < public.hoje_br()) as overdue,
  case when e.status not in ('pending', 'partial') then null
       when e.due_date >= public.hoje_br() then 'a_vencer'
       when public.hoje_br() - e.due_date <= 7 then '1-7'
       when public.hoje_br() - e.due_date <= 30 then '8-30'
       when public.hoje_br() - e.due_date <= 60 then '31-60' else '60+' end as aging,
  c.nome as client_nome, cat.nome as category_nome, a.nome as account_nome, s.numero as sale_numero, d.nome as debt_nome
from public.financial_entries e
left join public.clients c on c.id = e.client_id
left join public.financial_categories cat on cat.id = e.category_id
left join public.financial_accounts a on a.id = e.account_id
left join public.sales s on s.id = e.sale_id
left join public.debts d on d.id = e.debt_id;

create or replace view public.v_payments as
select p.*, e.tipo, e.escopo, e.descricao, e.client_id, e.category_id, c.nome as client_nome, a.nome as account_nome,
       cat.nome as category_nome
from public.financial_payments p
join public.financial_entries e on e.id = p.entry_id
left join public.clients c on c.id = e.client_id
left join public.financial_accounts a on a.id = p.account_id
left join public.financial_categories cat on cat.id = e.category_id;

create or replace view public.v_account_balances as
select a.*, a.opening_balance
  + coalesce(sum(case when e.tipo = 'income' then p.amount else -p.amount end) filter (where not p.reversed), 0) as saldo
from public.financial_accounts a
left join public.financial_payments p on p.account_id = a.id
left join public.financial_entries e on e.id = p.entry_id
group by a.id;

create or replace view public.v_client_mrr as
select c.id as client_id, c.nome, coalesce(sum(s.mrr) filter (where s.status = 'active'), 0) as mrr,
       count(s.id) filter (where s.status = 'active' and s.periodicidade <> 'one_time') as servicos_ativos
from public.clients c left join public.client_services s on s.client_id = c.id
group by c.id, c.nome;

create or replace view public.v_mrr_summary as
select coalesce(sum(mrr), 0) as mrr, coalesce(sum(mrr), 0) * 12 as arr,
       count(*) filter (where mrr > 0) as clientes_recorrentes,
       case when count(*) filter (where mrr > 0) > 0 then round(sum(mrr) / count(*) filter (where mrr > 0), 2) else 0 end as ticket_medio
from public.v_client_mrr;

create or replace view public.v_debts as
select d.*, coalesce(sum(e.amount - e.paid_amount) filter (where e.status in ('pending', 'partial')), 0) as restante_valor,
       count(e.id) filter (where e.status in ('pending', 'partial')) as parcelas_restantes,
       count(e.id) filter (where e.status = 'paid') + d.parcelas_pagas_antes as parcelas_pagas,
       min(e.due_date) filter (where e.status in ('pending', 'partial')) as proximo_vencimento,
       coalesce(sum(e.paid_amount), 0) as pago_no_crm
from public.debts d left join public.financial_entries e on e.debt_id = d.id
group by d.id;

create or replace view public.v_leads as
select l.*, s.nome as stage_nome, s.is_won, s.is_lost, s.posicao as stage_posicao, c.nome as client_nome
from public.leads l join public.pipeline_stages s on s.id = l.stage_id left join public.clients c on c.id = l.client_id;

create or replace view public.v_sales as
select s.*, c.nome as client_nome,
  coalesce((select sum(e.paid_amount) from public.financial_entries e where e.sale_id = s.id), 0) as recebido,
  coalesce((select sum(e.amount - e.paid_amount) from public.financial_entries e where e.sale_id = s.id and e.status in ('pending', 'partial')), 0) as em_aberto
from public.sales s join public.clients c on c.id = s.client_id;

create or replace view public.v_projects as
select p.*, c.nome as client_nome, coalesce(p.due_date < public.hoje_br() and p.status not in ('completed', 'cancelled', 'published'), false) as atrasado,
  (select count(*) from public.project_tasks t where t.project_id = p.id) as tarefas_total,
  (select count(*) from public.project_tasks t where t.project_id = p.id and t.completed) as tarefas_feitas
from public.projects p join public.clients c on c.id = p.client_id;

create or replace view public.v_follow_ups as
select f.*, l.empresa as lead_empresa, c.nome as client_nome,
  (f.status = 'pending' and f.due_at < now()) as atrasado,
  (f.status = 'pending' and (f.due_at at time zone 'America/Sao_Paulo')::date = public.hoje_br()) as hoje
from public.follow_ups f left join public.leads l on l.id = f.lead_id left join public.clients c on c.id = f.client_id;

create or replace view public.v_client_services as
select s.*, c.nome as client_nome from public.client_services s join public.clients c on c.id = s.client_id;

create or replace view public.v_clients as
select c.*, coalesce(m.mrr, 0) as mrr,
  coalesce((select sum(e.amount - e.paid_amount) from public.financial_entries e
            where e.client_id = c.id and e.tipo = 'income' and e.status in ('pending', 'partial')), 0) as a_receber,
  coalesce((select sum(e.amount - e.paid_amount) from public.financial_entries e
            where e.client_id = c.id and e.tipo = 'income' and e.status in ('pending', 'partial') and e.due_date < public.hoje_br()), 0) as vencido,
  (select cc.nome from public.client_contacts cc where cc.client_id = c.id and cc.principal limit 1) as contato_principal
from public.clients c left join public.v_client_mrr m on m.client_id = c.id;

-- ---------------------------------------------------------------- Segurança
do $$ declare t text; begin
  foreach t in array array['settings','clients','client_contacts','client_notes','services','pipeline_stages','leads','lead_activities',
                           'follow_ups','sales','sale_items','client_services','mrr_events','projects','project_tasks',
                           'financial_accounts','financial_categories','debts','financial_entries','financial_payments',
                           'recurring_billing_runs','goals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
  foreach t in array array['v_entries','v_payments','v_account_balances','v_client_mrr','v_mrr_summary','v_debts','v_leads',
                           'v_sales','v_projects','v_follow_ups','v_client_services','v_clients'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;
revoke all on sequence public.sale_number_seq from anon, authenticated;
grant usage, select on sequence public.sale_number_seq to service_role;

do $$ declare f text; begin
  foreach f in array array['move_lead(uuid,uuid,text,integer)','create_sale(jsonb)','cancel_sale(uuid,text)','settle_entry(jsonb)',
                           'reverse_payment(uuid,text)','quick_entry(jsonb)','generate_recurring_billing(date)','create_debt(jsonb)',
                           'create_recurring_expense(jsonb)','site_lead_to_pipeline(uuid)','split_amount(numeric,integer)',
                           'add_period(date,text)','category_id(text,text,text)','hoje_br()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- Estrutura padrão (só cria se estiver vazio)
insert into public.pipeline_stages (nome, posicao, cor, is_won, is_lost)
select * from (values ('Novo lead', 1, '#8A8A84', false, false), ('Contato feito', 2, '#6B7F99', false, false),
  ('Diagnóstico', 3, '#7A6B99', false, false), ('Proposta enviada', 4, '#99856B', false, false),
  ('Negociação', 5, '#B08A2E', false, false), ('Ganho', 6, '#4E7A2E', true, false), ('Perdido', 7, '#9A3B3B', false, true)) v
where not exists (select 1 from public.pipeline_stages);

insert into public.financial_categories (nome, tipo, escopo) values
  ('Projetos e serviços', 'income', 'empresa'), ('Mensalidades', 'income', 'empresa'), ('Outras receitas', 'income', 'empresa'),
  ('Ferramentas e software', 'expense', 'empresa'), ('Anúncios', 'expense', 'empresa'), ('Impostos e taxas', 'expense', 'empresa'),
  ('Freelancers e terceiros', 'expense', 'empresa'), ('Equipamentos', 'expense', 'empresa'), ('Retirada para o pessoal', 'expense', 'empresa'),
  ('Outras despesas', 'expense', 'empresa'),
  ('Retirada da GRAVV', 'income', 'pessoal'), ('Salário / loja', 'income', 'pessoal'), ('Outras entradas', 'income', 'pessoal'),
  ('Carro', 'expense', 'pessoal'), ('Moradia', 'expense', 'pessoal'), ('Alimentação', 'expense', 'pessoal'),
  ('Transporte', 'expense', 'pessoal'), ('Faculdade', 'expense', 'pessoal'), ('Cartão de crédito', 'expense', 'pessoal'),
  ('Assinaturas', 'expense', 'pessoal'), ('Lazer', 'expense', 'pessoal'), ('Empréstimos e parcelas', 'expense', 'pessoal'),
  ('Outras despesas', 'expense', 'pessoal')
on conflict (nome, tipo, escopo) do nothing;

insert into public.financial_accounts (nome, tipo, escopo)
select * from (values ('Conta GRAVV', 'banco', 'empresa'), ('Conta pessoal', 'banco', 'pessoal')) v
where not exists (select 1 from public.financial_accounts);

insert into public.services (nome, periodicidade, descricao)
select * from (values ('Site institucional', 'one_time', 'Criação de site'), ('Landing page', 'one_time', 'Página de venda/captação'),
  ('Loja virtual', 'one_time', 'E-commerce'), ('CRM / automação', 'one_time', 'Sistema sob medida'),
  ('Pacote de criativos', 'one_time', 'Artes e vídeos para anúncios'),
  ('Gestão de tráfego', 'monthly', 'Gestão mensal de anúncios'), ('Manutenção de site/CRM', 'monthly', 'Suporte e ajustes mensais'),
  ('Social media', 'monthly', 'Conteúdo mensal')) v
where not exists (select 1 from public.services);

insert into public.settings (key, value) values
  ('agencia', '{"nome": "GRAVV", "moeda": "BRL", "locale": "pt-BR", "timezone": "America/Sao_Paulo"}'),
  ('metas', '{"mrr_meta": null, "faturamento_meta": null}')
on conflict (key) do nothing;
