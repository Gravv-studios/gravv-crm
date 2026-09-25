"""API do CRM GRAVV online (Vercel + Supabase).

Reaproveita o mesmo motor de eventos do CRM local (api/_lib/operacao.py). A diferença é
onde o diário fica guardado: em vez de dados/estado.json, cada evento vira uma linha na
tabela crm_eventos do Supabase. O estado é sempre reconstruído a partir do diário, com a
mesma validação de hash usada no CRM local.

Variáveis de ambiente (configurar na Vercel, nunca no código):
  SUPABASE_URL          https://xxxx.supabase.co
  SUPABASE_SECRET_KEY   chave secreta (sb_secret_...) ou service_role do projeto
  OWNER_EMAILS          e-mails autorizados a entrar, separados por vírgula
  SITE_ORIGINS          (opcional) sites que podem enviar leads, separados por vírgula
  OWNER_NAME            (opcional) nome exibido no topo; padrão "Marcos"
  WHATSAPP_*            (opcional) API oficial do WhatsApp — ver seção WhatsApp abaixo
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import sys
import traceback
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
import operacao as motor  # noqa: E402

BRASILIA = timezone(timedelta(hours=-3))  # Brasil sem horário de verão desde 2019.
BUSINESS_COLLECTIONS = ('clientes', 'oportunidades', 'parcelas', 'pagamentos', 'despesas',
                        'pagamentos_despesas', 'tarefas', 'projetos', 'notas')
PERSONAL_COLLECTIONS = ('lancamentos_pessoais', 'movimentos_pessoais',
                        'transferencias_internas', 'movimentos_transferencias')
EVENT_TYPES = frozenset(('cliente.cadastrado', 'cliente.atualizado', 'oportunidade.criada',
    'oportunidade.atualizada', 'proposta.aceita', 'contrato.assinado', 'pagamento.registrado',
    'despesa.registrada', 'despesa.paga', 'pessoal.lancamento_registrado',
    'pessoal.movimento_registrado', 'transferencia.prevista', 'transferencia.realizada',
    'tarefa.criada', 'tarefa.atualizada', 'projeto.criado', 'projeto.atualizado', 'nota.registrada'))
LEAD_STATUSES = frozenset(('novo', 'convertido', 'arquivado'))
DEFAULT_SITE_ORIGINS = ('https://gravv-studios.vercel.app', 'https://gravv.com.br', 'https://www.gravv.com.br')
PAGE = 1000
MAX_BODY = 262144
MAX_IMPORT = 4 * 1024 * 1024
ACCESS_COOKIE = 'gravv_at'
REFRESH_COOKIE = 'gravv_rt'


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


def load_rows():
    rows, offset = [], 0
    while True:
        status, data = supabase('GET', f'/rest/v1/crm_eventos?select=posicao,id,hash,evento&order=posicao.asc&limit={PAGE}&offset={offset}')
        if status != 200 or not isinstance(data, list):
            raise RequestError('Não foi possível ler a base online. Confira se o SQL de criação foi executado no Supabase.', 503)
        rows.extend(data)
        if len(data) < PAGE:
            return rows
        offset += PAGE


def build_state(rows):
    """Mesma regra do load_state local: o estado nasce do diário e cada hash é conferido."""
    state = motor.empty_state()
    for position, row in enumerate(rows):
        motor.require(row.get('posicao') == position, 'Diário online com lacuna de posição. Preserve a base para revisão.')
        event = row.get('evento')
        motor.validate_event(event)
        motor.require(event['id'] == row.get('id') and row.get('hash') == motor.fingerprint(event),
                      'Diário de eventos inconsistente.')
        motor.process(state, event)
        state['eventos'][event['id']] = {'hash': row['hash'], 'evento': event}
    return state


def load_state():
    return build_state(load_rows())


def apply_event(event):
    motor.validate_event(event)
    digest = motor.fingerprint(event)
    rows = load_rows()
    state = build_state(rows)
    previous = state['eventos'].get(event['id'])
    if previous:
        motor.require(previous['hash'] == digest, f"Conflito: evento {event['id']} já existe com outro conteúdo.")
        return {'status': 'repetido_sem_alteracao', 'evento_id': event['id']}
    working = deepcopy(state)
    motor.process(working, event)  # valida tudo antes de gravar
    status, _ = supabase('POST', '/rest/v1/crm_eventos',
                         [{'posicao': len(rows), 'id': event['id'], 'hash': digest, 'evento': event}],
                         headers={'Prefer': 'return=minimal'})
    if status == 409:
        raise RequestError('Outra alteração foi salva ao mesmo tempo. Atualize a página e tente de novo.', 409)
    if status not in (200, 201, 204):
        raise RequestError('O banco online recusou a gravação. Nada foi confirmado.', 503)
    return {'status': 'aplicado', 'evento_id': event['id'], 'tipo': event['tipo']}


def import_state(state):
    """Importa o estado.json / backup do CRM local, só com a base online vazia."""
    motor.obj(state, 'backup')
    motor.require(isinstance(state.get('eventos'), dict), 'Arquivo não parece um backup do CRM GRAVV.')
    records = list(state['eventos'].items())
    rows = []
    for position, (event_id, record) in enumerate(records):
        motor.fields(record, ['hash', 'evento'], label=f'evento {event_id}')
        rows.append({'posicao': position, 'id': event_id, 'hash': record['hash'], 'evento': record['evento']})
    rebuilt = build_state(rows)  # confere hash e regras de todos os eventos
    for name in motor.COLLECTIONS:
        if name in state and name != 'eventos':
            motor.require(rebuilt[name] == state[name], 'O backup não corresponde ao seu diário de eventos. Nada foi importado.')
    if load_rows():
        raise RequestError('A base online já tem registros. A importação só é feita numa base vazia.', 409)
    if not rows:
        return {'status': 'vazio', 'eventos': 0}
    status, _ = supabase('POST', '/rest/v1/crm_eventos', rows, headers={'Prefer': 'return=minimal'})
    if status == 409:
        raise RequestError('A base online recebeu registros durante a importação. Nada foi duplicado; confira antes de repetir.', 409)
    if status not in (200, 201, 204):
        raise RequestError('O banco online recusou a importação. Nada foi confirmado.', 503)
    return {'status': 'importado', 'eventos': len(rows)}


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


def list_leads():
    status, data = supabase('GET', '/rest/v1/crm_leads?select=id,criado_em,nome,empresa,contato,interesse,mensagem,origem,status,cliente_id&order=criado_em.desc&limit=500')
    if status != 200 or not isinstance(data, list):
        raise RequestError('Não foi possível ler os leads do site.', 503)
    return data


def update_lead(data):
    motor.fields(data, ['id', 'status'], ['cliente_id'], label='lead')
    if not isinstance(data['id'], str) or not re.fullmatch(r'[0-9a-fA-F-]{36}', data['id']):
        raise RequestError('Lead inválido.')
    if data['status'] not in LEAD_STATUSES:
        raise RequestError('Situação de lead inválida.')
    patch = {'status': data['status'], 'atualizado_em': datetime.now(timezone.utc).isoformat()}
    if 'cliente_id' in data:
        motor.identifier(data['cliente_id'], 'cliente_id')
        patch['cliente_id'] = data['cliente_id']
    status, rows = supabase('PATCH', f"/rest/v1/crm_leads?id=eq.{data['id']}", patch, headers={'Prefer': 'return=representation'})
    if status != 200 or not rows:
        raise RequestError('Lead não encontrado.', 404)
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
    motor.fields(data, ['telefone', 'texto'], label='mensagem')
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


def auth_user(access):
    status, data = supabase('GET', '/auth/v1/user', user_token=access)
    return data if status == 200 and isinstance(data, dict) else None


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
            data = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=motor.unique_object,
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
                    info.update(banco_status=banco, auth_status=auth)
                except RequestError as exc:
                    info.update(banco_status=str(exc))
            self._reply(200, info)
            return
        post = method == 'POST'
        self._boundary(mutate=post)
        if post and path == '/api/login':
            data = self._json()
            motor.fields(data, ['email', 'password'], label='login')
            email = clean(data['email'], 'e-mail', 200, True).lower()
            if email not in owners():
                raise RequestError('E-mail ou senha incorretos.', 401)
            tokens = auth_token('password', {'email': email, 'password': data['password']})
            if not tokens:
                raise RequestError('E-mail ou senha incorretos.', 401)
            self._set_session_cookies(tokens)
            self._reply(200, {'ok': True})
            return
        if post and path == '/api/logout':
            self._clear_session_cookies()
            self._reply(200, {'ok': True})
            return
        session = self._session(mutate=post)
        if post:
            if path == '/api/events':
                event = self._json()
                if event.get('tipo') not in EVENT_TYPES:
                    raise RequestError('Ação não disponível neste CRM.')
                self._reply(200, {'ok': True, 'result': apply_event(event)})
            elif path == '/api/import':
                self._reply(200, {'ok': True, 'result': import_state(self._json(MAX_IMPORT))})
            elif path == '/api/leads/status':
                self._reply(200, update_lead(self._json()))
            elif path == '/api/conversas/enviar':
                self._reply(200, wa_send(self._json()))
            elif path == '/api/conversas/assinar':
                self._reply(200, wa_subscribe())
            else:
                raise RequestError('Ação não encontrada.', 404)
            return
        if path == '/api/session':
            self._reply(200, {'authenticated': True, 'csrf': session['csrf'], 'today': today(),
                              'owner': env('OWNER_NAME', 'Marcos'), 'email': session['email']})
        elif path in ('/api/state', '/api/personal'):
            state = load_state()
            personal = path == '/api/personal'
            collections = PERSONAL_COLLECTIONS if personal else BUSINESS_COLLECTIONS
            self._reply(200, {'state': {name: state.get(name, {}) for name in collections},
                              'financeiro': motor.finance_summary(state, today(), 'consolidado' if personal else 'empresa'),
                              'today': today(), 'revision': len(state['eventos'])})
        elif path == '/api/backup':
            self._reply(200, motor.json_text(load_state()), 'application/json; charset=utf-8',
                        {'Content-Disposition': f'attachment; filename="gravv-privado-{today()}.json"'})
        elif path == '/api/leads':
            self._reply(200, {'leads': list_leads()})
        elif path == '/api/conversas':
            self._reply(200, {'mensagens': wa_list(), 'configuracao': wa_configured()})
        elif path == '/api/documents':
            self._reply(200, {'documents': []})  # contratos continuam só na pasta privada do computador
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
        except motor.OperationError as exc:
            message = str(exc)
            self._reply(409 if 'Conflito:' in message else 400, {'error': message})
        except Exception:
            traceback.print_exc(file=sys.stderr)  # só a pilha técnica; nunca corpo, token ou contato
            self._reply(500, {'error': 'Não foi possível concluir. Seus dados existentes foram preservados.'})

    def do_GET(self):
        self._safe('GET')

    def do_HEAD(self):
        self._safe('GET')

    def do_POST(self):
        self._safe('POST')

    def do_OPTIONS(self):
        self._safe('OPTIONS')
