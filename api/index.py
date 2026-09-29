"""API do CRM GRAVV online (Vercel + Supabase) — versão 2.

Clientes, comercial (funil, follow-ups, vendas), projetos, financeiro (empresa e pessoal), MRR,
leads do site e WhatsApp. Os dados ficam em tabelas do Supabase; as regras que mexem em dinheiro
rodam dentro do banco (funções SQL atômicas). Esta API só autentica, confere e repassa.

Variáveis de ambiente (configurar na Vercel, nunca no código):
  SUPABASE_URL          https://xxxx.supabase.co
  SUPABASE_SECRET_KEY   chave secreta (sb_secret_...) ou service_role do projeto
  OWNER_EMAILS          e-mails autorizados a entrar, separados por vírgula
  SITE_ORIGINS          (opcional) sites que podem enviar leads, separados por vírgula
  OWNER_NAME            (opcional) nome exibido no topo; padrão "Marcos"
  WHATSAPP_*            (opcional) API oficial do WhatsApp — ver seção WhatsApp abaixo
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import sys
import threading
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, parse_qsl, quote, urlencode, urlsplit
from urllib.request import Request, urlopen

BRASILIA = timezone(timedelta(hours=-3))  # Brasil sem horário de verão desde 2019.
LEAD_STATUSES = frozenset(('novo', 'convertido', 'arquivado'))
DEFAULT_SITE_ORIGINS = ('https://gravv-studios.vercel.app', 'https://gravv.com.br', 'https://www.gravv.com.br')
MAX_BODY = 262144
ACCESS_COOKIE = 'gravv_at'
REFRESH_COOKIE = 'gravv_rt'
UUID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')

# Tabelas e visões que a tela pode ler.
READ = frozenset((
    'settings', 'clients', 'client_contacts', 'client_notes', 'services', 'pipeline_stages', 'leads', 'lead_activities',
    'follow_ups', 'sales', 'sale_items', 'client_services', 'mrr_events', 'projects', 'project_tasks', 'financial_accounts',
    'financial_categories', 'debts', 'financial_entries', 'financial_payments', 'recurring_billing_runs', 'goals', 'crm_leads',
    'v_entries', 'v_payments', 'v_account_balances', 'v_client_mrr', 'v_mrr_summary', 'v_debts', 'v_leads', 'v_sales',
    'v_projects', 'v_follow_ups', 'v_client_services', 'v_clients'))
# O que pode ser gravado direto em cada tabela (o resto passa pelas funções do banco).
PROTECTED = frozenset(('id', 'created_at', 'updated_at'))
WRITE = {
    'settings': {'upsert'},
    'clients': {'insert', 'update'},
    'client_contacts': {'insert', 'update', 'delete'},
    'client_notes': {'insert', 'delete'},
    'services': {'insert', 'update'},
    'pipeline_stages': {'insert', 'update'},
    'leads': {'insert', 'update', 'delete'},
    'lead_activities': {'insert'},
    'follow_ups': {'insert', 'update', 'delete'},
    'sales': {'update'},
    'client_services': {'insert', 'update'},
    'projects': {'insert', 'update', 'delete'},
    'project_tasks': {'insert', 'update', 'delete'},
    'financial_accounts': {'insert', 'update'},
    'financial_categories': {'insert', 'update'},
    'debts': {'update'},
    'financial_entries': {'insert', 'update'},
    'goals': {'insert', 'update', 'delete'},
    'crm_leads': {'update'},
}
# Campos que só as funções do banco mudam.
LOCKED = {
    'leads': {'stage_id', 'won_at', 'lost_at', 'lost_reason', 'converted_client_id', 'converted_sale_id'},
    'financial_entries': {'paid_amount', 'sale_id', 'client_service_id', 'debt_id', 'billing_period'},
    'sales': {'numero', 'client_id', 'lead_id', 'total', 'total_avulso', 'mrr_novo', 'parcelas', 'status', 'idempotency_key', 'cancelled_at'},
    'client_services': {'mrr', 'sale_id'},
    'debts': {'valor_parcela', 'total_parcelas', 'parcelas_pagas_antes', 'escopo'},
    'projects': {'progress', 'completed_at'},
    'follow_ups': {'completed_at'},
    'crm_leads': {'nome', 'empresa', 'contato', 'interesse', 'mensagem', 'origem', 'ip_hash', 'criado_em'},
}
INSERT_ONLY_OK = {'leads': {'stage_id'}}  # na criação o lead nasce numa etapa
RPC = frozenset(('move_lead', 'create_sale', 'cancel_sale', 'settle_entry', 'reverse_payment', 'quick_entry',
                 'generate_recurring_billing', 'create_debt', 'create_recurring_expense', 'site_lead_to_pipeline'))
BACKUP_TABLES = ('settings', 'clients', 'client_contacts', 'client_notes', 'services', 'pipeline_stages', 'leads', 'lead_activities',
                 'follow_ups', 'sales', 'sale_items', 'client_services', 'mrr_events', 'projects', 'project_tasks',
                 'financial_accounts', 'financial_categories', 'debts', 'financial_entries', 'financial_payments',
                 'recurring_billing_runs', 'goals', 'crm_leads')

class RequestError(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


def env(name, default=''):
    return os.environ.get(name, default).strip()


def secret_key():
    key = env('SUPABASE_SECRET_KEY') or env('SUPABASE_SERVICE_ROLE_KEY')
    if not key or not env('SUPABASE_URL'):
        raise RequestError('CRM ainda não configurado: faltam SUPABASE_URL e SUPABASE_SECRET_KEY na Vercel.', 503)
    if not key_is_valid(key):
        raise RequestError('A chave SUPABASE_SECRET_KEY na Vercel está incompleta ou com caracteres estranhos. Copie de novo pelo botão de copiar do Supabase.', 503)
    return key


def key_is_valid(key):
    return bool(re.fullmatch(r'[A-Za-z0-9_.\-]{10,}', key or ''))


def owners():
    return {item.strip().lower() for item in env('OWNER_EMAILS').split(',') if item.strip()}


def site_origins():
    configured = [item.strip().rstrip('/') for item in env('SITE_ORIGINS').split(',') if item.strip()]
    return set(configured or DEFAULT_SITE_ORIGINS)


def today():
    return datetime.now(BRASILIA).date().isoformat()


def sign(value):
    return hmac.new(secret_key().encode(), value.encode(), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- Supabase
def supabase(method, path, body=None, headers=None, user_token=None, raw_body=None):
    key = secret_key()
    request_headers = {'apikey': key, 'Accept': 'application/json'}
    if user_token:
        request_headers['Authorization'] = 'Bearer ' + user_token
    elif key.startswith('eyJ'):
        # Chave service_role antiga (JWT). As chaves novas sb_secret_ vão só no apikey.
        request_headers['Authorization'] = 'Bearer ' + key
    data = None
    if raw_body is not None:
        data = raw_body
        request_headers['Content-Type'] = 'application/json'
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        request_headers['Content-Type'] = 'application/json'
    request_headers.update(headers or {})
    request = Request(env('SUPABASE_URL').rstrip('/') + path, data=data, method=method, headers=request_headers)
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        return exc.code, payload
    except (URLError, TimeoutError, OSError):
        raise RequestError('Banco online indisponível agora. Nada foi salvo; tente de novo em instantes.', 503)



def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RequestError(f'Campo repetido no envio: {key}.')
        result[key] = value
    return result


def db_error(status, payload, fallback='O banco recusou a operação.'):
    message = (payload or {}).get('message') if isinstance(payload, dict) else ''
    code = (payload or {}).get('code') if isinstance(payload, dict) else ''
    if code == 'P0001' and message:
        return RequestError(message, 400)  # regra de negócio escrita no banco, já em português
    if code == '23505':
        return RequestError('Esse registro já existe.', 409)
    if code == '23503':
        return RequestError('Esse registro está ligado a outros e não pode ser removido. Arquive em vez de apagar.', 409)
    if code in ('23514', '22P02', '22007', '22008', '23502', '22003', '42703'):
        return RequestError('Algum campo está vazio ou num formato inválido. Confira o formulário.', 400)
    return RequestError(fallback, 503 if status >= 500 else 400)


def check_table(table, action=None):
    if table not in READ:
        raise RequestError('Tabela não encontrada.', 404)
    if action and action not in WRITE.get(table, ()):
        raise RequestError('Essa alteração não é permitida por aqui.', 403)


def clean_row(table, data, inserting):
    if not isinstance(data, dict) or not data:
        raise RequestError('Envio sem campos.')
    blocked = PROTECTED | LOCKED.get(table, set())
    if inserting:
        blocked = blocked - INSERT_ONLY_OK.get(table, set())
    row = {}
    for key, value in data.items():
        if not isinstance(key, str) or not re.fullmatch(r'[a-z_]{1,40}', key):
            raise RequestError('Campo inválido.')
        if key in blocked:
            continue
        if isinstance(value, str):
            value = CONTROL.sub('', value).strip()
            value = value if value != '' else None
        row[key] = value
    if not row:
        raise RequestError('Nada para salvar.')
    return row


def db_read(table, query):
    check_table(table)
    params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != 'rota']
    if not any(k == 'limit' for k, _ in params):
        params.append(('limit', '5000'))
    status, data = supabase('GET', f'/rest/v1/{table}?' + urlencode(params, safe='(),.*:'))
    if status != 200:
        raise db_error(status, data, 'Não foi possível ler os dados.')
    return data


def row_id(query):
    rid = dict(parse_qsl(query)).get('id', '')
    if not UUID.fullmatch(rid):
        raise RequestError('Registro inválido.')
    return rid


def db_write(method, table, query, data):
    if method == 'POST':
        if 'upsert' in WRITE.get(table, ()):
            if not isinstance(data, dict) or not re.fullmatch(r'[a-z_]{1,60}', str(data.get('key', ''))) or 'value' not in data:
                raise RequestError('Configuração inválida.')
            status, rows = supabase('POST', f'/rest/v1/{table}?on_conflict=key', [{'key': data['key'], 'value': data['value']}],
                                    headers={'Prefer': 'resolution=merge-duplicates,return=representation'})
        else:
            check_table(table, 'insert')
            status, rows = supabase('POST', f'/rest/v1/{table}', [clean_row(table, data, True)],
                                    headers={'Prefer': 'return=representation'})
        if status not in (200, 201):
            raise db_error(status, rows, 'Não foi possível salvar.')
        return rows[0] if isinstance(rows, list) and rows else {}
    rid = row_id(query)
    if method == 'PATCH':
        check_table(table, 'update')
        status, rows = supabase('PATCH', f'/rest/v1/{table}?id=eq.{rid}', clean_row(table, data, False),
                                headers={'Prefer': 'return=representation'})
        if status != 200:
            raise db_error(status, rows, 'Não foi possível salvar.')
        if not rows:
            raise RequestError('Registro não encontrado.', 404)
        return rows[0]
    check_table(table, 'delete')
    status, rows = supabase('DELETE', f'/rest/v1/{table}?id=eq.{rid}', headers={'Prefer': 'return=representation'})
    if status != 200:
        raise db_error(status, rows, 'Não foi possível apagar.')
    return {'ok': True, 'removidos': len(rows or [])}


def db_rpc(name, data):
    if name not in RPC:
        raise RequestError('Operação não encontrada.', 404)
    if not isinstance(data, dict):
        raise RequestError('Envio inválido.')
    status, result = supabase('POST', f'/rest/v1/rpc/{name}', data)
    if status not in (200, 201):
        raise db_error(status, result, 'Não foi possível concluir a operação.')
    return result


def backup():
    return {'gerado_em': datetime.now(timezone.utc).isoformat(), 'app': 'gravv-crm', 'versao': 2,
            'tabelas': {name: db_read(name, 'limit=100000') for name in BACKUP_TABLES}}


# --------------------------------------------------------------------------- Leads
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def clean(value, label, limit, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise RequestError(f'Campo inválido: {label}.')
    value = CONTROL.sub('', value).strip()
    if required and not value:
        raise RequestError(f'Preencha o campo {label}.')
    if len(value) > limit:
        raise RequestError(f'O campo {label} ficou grande demais.')
    return value


def save_lead(data, ip):
    if not isinstance(data, dict):
        raise RequestError('Envio inválido.')
    if clean(data.get('website'), 'website', 200):
        return {'ok': True}  # armadilha para robôs: finge sucesso e não grava nada
    lead = {
        'nome': clean(data.get('nome'), 'nome', 120, True),
        'empresa': clean(data.get('empresa'), 'empresa', 160),
        'contato': clean(data.get('contato'), 'WhatsApp ou e-mail', 160, True),
        'interesse': clean(data.get('interesse'), 'interesse', 160),
        'mensagem': clean(data.get('mensagem'), 'mensagem', 2000),
        'origem': clean(data.get('origem'), 'origem', 300),
    }
    if len(lead['contato']) < 6:
        raise RequestError('Informe um WhatsApp ou e-mail válido.')
    ip_hash = sign('ip:' + (ip or 'sem-ip'))[:32]
    since = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    status, recent = supabase('GET', f'/rest/v1/crm_leads?select=id&ip_hash=eq.{ip_hash}&criado_em=gte.{quote(since)}&limit=5')
    if status == 200 and isinstance(recent, list) and len(recent) >= 5:
        raise RequestError('Recebemos vários envios seguidos. Tente de novo em alguns minutos ou chame no Instagram.', 429)
    hour = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    status, burst = supabase('GET', f'/rest/v1/crm_leads?select=id&criado_em=gte.{quote(hour)}&limit=60')
    if status == 200 and isinstance(burst, list) and len(burst) >= 60:
        raise RequestError('Muitos envios agora. Tente de novo mais tarde ou chame no Instagram.', 429)
    status, _ = supabase('POST', '/rest/v1/crm_leads', [{**lead, 'ip_hash': ip_hash}], headers={'Prefer': 'return=minimal'})
    if status not in (200, 201, 204):
        raise RequestError('Não conseguimos registrar agora. Chame a gente no Instagram @gravv.studio.', 503)
    return {'ok': True}


# --------------------------------------------------------------------------- WhatsApp
# API oficial (Cloud API da Meta). O número fica no app WhatsApp Business do celular
# (coexistência) e também manda cópia de tudo pra cá pelo webhook.
#   WHATSAPP_VERIFY_TOKEN  palavra combinada com a Meta na configuração do webhook
#   WHATSAPP_APP_SECRET    "Chave secreta do app" (Configurações do app > Básico)
#   WHATSAPP_TOKEN         token permanente do usuário do sistema (Business Manager)
#   WHATSAPP_WABA_ID       identificação da conta do WhatsApp Business
#   WHATSAPP_PHONE_ID      (opcional) id do número; sem ele, usa o primeiro número da conta
GRAPH = 'https://graph.facebook.com/v25.0'
WA_FIELDS = ('id', 'telefone', 'nome', 'direcao', 'tipo', 'texto', 'enviado_em', 'origem', 'status')


def wa_configured():
    return {name: bool(env(name)) for name in ('WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_TOKEN',
                                               'WHATSAPP_WABA_ID')}


def wa_signature_ok(raw, header):
    secret = env('WHATSAPP_APP_SECRET')
    if not secret or not header.startswith('sha256='):
        return False
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header[7:], expected)


def wa_text(message):
    kind = message.get('type') or 'desconhecido'
    body = message.get(kind) if isinstance(message.get(kind), dict) else {}
    if kind == 'text':
        return body.get('body', '')
    if kind in ('image', 'video', 'document', 'audio', 'sticker'):
        caption = body.get('caption') or body.get('filename') or ''
        return f'[{kind}] {caption}'.strip()
    if kind == 'button':
        return message.get('button', {}).get('text', '[botão]')
    if kind == 'interactive':
        reply = body.get('button_reply') or body.get('list_reply') or {}
        return reply.get('title', '[resposta interativa]')
    if kind == 'location':
        return f"[localização] {body.get('name') or ''} {body.get('address') or ''}".strip()
    if kind == 'reaction':
        return f"[reação] {body.get('emoji', '')}"
    return f'[{kind}]'


def wa_row(message, direction, origin, phone, name=''):
    stamp = message.get('timestamp')
    try:
        sent = datetime.fromtimestamp(int(stamp), timezone.utc).isoformat()
    except (TypeError, ValueError):
        sent = datetime.now(timezone.utc).isoformat()
    return {'id': str(message.get('id') or '')[:200], 'telefone': re.sub(r'\D', '', str(phone or ''))[:20],
            'nome': str(name or '')[:120], 'direcao': direction, 'tipo': str(message.get('type') or '')[:40],
            'texto': wa_text(message)[:4000], 'enviado_em': sent, 'origem': origin, 'status': ''}


def wa_extract(payload):
    """Converte o webhook da Meta em linhas da tabela wa_mensagens (entrada, eco do app e histórico)."""
    rows, statuses = [], []
    own = env('WHATSAPP_PHONE_ID')
    for entry in payload.get('entry') or []:
        for change in entry.get('changes') or []:
            value = change.get('value') or {}
            field = change.get('field')
            meta = value.get('metadata') or {}
            if own and meta.get('phone_number_id') and meta['phone_number_id'] != own:
                continue  # outro número da mesma conta
            names = {c.get('wa_id'): (c.get('profile') or {}).get('name', '') for c in value.get('contacts') or []}
            if field == 'messages':
                for message in value.get('messages') or []:
                    rows.append(wa_row(message, 'entrada', 'api', message.get('from'), names.get(message.get('from'), '')))
                for status in value.get('statuses') or []:
                    statuses.append((str(status.get('id') or ''), str(status.get('status') or '')[:20]))
            elif field == 'smb_message_echoes':
                # mensagens que você mandou pelo app no celular (coexistência)
                for message in value.get('message_echoes') or []:
                    rows.append(wa_row(message, 'saida', 'app', message.get('to')))
            elif field == 'history':
                for block in value.get('history') or []:
                    for thread in block.get('threads') or []:
                        contact = thread.get('id')
                        for message in thread.get('messages') or []:
                            mine = message.get('from') != contact
                            rows.append(wa_row(message, 'saida' if mine else 'entrada', 'historico', contact))
    return [r for r in rows if r['id'] and r['telefone']], statuses


def wa_store(rows, statuses):
    if rows:
        status, _ = supabase('POST', '/rest/v1/wa_mensagens?on_conflict=id', rows,
                             headers={'Prefer': 'resolution=ignore-duplicates,return=minimal'})
        if status not in (200, 201, 204):
            raise RequestError('Não foi possível guardar as mensagens do WhatsApp.', 503)
    for message_id, value in statuses:
        if message_id and value:
            supabase('PATCH', f'/rest/v1/wa_mensagens?id=eq.{quote(message_id)}', {'status': value},
                     headers={'Prefer': 'return=minimal'})


def wa_list():
    status, data = supabase('GET', '/rest/v1/wa_mensagens?select=' + ','.join(WA_FIELDS) + '&order=enviado_em.desc&limit=2000')
    if status != 200 or not isinstance(data, list):
        raise RequestError('Não foi possível ler as conversas. Confira se o SQL do WhatsApp foi executado no Supabase.', 503)
    return data


def graph(method, path, body=None):
    token = env('WHATSAPP_TOKEN')
    if not token:
        raise RequestError('WhatsApp ainda não configurado: falta WHATSAPP_TOKEN na Vercel.', 503)
    data = json.dumps(body).encode() if body is not None else None
    request = Request(GRAPH + path, data=data, method=method,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=12) as response:
            return response.status, json.loads(response.read() or b'{}')
    except HTTPError as exc:
        try:
            payload = json.loads(exc.read() or b'{}')
        except ValueError:
            payload = {}
        return exc.code, payload
    except (URLError, TimeoutError, OSError):
        raise RequestError('A Meta não respondeu agora. Tente de novo em instantes.', 503)


def wa_send(data):
    if set(data) != {'telefone', 'texto'}:
        raise RequestError('Envie telefone e texto.')
    phone = re.sub(r'\D', '', str(data['telefone']))
    text = clean(data['texto'], 'mensagem', 4000, True)
    if not 10 <= len(phone) <= 15:
        raise RequestError('Número de WhatsApp inválido.')
    phone_id = wa_phone_id()
    status, result = graph('POST', f'/{phone_id}/messages', {'messaging_product': 'whatsapp', 'to': phone,
                                                            'type': 'text', 'text': {'body': text}})
    if status != 200:
        detail = ((result or {}).get('error') or {}).get('message', '')
        if 'window' in detail.lower() or '131047' in json.dumps(result):
            raise RequestError('Passaram 24h desde a última mensagem do cliente. Pela regra da Meta, só dá pra retomar com um modelo aprovado.', 409)
        raise RequestError('A Meta recusou o envio: ' + (detail or 'erro desconhecido') + '.', 502)
    message_id = ((result.get('messages') or [{}])[0]).get('id', '')
    row = {'id': message_id, 'telefone': phone, 'nome': '', 'direcao': 'saida', 'tipo': 'text', 'texto': text,
           'enviado_em': datetime.now(timezone.utc).isoformat(), 'origem': 'crm', 'status': 'sent'}
    wa_store([row], [])
    return {'ok': True, 'id': message_id}


def wa_waba():
    waba = env('WHATSAPP_WABA_ID')
    if not re.fullmatch(r'[0-9]{5,25}', waba or ''):
        raise RequestError('WhatsApp ainda não configurado: falta WHATSAPP_WABA_ID na Vercel.', 503)
    return waba


def wa_numbers():
    status, result = graph('GET', f'/{wa_waba()}/phone_numbers?fields=id,display_phone_number,verified_name')
    if status != 200:
        detail = ((result or {}).get('error') or {}).get('message', 'erro desconhecido')
        raise RequestError('A Meta não mostrou os números da conta: ' + detail, 502)
    return result.get('data') or []


def wa_phone_id():
    phone_id = env('WHATSAPP_PHONE_ID')
    if phone_id:
        return phone_id
    numbers = wa_numbers()
    if not numbers:
        raise RequestError('Nenhum número encontrado na conta do WhatsApp Business.', 503)
    return numbers[0]['id']


def wa_subscribe():
    status, result = graph('POST', f'/{wa_waba()}/subscribed_apps')
    if status != 200 or not result.get('success'):
        detail = ((result or {}).get('error') or {}).get('message', 'erro desconhecido')
        raise RequestError('A Meta não aceitou ligar o webhook: ' + detail, 502)
    return {'ok': True, 'numeros': [{'numero': n.get('display_phone_number'), 'nome': n.get('verified_name')}
                                    for n in wa_numbers()]}


# --------------------------------------------------------------------------- Auth
def auth_token(grant, payload):
    status, data = supabase('POST', f'/auth/v1/token?grant_type={grant}', payload)
    if status == 200 and isinstance(data, dict) and data.get('access_token'):
        return data
    return None


# Cache curto da validação do token: evita uma ida ao Supabase Auth em cada chamada da mesma sessão.
_AUTH_CACHE = {}
_AUTH_LOCK = threading.Lock()
AUTH_CACHE_SECONDS = 120


def _token_key(access):
    return hashlib.sha256(access.encode()).hexdigest()


def auth_forget(access):
    if access:
        with _AUTH_LOCK:
            _AUTH_CACHE.pop(_token_key(access), None)


def auth_user(access):
    key, now = _token_key(access), time.time()
    with _AUTH_LOCK:
        hit = _AUTH_CACHE.get(key)
        if hit and hit[0] > now:
            return hit[1]
    status, data = supabase('GET', '/auth/v1/user', user_token=access)
    user = data if status == 200 and isinstance(data, dict) else None
    if user:
        with _AUTH_LOCK:
            if len(_AUTH_CACHE) > 200:
                _AUTH_CACHE.clear()
            _AUTH_CACHE[key] = (now + AUTH_CACHE_SECONDS, user)
    return user


# Leituras em lote: várias consultas numa chamada só, feitas em paralelo no servidor.
_POOL = ThreadPoolExecutor(max_workers=12)
MAX_BATCH = 24
REF_QUERIES = {
    'stages': ('pipeline_stages', 'order=posicao.asc'),
    'categories': ('financial_categories', 'order=nome.asc'),
    'accounts': ('v_account_balances', 'order=nome.asc'),
    'services': ('services', 'order=nome.asc'),
    'clients': ('clients', 'select=id,nome,status,telefone,email&order=nome.asc'),
    'settings': ('settings', ''),
}


def _one_read(item):
    table, query = item
    try:
        return {'data': db_read(table, query)}
    except RequestError as exc:
        return {'error': str(exc), 'status': exc.status}


def db_batch(items):
    if not isinstance(items, list) or not items or len(items) > MAX_BATCH:
        raise RequestError('Consulta em lote inválida.')
    clean_items = []
    for item in items:
        if not (isinstance(item, list) and len(item) == 2 and all(isinstance(x, str) for x in item)) or len(item[1]) > 2000:
            raise RequestError('Consulta em lote inválida.')
        clean_items.append((item[0], item[1]))
    return list(_POOL.map(_one_read, clean_items))


def ref_data():
    names = list(REF_QUERIES)
    results = db_batch([list(REF_QUERIES[n]) for n in names])
    out = {}
    for name, res in zip(names, results):
        if 'error' in res:
            raise RequestError(res['error'], res.get('status', 400))
        out[name] = res['data']
    return out


# --------------------------------------------------------------------------- HTTP
class handler(BaseHTTPRequestHandler):  # nome exigido pelo runtime Python da Vercel
    server_version = 'GRAVV'
    sys_version = ''

    def log_message(self, format, *args):
        return  # não registrar corpos, contatos ou tokens em log

    # ----- utilidades
    def _route(self):
        parts = urlsplit(self.path)
        rota = parse_qs(parts.query).get('rota', [''])[0]
        path = '/api/' + rota.strip('/') if rota else parts.path.rstrip('/')
        return path

    def _host(self):
        return self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or ''

    def _own_origin(self):
        proto = self.headers.get('X-Forwarded-Proto') or ('http' if self._host().startswith(('localhost', '127.0.0.1')) else 'https')
        return f'{proto}://{self._host()}'

    def _secure(self):
        return self._own_origin().startswith('https://')

    def _cookie(self, name, value, max_age, path='/'):
        secure = '; Secure' if self._secure() else ''
        return f'{name}={value}; Path={path}; HttpOnly; SameSite=Strict; Max-Age={int(max_age)}{secure}'

    def _reply(self, code, body=b'', mime='application/json; charset=utf-8', extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        for key, value in (extra or {}).items():
            if isinstance(value, list):
                for item in value:
                    self.send_header(key, item)
            else:
                self.send_header(key, value)
        for item in getattr(self, '_pending_cookies', []):
            self.send_header('Set-Cookie', item)
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _raw_body(self, limit=MAX_BODY):
        length = self.headers.get('Content-Length', '')
        if not length.isdigit():
            raise RequestError('Tamanho da requisição ausente.', 411)
        size = int(length)
        if not 0 < size <= limit:
            raise RequestError('O envio ultrapassa o tamanho permitido.', 413)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise RequestError('Envio incompleto. Tente novamente.')
        return raw

    def _json(self, limit=MAX_BODY, content_types=('application/json',)):
        if self.headers.get_content_type() not in content_types:
            raise RequestError('Formato de envio não aceito.', 415)
        raw = self._raw_body(limit)
        try:
            data = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(RequestError('Valor numérico inválido.')))
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError('Envio inválido. Confira o formulário.')
        if not isinstance(data, dict):
            raise RequestError('Envio precisa conter campos válidos.')
        return data

    def _boundary(self, mutate=False):
        origin = self.headers.get('Origin')
        if origin is not None and origin != self._own_origin():
            raise RequestError('Acesso de outro site recusado.', 403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise RequestError('Acesso de outro site recusado.', 403)
        if mutate and origin != self._own_origin():
            raise RequestError('Origem da alteração não confirmada.', 403)

    def _session(self, mutate=False):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except CookieError:
            raise RequestError('Entre novamente no CRM.', 401)
        access = cookie.get(ACCESS_COOKIE).value if cookie.get(ACCESS_COOKIE) else ''
        refresh = cookie.get(REFRESH_COOKIE).value if cookie.get(REFRESH_COOKIE) else ''
        user = auth_user(access) if access else None
        if not user and refresh:
            tokens = auth_token('refresh_token', {'refresh_token': refresh})
            if tokens:
                self._set_session_cookies(tokens)
                user = tokens.get('user') or auth_user(tokens['access_token'])
        if not user:
            raise RequestError('Sessão encerrada. Entre novamente.', 401)
        email = (user.get('email') or '').lower()
        if email not in owners():
            raise RequestError('Este e-mail não tem acesso ao CRM GRAVV.', 403)
        csrf = sign('csrf:' + user.get('id', email))[:40]
        if mutate and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), csrf):
            raise RequestError('Atualize a página antes de salvar.', 403)
        return {'email': email, 'csrf': csrf}

    def _set_session_cookies(self, tokens):
        self._pending_cookies = [
            self._cookie(ACCESS_COOKIE, tokens['access_token'], tokens.get('expires_in', 3600)),
            self._cookie(REFRESH_COOKIE, tokens['refresh_token'], 30 * 24 * 3600, '/api'),
        ]

    def _clear_session_cookies(self):
        self._pending_cookies = [self._cookie(ACCESS_COOKIE, '', 0), self._cookie(REFRESH_COOKIE, '', 0, '/api')]

    def _lead_cors(self):
        origin = (self.headers.get('Origin') or '').rstrip('/')
        allowed = site_origins() | {self._own_origin()}
        if origin not in allowed:
            raise RequestError('Envio não autorizado para este site.', 403)
        return {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600'}

    def _client_ip(self):
        forwarded = self.headers.get('X-Forwarded-For', '')
        return (forwarded.split(',')[0].strip() or self.headers.get('X-Real-Ip') or self.client_address[0])

    # ----- rotas
    def _dispatch(self, method):
        path = self._route()
        if path == '/api/lead':
            cors = self._lead_cors()
            if method == 'OPTIONS':
                self._reply(204, b'', extra=cors)
                return
            if method != 'POST':
                raise RequestError('Use o formulário do site.', 405)
            data = self._json(content_types=('application/json', 'text/plain'))
            self._reply(200, save_lead(data, self._client_ip()), extra=cors)
            return
        if path == '/api/whatsapp':  # webhook da Meta: não usa sessão, usa assinatura
            if method == 'GET':
                query = parse_qs(urlsplit(self.path).query)
                expected = env('WHATSAPP_VERIFY_TOKEN')
                given = query.get('hub.verify_token', [''])[0]
                if (query.get('hub.mode', [''])[0] == 'subscribe' and expected
                        and hmac.compare_digest(given, expected)):
                    self._reply(200, query.get('hub.challenge', [''])[0], 'text/plain; charset=utf-8')
                    return
                raise RequestError('Verificação recusada.', 403)
            if method != 'POST':
                raise RequestError('Método não aceito.', 405)
            raw = self._raw_body(2 * 1024 * 1024)
            if not wa_signature_ok(raw, self.headers.get('X-Hub-Signature-256', '')):
                raise RequestError('Assinatura inválida.', 401)
            try:
                payload = json.loads(raw.decode('utf-8'))
            except (ValueError, UnicodeError):
                raise RequestError('Envio inválido.')
            wa_store(*wa_extract(payload if isinstance(payload, dict) else {}))
            self._reply(200, {'ok': True})
            return
        if method == 'OPTIONS':
            raise RequestError('Acesso de outro site não habilitado.', 403)
        if path == '/api/health':
            key = env('SUPABASE_SECRET_KEY') or env('SUPABASE_SERVICE_ROLE_KEY')
            configured = bool(env('SUPABASE_URL') and key and owners())
            info = {'ok': True, 'app': 'gravv-crm', 'online': True, 'configurado': configured,
                    'chave_formato_ok': key_is_valid(key), 'tipo_chave': ('secret' if key.startswith('sb_secret_') else 'jwt' if key.startswith('eyJ') else 'outra') if key else 'ausente'}
            info['whatsapp'] = wa_configured()
            if configured and info['chave_formato_ok']:
                try:
                    banco, _ = supabase('GET', '/rest/v1/crm_leads?select=id&limit=1')
                    auth, _ = supabase('GET', '/auth/v1/settings')
                    v2, _ = supabase('GET', '/rest/v1/pipeline_stages?select=id&limit=1')
                    info.update(banco_status=banco, auth_status=auth, crm_v2=v2 == 200)
                except RequestError as exc:
                    info.update(banco_status=str(exc))
            self._reply(200, info)
            return
        mutate = method in ('POST', 'PATCH', 'DELETE')
        self._boundary(mutate=mutate)
        if method == 'POST' and path == '/api/login':
            data = self._json()
            if set(data) != {'email', 'password'} or not isinstance(data['password'], str):
                raise RequestError('Informe e-mail e senha.')
            email = clean(data['email'], 'e-mail', 200, True).lower()
            if email not in owners():
                raise RequestError('E-mail ou senha incorretos.', 401)
            tokens = auth_token('password', {'email': email, 'password': data['password']})
            if not tokens:
                raise RequestError('E-mail ou senha incorretos.', 401)
            self._set_session_cookies(tokens)
            self._reply(200, {'ok': True})
            return
        if method == 'POST' and path == '/api/logout':
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get('Cookie', ''))
                auth_forget(cookie.get(ACCESS_COOKIE).value if cookie.get(ACCESS_COOKIE) else '')
            except CookieError:
                pass
            self._clear_session_cookies()
            self._reply(200, {'ok': True})
            return
        session = self._session(mutate=mutate)
        query = urlsplit(self.path).query
        if path.startswith('/api/db/'):
            table = path[len('/api/db/'):]
            if method == 'GET':
                self._reply(200, db_read(table, query))
            else:
                check_table(table)
                self._reply(200, db_write(method, table, query, self._json() if method != 'DELETE' else None))
            return
        if path.startswith('/api/rpc/') and method == 'POST':
            self._reply(200, {'ok': True, 'result': db_rpc(path[len('/api/rpc/'):], self._json())})
            return
        if method == 'POST':
            if path == '/api/conversas/enviar':
                self._reply(200, wa_send(self._json()))
            elif path == '/api/conversas/assinar':
                self._reply(200, wa_subscribe())
            else:
                raise RequestError('Ação não encontrada.', 404)
            return
        if method != 'GET':
            raise RequestError('Método não aceito.', 405)
        if path == '/api/session':
            info = {'authenticated': True, 'csrf': session['csrf'], 'today': today(),
                    'owner': env('OWNER_NAME', 'Marcos'), 'email': session['email'], 'owners': sorted(owners())}
            if parse_qs(query).get('ref') == ['1']:
                info['ref'] = ref_data()
            self._reply(200, info)
        elif path == '/api/batch':
            try:
                items = json.loads(parse_qs(query).get('q', [''])[0])
            except ValueError:
                raise RequestError('Consulta em lote inválida.')
            self._reply(200, {'results': db_batch(items)})
        elif path == '/api/backup':
            self._reply(200, json.dumps(backup(), ensure_ascii=False, indent=1), 'application/json; charset=utf-8',
                        {'Content-Disposition': f'attachment; filename="gravv-crm-backup-{today()}.json"'})
        elif path == '/api/conversas':
            self._reply(200, {'mensagens': wa_list(), 'configuracao': wa_configured()})
        else:
            raise RequestError('Página não encontrada.', 404)

    def _safe(self, method):
        self._pending_cookies = getattr(self, '_pending_cookies', [])
        try:
            self._dispatch(method)
        except RequestError as exc:
            extra = {}
            if self._route() == '/api/lead' and (self.headers.get('Origin') or '').rstrip('/') in site_origins():
                extra = {'Access-Control-Allow-Origin': self.headers['Origin'].rstrip('/'), 'Vary': 'Origin'}
            if exc.status == 401 and self._route() != '/api/login':
                self._clear_session_cookies()
            self._reply(exc.status, {'error': str(exc)}, extra=extra)
        except Exception:
            traceback.print_exc(file=sys.stderr)  # só a pilha técnica; nunca corpo, token ou contato
            self._reply(500, {'error': 'Não foi possível concluir. Seus dados existentes foram preservados.'})

    def do_GET(self):
        self._safe('GET')

    def do_HEAD(self):
        self._safe('GET')

    def do_POST(self):
        self._safe('POST')

    def do_PATCH(self):
        self._safe('PATCH')

    def do_DELETE(self):
        self._safe('DELETE')

    def do_OPTIONS(self):
        self._safe('OPTIONS')
