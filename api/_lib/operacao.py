#!/usr/bin/env python3
"""Motor local GRAVV: registros comprováveis, sem rede ou dependências externas."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile


VERSION = 3
LEGACY_COLLECTIONS = (
    "clientes", "oportunidades", "parcelas", "pagamentos", "despesas",
    "pagamentos_despesas", "tarefas", "eventos",
)
FINANCE_COLLECTIONS = (
    "lancamentos_pessoais", "movimentos_pessoais", "transferencias_internas", "movimentos_transferencias",
)
CRM_COLLECTIONS = ("projetos", "notas")
COLLECTIONS = (*LEGACY_COLLECTIONS, *FINANCE_COLLECTIONS, *CRM_COLLECTIONS)
FINANCE_SCOPES = {"empresa", "pessoal", "consolidado"}
CLIENT_FIELDS = ("nome", "email", "telefone", "contato", "segmento", "relacionamento", "proxima_acao")
OPPORTUNITY_STAGES = {"rascunho", "diagnostico", "proposta", "negociacao", "perdida"}
PROJECT_STATUSES = {"planejado", "em_andamento", "aguardando_cliente", "em_revisao", "concluido", "cancelado"}
TASK_STATUSES = {"pendente", "em_andamento", "bloqueada", "concluida", "cancelada"}
TRANSITIONS = {
    "pendente": TASK_STATUSES,
    "em_andamento": TASK_STATUSES,
    "bloqueada": TASK_STATUSES,
    "concluida": {"concluida"},
    "cancelada": {"cancelada"},
}
PLACEHOLDER = re.compile(r"\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z")


class OperationError(Exception):
    """Erro de negócio exibido sem traceback na CLI."""


def require(condition, message):
    if not condition:
        raise OperationError(message)


def obj(value, label):
    require(isinstance(value, dict), f"{label} precisa ser um objeto JSON.")
    return value


def fields(value, required, optional=(), label="dados"):
    obj(value, label)
    missing = set(required) - value.keys()
    unknown = value.keys() - set(required) - set(optional)
    require(not missing, f"{label}: campos ausentes: {', '.join(sorted(missing))}.")
    require(not unknown, f"{label}: campos desconhecidos: {', '.join(sorted(unknown))}.")


def nonempty(value, label):
    require(isinstance(value, str) and bool(value.strip()), f"{label} precisa ser texto preenchido.")
    require("\x00" not in value, f"{label} contém caractere nulo.")
    return value


def identifier(value, label="id"):
    require(isinstance(value, str) and bool(IDENTIFIER.fullmatch(value)),
            f"{label} deve ter 1 a 100 caracteres: letras sem acento, números, _, . ou -.")
    return value


def money(value, label="valor_centavos"):
    require(type(value) is int and value > 0, f"{label} precisa ser inteiro positivo em centavos; booleanos não são valores.")
    return value


def valid_date(value, label="data"):
    require(isinstance(value, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)),
            f"{label} precisa estar em AAAA-MM-DD.")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise OperationError(f"{label} não é uma data real: {value}.") from exc
    return value


def normalized_phone(value):
    """Normaliza somente separadores; país/DDD precisam ter sido informados."""
    nonempty(value, "telefone")
    raw = value.strip()
    require(bool(re.fullmatch(r"\+[0-9\s().-]+", raw)),
            "telefone deve começar com + e código do país informado; use apenas números e separadores, sem ramal.")
    normalized = "+" + re.sub(r"[^0-9]", "", raw)
    require(bool(re.fullmatch(r"\+[1-9][0-9]{7,14}", normalized)),
            "telefone deve conter 8 a 15 dígitos e código do país informado; o motor não deduz país ou DDD.")
    return normalized


def client_values(data):
    result = deepcopy(data)
    for key in (*CLIENT_FIELDS, "documento"):
        if key in data:
            nonempty(data[key], key)
    if "telefone" in data:
        result["telefone"] = normalized_phone(data["telefone"])
    return result


def opportunity_values(data):
    result = deepcopy(data)
    for key in ("servico", "observacao", "proxima_acao"):
        if key in data:
            nonempty(data[key], key)
    if "etapa" in data:
        require(isinstance(data["etapa"], str) and data["etapa"] in OPPORTUNITY_STAGES,
                "etapa deve ser rascunho, diagnostico, proposta, negociacao ou perdida.")
    if "valor_centavos" in data:
        money(data["valor_centavos"])
    if "natureza" in data:
        require(isinstance(data["natureza"], str) and data["natureza"] in {"honorarios", "verba_midia", "reembolso"},
                "natureza deve ser honorarios, verba_midia ou reembolso.")
    return result


def project_values(data):
    result = deepcopy(data)
    for key in ("nome", "responsavel", "descricao"):
        if key in data:
            nonempty(data[key], key)
    if "status" in data:
        require(isinstance(data["status"], str) and data["status"] in PROJECT_STATUSES, "Status de projeto inválido.")
    if "prazo" in data:
        valid_date(data["prazo"], "prazo")
    return result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"JSON contém chave duplicada: {key}.")
        result[key] = value
    return result


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(OperationError(f"JSON inválido: {value}.")))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise OperationError(f"Não foi possível ler JSON em {path}: {exc}") from exc


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def json_text(value):
    # Preservar ordem de entrada dos eventos é essencial para reconstruir dependências.
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def empty_state():
    return {"versao": VERSION, **{name: {} for name in COLLECTIONS}}


def state_path(root):
    return Path(root).resolve() / "dados" / "estado.json"


@contextmanager
def locked(root, create=False):
    """Lock exclusivo por criação atômica; não espera, não remove lock alheio."""
    directory = state_path(root).parent
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    require(directory.is_dir(), "Base não inicializada. Execute init --root PASTA.")
    lock = directory / ".operacao.lock"
    try:
        descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise OperationError("Base ocupada (.operacao.lock). Outra execução pode estar trabalhando; esta operação não foi aplicada. Não exclua o lock sem verificar o processo e a máquina indicados nele.") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json_text({"pid": os.getpid(), "maquina": platform.node(),
                                    "inicio_utc": datetime.now(timezone.utc).isoformat()}))
            handle.flush()
            os.fsync(handle.fileno())
        yield
    finally:
        lock.unlink(missing_ok=True)


def atomic_write(path, text, overwrite=False):
    """Substitui atomicamente; criação exclusiva por hard link impede corrida."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    require(overwrite or not target.exists(), f"Arquivo já existe: {target}. Use --overwrite para substituição explícita.")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(str(temp_path), str(target))
        else:
            try:
                os.link(str(temp_path), str(target))
            except FileExistsError as exc:
                raise OperationError(f"Arquivo já existe: {target}. Nada foi sobrescrito.") from exc
        if os.name != "nt":
            directory_fd = os.open(str(target.parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        temp_path.unlink(missing_ok=True)


def load_state(root):
    path = state_path(root)
    require(path.is_file(), "Base não inicializada. Execute init --root PASTA.")
    state = read_json(path)
    obj(state, "estado")
    version = state.get("versao")
    require(type(version) is int and version in (1, 2, VERSION), "Versão de estado incompatível.")
    previous_collections = LEGACY_COLLECTIONS if version == 1 else (*LEGACY_COLLECTIONS, *FINANCE_COLLECTIONS)
    fields(state, ["versao", *(COLLECTIONS if version == VERSION else previous_collections)], label="estado")
    if version < VERSION:
        # Migração aditiva em memória: não reescreve eventos, hashes ou o arquivo ao consultar.
        state = {**state, "versao": VERSION, **{name: {} for name in COLLECTIONS if name not in state}}
    for name in COLLECTIONS:
        obj(state[name], f"estado.{name}")
    # O estado materializado deve corresponder ao diário; edição manual não passa silenciosamente.
    rebuilt = empty_state()
    for event_id, record in state["eventos"].items():
        fields(record, ["hash", "evento"], label=f"evento {event_id}")
        event = record["evento"]
        validate_event(event)
        require(event["id"] == event_id and record["hash"] == fingerprint(event), "Diário de eventos inconsistente.")
        process(rebuilt, event)
        rebuilt["eventos"][event_id] = record
    require(rebuilt == state, "Estado não corresponde ao diário de eventos. Preserve o arquivo para revisão; não edite dados manualmente.")
    return state


def init(root):
    with locked(root, create=True):
        if state_path(root).exists():
            load_state(root)
            return {"status": "ja_inicializado", "arquivo": str(state_path(root))}
        atomic_write(state_path(root), json_text(empty_state()))
    return {"status": "inicializado", "arquivo": str(state_path(root))}


def find(state, collection, key):
    identifier(key)
    require(key in state[collection], f"Registro inexistente em {collection}: {key}.")
    return state[collection][key]


def absent(state, collection, key):
    identifier(key)
    require(key not in state[collection], f"ID já registrado em {collection}: {key}.")


def paid(state, parcela_id):
    return sum(p["valor_centavos"] for p in state["pagamentos"].values() if p["parcela_id"] == parcela_id)


def expense_paid(state, despesa_id):
    return sum(p["valor_centavos"] for p in state["pagamentos_despesas"].values() if p["despesa_id"] == despesa_id)


def finance_paid(state, collection, field, record_id):
    return sum(p["valor_centavos"] for p in state[collection].values() if p[field] == record_id)


def unused_finance_evidence(state, evidence, include_legacy=True):
    """As novas baixas não podem duplicar dinheiro já lançado em nenhuma esfera."""
    nonempty(evidence, "evidencia")
    used = [p["evidencia"] for p in state["movimentos_pessoais"].values()]
    for transfer in state["movimentos_transferencias"].values():
        used.extend(p["evidencia"] for p in transfer["pontas"])
    if include_legacy:
        used.extend(p["evidencia"] for name in ("pagamentos", "pagamentos_despesas") for p in state[name].values())
    require(evidence.strip() not in {item.strip() for item in used},
            "Evidência financeira já utilizada; confira a movimentação e eventual rateio antes de lançar novamente.")


def finance_currency(value):
    require(value == "BRL", "moeda deve ser BRL; conversão de moedas não está implementada.")


def automatic_task(state, task_id, title, owner, opportunity_id, event_date):
    if task_id not in state["tarefas"]:
        state["tarefas"][task_id] = {"id": task_id, "titulo": title, "responsavel": owner,
            "status": "pendente", "resultado": "", "oportunidade_id": opportunity_id,
            "criada_em": event_date, "atualizada_em": event_date, "automatica": True}


def maybe_onboarding(state, opportunity_id, event_date):
    opportunity = find(state, "oportunidades", opportunity_id)
    installments = [p for p in state["parcelas"].values() if p["oportunidade_id"] == opportunity_id and p["entrada"]]
    start_satisfied = opportunity.get("inicio_sem_entrada", False) or (installments and all(paid(state, p["id"]) == p["valor_centavos"] for p in installments))
    if opportunity.get("contrato_assinado") and start_satisfied:
        entry_ids = {p["id"] for p in installments}
        eligible_date = max([event_date, opportunity["contrato_assinado_em"]] + [p["data"] for p in state["pagamentos"].values() if p["parcela_id"] in entry_ids])
        automatic_task(state, f"auto--onboarding--{opportunity_id}", "Iniciar onboarding do cliente", "gravv-projetos", opportunity_id, eligible_date)


def validate_event(event):
    fields(event, ["id", "tipo", "data", "dados"], label="evento")
    identifier(event["id"], "evento.id")
    nonempty(event["tipo"], "evento.tipo")
    valid_date(event["data"], "evento.data")
    obj(event["dados"], "evento.dados")


def process(state, event):
    """Muda apenas cópia em memória; persistência só ocorre após todas as validações."""
    kind, d, when = event["tipo"], event["dados"], event["data"]
    if kind == "cliente.cadastrado":
        fields(d, ["id", "nome"], ["documento", *CLIENT_FIELDS[1:]])
        absent(state, "clientes", d["id"])
        state["clientes"][d["id"]] = {**client_values(d), "criado_em": when}
    elif kind == "cliente.atualizado":
        fields(d, ["id"], CLIENT_FIELDS)
        require(len(d) > 1, "Informe pelo menos um campo do cliente para atualizar.")
        client = find(state, "clientes", d["id"])
        require(when >= client.get("atualizado_em", client["criado_em"]), "Atualização não pode anteceder o último registro do cliente.")
        client.update(client_values(d), atualizado_em=when)
    elif kind == "oportunidade.criada":
        fields(d, ["id", "cliente_id", "servico", "valor_centavos"], ["natureza", "etapa", "observacao", "proxima_acao"])
        absent(state, "oportunidades", d["id"])
        client = find(state, "clientes", d["cliente_id"])
        require(len(d["id"]) <= 70, "ID da oportunidade deve ter no máximo 70 caracteres.")
        require(when >= client["criado_em"], "Oportunidade não pode anteceder o cadastro do cliente.")
        nature = d.get("natureza", "honorarios")
        state["oportunidades"][d["id"]] = {**opportunity_values(d), "status": "aberta", "criada_em": when,
            "contrato_assinado": False, "escopo": "", "natureza": nature}
    elif kind == "oportunidade.atualizada":
        fields(d, ["id"], ["etapa", "observacao", "proxima_acao", "cliente_id", "servico", "valor_centavos", "natureza"])
        require(len(d) > 1, "Informe pelo menos um campo da oportunidade para atualizar.")
        opportunity = find(state, "oportunidades", d["id"])
        latest = max(opportunity.get("atualizada_em", opportunity["criada_em"]), opportunity.get("aceita_em", opportunity["criada_em"]))
        require(when >= latest, "Atualização não pode anteceder o último registro comercial da oportunidade.")
        if opportunity["status"] == "aceita":
            require(not (set(d) - {"id", "observacao", "proxima_acao"}),
                    "Proposta aceita permite somente observacao e proxima_acao; condições e parcelas precisam de alteração rastreável própria.")
        if "cliente_id" in d:
            client = find(state, "clientes", d["cliente_id"])
            require(when >= client["criado_em"], "Alteração não pode anteceder o cadastro do cliente.")
            if d["cliente_id"] != opportunity["cliente_id"]:
                require(not any(t.get("oportunidade_id") == opportunity["id"] and "cliente_id" in t
                                and t["cliente_id"] != d["cliente_id"] for t in state["tarefas"].values()),
                        "Cliente não pode mudar enquanto houver tarefas com vínculo ao cliente anterior nesta oportunidade.")
        opportunity.update(opportunity_values(d), atualizada_em=when)
    elif kind == "proposta.aceita":
        fields(d, ["oportunidade_id", "escopo", "parcelas"], ["inicio_sem_entrada"])
        opportunity = find(state, "oportunidades", d["oportunidade_id"])
        require(opportunity["status"] == "aberta", "Proposta já aceita; use o mesmo evento para repetição idempotente.")
        require(opportunity.get("etapa") != "perdida", "Oportunidade perdida precisa ser reaberta por atualização de etapa antes do aceite.")
        require(when >= opportunity.get("atualizada_em", opportunity["criada_em"]), "Aceite não pode anteceder o último registro da oportunidade.")
        nonempty(d["escopo"], "escopo")
        require(isinstance(d["parcelas"], list) and d["parcelas"], "parcelas precisa ser uma lista preenchida.")
        ids = set()
        for installment in d["parcelas"]:
            fields(installment, ["id", "valor_centavos", "vencimento", "entrada"], label="parcela")
            absent(state, "parcelas", installment["id"])
            require(installment["id"] not in ids, "Há IDs de parcela repetidos na proposta.")
            ids.add(installment["id"])
            money(installment["valor_centavos"])
            valid_date(installment["vencimento"], "vencimento")
            require(installment["vencimento"] >= when, "Vencimento não pode anteceder o aceite registrado.")
            require(type(installment["entrada"]) is bool, "entrada precisa ser true ou false.")
        no_entry = d.get("inicio_sem_entrada", False)
        require(type(no_entry) is bool, "inicio_sem_entrada precisa ser true ou false.")
        has_entry = any(p["entrada"] for p in d["parcelas"])
        require(has_entry or no_entry, "Regra de início não definida: marque uma entrada contratada ou informe inicio_sem_entrada=true conforme o acordo real.")
        require(not (has_entry and no_entry), "inicio_sem_entrada=true exige todas as parcelas com entrada=false.")
        require(sum(p["valor_centavos"] for p in d["parcelas"]) == opportunity["valor_centavos"], "Soma das parcelas difere do valor da oportunidade.")
        opportunity.update(status="aceita", aceita_em=when, escopo=d["escopo"], inicio_sem_entrada=no_entry)
        for installment in d["parcelas"]:
            state["parcelas"][installment["id"]] = {**deepcopy(installment), "oportunidade_id": opportunity["id"]}
        automatic_task(state, f"auto--contratos--{opportunity['id']}", "Preparar contrato no template aprovado", "gravv-contratos", opportunity["id"], when)
    elif kind == "contrato.assinado":
        fields(d, ["oportunidade_id", "evidencia"])
        opportunity = find(state, "oportunidades", d["oportunidade_id"])
        require(opportunity["status"] == "aceita", "Contrato exige proposta aceita.")
        require(when >= opportunity["aceita_em"], "Assinatura não pode anteceder o aceite.")
        require(not opportunity["contrato_assinado"], "Contrato já registrado como assinado.")
        nonempty(d["evidencia"], "evidencia")
        opportunity.update(contrato_assinado=True, contrato_assinado_em=when, contrato_evidencia=d["evidencia"])
        maybe_onboarding(state, opportunity["id"], when)
    elif kind == "pagamento.registrado":
        fields(d, ["id", "parcela_id", "valor_centavos", "evidencia"])
        absent(state, "pagamentos", d["id"])
        installment = find(state, "parcelas", d["parcela_id"])
        require(when >= state["oportunidades"][installment["oportunidade_id"]]["aceita_em"], "Pagamento não pode anteceder o aceite.")
        money(d["valor_centavos"])
        nonempty(d["evidencia"], "evidencia")
        unused_finance_evidence(state, d["evidencia"], include_legacy=False)
        require(not any(p["evidencia"] == d["evidencia"] for p in state["pagamentos"].values()), "Evidência de pagamento já utilizada; possível lançamento duplicado. Para rateio, use referências distintas por parcela do comprovante.")
        require(paid(state, installment["id"]) + d["valor_centavos"] <= installment["valor_centavos"], "Pagamento excede o saldo da parcela.")
        state["pagamentos"][d["id"]] = {**deepcopy(d), "data": when}
        maybe_onboarding(state, installment["oportunidade_id"], when)
    elif kind == "despesa.registrada":
        fields(d, ["id", "descricao", "categoria", "valor_centavos", "vencimento"], ["cliente_id"])
        absent(state, "despesas", d["id"])
        nonempty(d["descricao"], "descricao")
        nonempty(d["categoria"], "categoria")
        money(d["valor_centavos"])
        valid_date(d["vencimento"], "vencimento")
        if "cliente_id" in d:
            find(state, "clientes", d["cliente_id"])
        state["despesas"][d["id"]] = {**deepcopy(d), "criada_em": when}
    elif kind == "despesa.paga":
        fields(d, ["id", "despesa_id", "valor_centavos", "evidencia"])
        absent(state, "pagamentos_despesas", d["id"])
        expense = find(state, "despesas", d["despesa_id"])
        require(when >= expense["criada_em"], "Saída não pode anteceder o registro da despesa.")
        money(d["valor_centavos"])
        nonempty(d["evidencia"], "evidencia")
        unused_finance_evidence(state, d["evidencia"], include_legacy=False)
        require(not any(p["evidencia"] == d["evidencia"] for p in state["pagamentos_despesas"].values()), "Evidência de saída já utilizada; possível lançamento duplicado.")
        require(expense_paid(state, expense["id"]) + d["valor_centavos"] <= expense["valor_centavos"], "Pagamento excede o saldo da despesa.")
        state["pagamentos_despesas"][d["id"]] = {**deepcopy(d), "data": when}
    elif kind == "pessoal.lancamento_registrado":
        fields(d, ["id", "descricao", "categoria", "sentido", "valor_centavos", "moeda", "vencimento", "fonte"])
        absent(state, "lancamentos_pessoais", d["id"])
        for key in ("descricao", "categoria", "fonte"):
            nonempty(d[key], key)
        require(isinstance(d["sentido"], str) and d["sentido"] in {"entrada", "saida"}, "sentido deve ser entrada ou saida.")
        money(d["valor_centavos"])
        finance_currency(d["moeda"])
        valid_date(d["vencimento"], "vencimento")
        state["lancamentos_pessoais"][d["id"]] = {**deepcopy(d), "criado_em": when}
    elif kind == "pessoal.movimento_registrado":
        fields(d, ["id", "lancamento_id", "valor_centavos", "evidencia"])
        absent(state, "movimentos_pessoais", d["id"])
        entry = find(state, "lancamentos_pessoais", d["lancamento_id"])
        require(when >= entry["criado_em"], "Movimento não pode anteceder o registro do lançamento pessoal.")
        money(d["valor_centavos"])
        unused_finance_evidence(state, d["evidencia"])
        amount = finance_paid(state, "movimentos_pessoais", "lancamento_id", entry["id"])
        require(amount + d["valor_centavos"] <= entry["valor_centavos"], "Movimento excede o saldo do lançamento pessoal.")
        state["movimentos_pessoais"][d["id"]] = {**deepcopy(d), "data": when, "moeda": entry["moeda"]}
    elif kind == "transferencia.prevista":
        fields(d, ["id", "descricao", "origem", "destino", "valor_centavos", "moeda", "vencimento", "fonte"],
               ["conta_origem", "conta_destino"])
        absent(state, "transferencias_internas", d["id"])
        for key in ("descricao", "fonte", "conta_origem", "conta_destino"):
            if key in d:
                nonempty(d[key], key)
        for key in ("origem", "destino"):
            require(isinstance(d[key], str) and d[key] in {"empresa", "pessoal"}, f"{key} deve ser empresa ou pessoal.")
        require(d["origem"] != d["destino"], "Transferência interna deve ligar empresa e pessoal em sentidos opostos.")
        money(d["valor_centavos"])
        finance_currency(d["moeda"])
        valid_date(d["vencimento"], "vencimento")
        state["transferencias_internas"][d["id"]] = {**deepcopy(d), "criada_em": when}
    elif kind == "transferencia.realizada":
        fields(d, ["id", "transferencia_id", "valor_centavos", "evidencia_origem", "evidencia_destino"])
        absent(state, "movimentos_transferencias", d["id"])
        transfer = find(state, "transferencias_internas", d["transferencia_id"])
        require(when >= transfer["criada_em"], "Realização não pode anteceder o registro da transferência.")
        money(d["valor_centavos"])
        for key in ("evidencia_origem", "evidencia_destino"):
            unused_finance_evidence(state, d[key])
        amount = finance_paid(state, "movimentos_transferencias", "transferencia_id", transfer["id"])
        require(amount + d["valor_centavos"] <= transfer["valor_centavos"], "Realização excede o saldo da transferência.")
        # Um único evento grava as duas pontas, ou nenhuma; não cria receita/despesa externa.
        state["movimentos_transferencias"][d["id"]] = {
            "id": d["id"], "transferencia_id": d["transferencia_id"], "valor_centavos": d["valor_centavos"],
            "moeda": transfer["moeda"], "data": when,
            "pontas": [{"esfera": transfer[side], "sentido": direction, "valor_centavos": d["valor_centavos"],
                        "evidencia": d[f"evidencia_{side}"]} for side, direction in (("origem", "saida"), ("destino", "entrada"))],
        }
    elif kind == "projeto.criado":
        fields(d, ["id", "cliente_id", "nome", "responsavel"], ["status", "prazo", "descricao"])
        absent(state, "projetos", d["id"])
        client = find(state, "clientes", d["cliente_id"])
        require(when >= client["criado_em"], "Projeto não pode anteceder o cadastro do cliente.")
        state["projetos"][d["id"]] = {**project_values(d), "status": d.get("status", "planejado"),
                                     "criado_em": when, "atualizado_em": when}
    elif kind == "projeto.atualizado":
        fields(d, ["id"], ["nome", "responsavel", "status", "prazo", "descricao"])
        require(len(d) > 1, "Informe pelo menos um campo do projeto para atualizar.")
        project = find(state, "projetos", d["id"])
        require(when >= project["atualizado_em"], "Atualização não pode anteceder o último registro do projeto.")
        if project["status"] in {"concluido", "cancelado"}:
            require(d.get("status", project["status"]) == project["status"],
                    "Projeto encerrado não pode ser reaberto nem trocar seu status final; crie novo projeto para novo escopo.")
        project.update(project_values(d), atualizado_em=when)
    elif kind == "nota.registrada":
        fields(d, ["id", "cliente_id", "texto"])
        absent(state, "notas", d["id"])
        client = find(state, "clientes", d["cliente_id"])
        require(when >= client["criado_em"], "Nota não pode anteceder o cadastro do cliente.")
        nonempty(d["texto"], "texto")
        state["notas"][d["id"]] = {**deepcopy(d), "data": when}
    elif kind == "tarefa.criada":
        fields(d, ["id", "titulo", "responsavel"], ["cliente_id", "oportunidade_id", "prazo", "status", "resultado"])
        absent(state, "tarefas", d["id"])
        require(not d["id"].startswith("auto--"), "Prefixo auto-- é reservado às tarefas do motor.")
        nonempty(d["titulo"], "titulo")
        nonempty(d["responsavel"], "responsavel")
        if "cliente_id" in d:
            find(state, "clientes", d["cliente_id"])
        if "oportunidade_id" in d:
            opportunity = find(state, "oportunidades", d["oportunidade_id"])
            require("cliente_id" not in d or d["cliente_id"] == opportunity["cliente_id"], "Cliente da tarefa difere do cliente da oportunidade.")
        if "prazo" in d:
            valid_date(d["prazo"], "prazo")
        status = d.get("status", "pendente")
        require(isinstance(status, str) and status in TASK_STATUSES, "Status de tarefa inválido.")
        result = d.get("resultado", "")
        require(isinstance(result, str), "resultado precisa ser texto.")
        if status in {"concluida", "cancelada", "bloqueada"}:
            nonempty(result, "resultado/motivo")
        state["tarefas"][d["id"]] = {**deepcopy(d), "status": status, "resultado": result,
            "criada_em": when, "atualizada_em": when, "automatica": False}
    elif kind == "tarefa.atualizada":
        fields(d, ["id", "responsavel", "status", "resultado"], ["prazo", "titulo"])
        task = find(state, "tarefas", d["id"])
        require(when >= task["atualizada_em"], "Atualização não pode anteceder o último estado da tarefa.")
        nonempty(d["responsavel"], "responsavel")
        require(isinstance(d["status"], str) and d["status"] in TRANSITIONS[task["status"]], "Transição de status de tarefa inválida. Tarefa encerrada não é reaberta; crie outra vinculada.")
        nonempty(d["resultado"], "resultado")
        if "titulo" in d:
            nonempty(d["titulo"], "titulo")
        if "prazo" in d:
            valid_date(d["prazo"], "prazo")
        task.update(deepcopy(d), atualizada_em=when)
    else:
        raise OperationError(f"Tipo de evento não suportado: {kind}.")


def apply(root, event):
    validate_event(event)
    digest = fingerprint(event)
    with locked(root):
        state = load_state(root)
        previous = state["eventos"].get(event["id"])
        if previous:
            require(previous["hash"] == digest, f"Conflito: evento {event['id']} já existe com outro conteúdo.")
            return {"status": "repetido_sem_alteracao", "evento_id": event["id"]}
        working = deepcopy(state)
        process(working, event)
        working["eventos"][event["id"]] = {"hash": digest, "evento": deepcopy(event)}
        atomic_write(state_path(root), json_text(working), overwrite=True)
    return {"status": "aplicado", "evento_id": event["id"], "tipo": event["tipo"]}


def brl(value):
    sign = "-" if value < 0 else ""
    units, cents = divmod(abs(value), 100)
    return f"{sign}R$ {units:,}".replace(",", ".") + f",{cents:02d}"


def totals(state, as_of):
    valid_date(as_of, "as-of")
    fees = [p for p in state["parcelas"].values() if state["oportunidades"][p["oportunidade_id"]]["natureza"] == "honorarios"]
    transfers = [p for p in state["parcelas"].values() if state["oportunidades"][p["oportunidade_id"]]["natureza"] != "honorarios"]
    expected = sum(p["valor_centavos"] for p in fees)
    received = sum(paid(state, p["id"]) for p in fees)
    transfers_expected = sum(p["valor_centavos"] for p in transfers)
    transfers_received = sum(paid(state, p["id"]) for p in transfers)
    expenses = sum(p["valor_centavos"] for p in state["despesas"].values())
    outgoing = sum(p["valor_centavos"] for p in state["pagamentos_despesas"].values())
    return {
        "receita_prevista_centavos": expected, "receita_recebida_centavos": received,
        "receita_saldo_centavos": expected - received,
        "receita_atrasada_centavos": sum(p["valor_centavos"] - paid(state, p["id"]) for p in fees if p["vencimento"] < as_of),
        "repasse_previsto_centavos": transfers_expected, "repasse_recebido_centavos": transfers_received,
        "repasse_saldo_centavos": transfers_expected - transfers_received,
        "repasse_atrasado_centavos": sum(p["valor_centavos"] - paid(state, p["id"]) for p in transfers if p["vencimento"] < as_of),
        "despesa_prevista_centavos": expenses, "despesa_paga_centavos": outgoing,
        "despesa_saldo_centavos": expenses - outgoing,
        "despesa_atrasada_centavos": sum(p["valor_centavos"] - expense_paid(state, p["id"]) for p in state["despesas"].values() if p["vencimento"] < as_of),
        "fluxo_liquido_registrado_centavos": received + transfers_received - outgoing,
    }


def finance_summary(state, as_of, scope="empresa"):
    require(scope in FINANCE_SCOPES, "Escopo financeiro inválido.")
    company = totals(state, as_of)
    personal = {}
    for prefix, direction in (("receita", "entrada"), ("despesa", "saida")):
        entries = [p for p in state["lancamentos_pessoais"].values() if p["sentido"] == direction]
        expected = sum(p["valor_centavos"] for p in entries)
        realized = sum(finance_paid(state, "movimentos_pessoais", "lancamento_id", p["id"]) for p in entries)
        suffixes = ("prevista", "recebida", "saldo", "atrasada") if prefix == "receita" else ("prevista", "paga", "saldo", "atrasada")
        overdue = sum(p["valor_centavos"] - finance_paid(state, "movimentos_pessoais", "lancamento_id", p["id"])
                      for p in entries if p["vencimento"] < as_of)
        personal.update({f"{prefix}_{suffix}_centavos": value if entries else None
                         for suffix, value in zip(suffixes, (expected, realized, expected - realized, overdue))})
    for prefix, present in (
        ("receita", any(state["oportunidades"][p["oportunidade_id"]]["natureza"] == "honorarios" for p in state["parcelas"].values())),
        ("repasse", any(state["oportunidades"][p["oportunidade_id"]]["natureza"] != "honorarios" for p in state["parcelas"].values())),
        ("despesa", bool(state["despesas"])),
    ):
        if not present:
            for key in company:
                if key.startswith(prefix + "_"):
                    company[key] = None
    company_moves = bool(state["pagamentos"] or state["pagamentos_despesas"])
    personal_moves = bool(state["movimentos_pessoais"])
    if not company_moves:
        company["fluxo_liquido_registrado_centavos"] = None
    personal["fluxo_liquido_registrado_centavos"] = (
        (personal["receita_recebida_centavos"] or 0) - (personal["despesa_paga_centavos"] or 0) if personal_moves else None)
    for sphere, area in (("empresa", company), ("pessoal", personal)):
        for direction, side in (("entrada", "destino"), ("saida", "origem")):
            entries = [p for p in state["transferencias_internas"].values() if p[side] == sphere]
            expected = sum(p["valor_centavos"] for p in entries)
            realized = sum(finance_paid(state, "movimentos_transferencias", "transferencia_id", p["id"]) for p in entries)
            overdue = sum(p["valor_centavos"] - finance_paid(state, "movimentos_transferencias", "transferencia_id", p["id"])
                          for p in entries if p["vencimento"] < as_of)
            area.update({f"transferencia_{direction}_{suffix}_centavos": value if entries else None
                         for suffix, value in zip(("prevista", "realizada", "saldo", "atrasada"),
                                                  (expected, realized, expected - realized, overdue))})
        has_moves = (company_moves if sphere == "empresa" else personal_moves) or bool(state["movimentos_transferencias"])
        area["fluxo_com_transferencias_centavos"] = (
            (area["fluxo_liquido_registrado_centavos"] or 0) + (area["transferencia_entrada_realizada_centavos"] or 0)
            - (area["transferencia_saida_realizada_centavos"] or 0) if has_moves else None)
        area["saldo_bancario_centavos"] = None
        area["situacao"] = "registros_parciais" if any(value is not None for key, value in area.items() if key.endswith("_centavos")) else "nao_informado"
    result = {"escopo": scope, "moeda": "BRL", "base": "registros informados; sem conciliação bancária automática"}
    if scope in {"empresa", "consolidado"}:
        result["empresa"] = company
    if scope in {"pessoal", "consolidado"}:
        result["pessoal"] = personal
    if scope == "consolidado":
        consolidated = {}
        for key in company:
            if key.startswith(("receita_", "repasse_", "despesa_")) or key == "fluxo_liquido_registrado_centavos":
                values = [area[key] for area in (company, personal) if area.get(key) is not None]
                consolidated[key] = sum(values) if values else None
        if state["movimentos_transferencias"] and consolidated["fluxo_liquido_registrado_centavos"] is None:
            consolidated["fluxo_liquido_registrado_centavos"] = 0
        consolidated["efeito_transferencias_centavos"] = 0 if state["movimentos_transferencias"] else None
        consolidated["saldo_bancario_centavos"] = None
        result["consolidado"] = consolidated
    return result


def status(root, as_of=None, finance_scope="empresa"):
    state = load_state(root)
    as_of = as_of or date.today().isoformat()
    summary = finance_summary(state, as_of, finance_scope)
    visible = (*LEGACY_COLLECTIONS, *CRM_COLLECTIONS) if finance_scope == "empresa" else COLLECTIONS
    return {"status": "ok", "referencia_vencimentos": as_of,
        "contagens": {name: len(state[name]) for name in visible},
        **({"totais": totals(state, as_of)} if finance_scope != "pessoal" else {}),
        "financeiro": summary,
        "observacao_totais": "totais preserva somas legadas da empresa; zeros não comprovam ausência de obrigações. Use financeiro para distinguir dados não informados.",
        "tarefas_abertas": sum(t["status"] not in {"concluida", "cancelada"} for t in state["tarefas"].values())}


def safe_output(root, path, forbidden=()):
    target = Path(path).resolve()
    require(not target.is_relative_to(state_path(root).parent), "Saídas não podem substituir arquivos dentro de dados/.")
    require(all(target != Path(p).resolve() for p in forbidden), "Saída não pode substituir template, aprovação ou campos de origem.")
    return target


def md(value):
    return str(value).replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")


def finance_report_lines(summary):
    def amount(value):
        return "Não informado" if value is None else brl(value)

    lines = ["## Controle financeiro", "", "Moeda: BRL. Saldo bancário: **Não informado**. Sem saldo de abertura e extratos conciliados, os movimentos não permitem apurar o saldo disponível.", ""]
    for sphere, title in (("empresa", "Empresa — GRAVV"), ("pessoal", "Pessoal — acesso privado"), ("consolidado", "Consolidado — acesso privado")):
        if sphere not in summary:
            continue
        area = summary[sphere]
        lines += [f"### {title}", "", "| Movimento | Previsto | Recebido / pago | Saldo pendente | Atrasado |",
                  "| --- | ---: | ---: | ---: | ---: |"]
        rows = [("Honorários de propostas aceitas" if sphere == "empresa" else "Receitas externas", "receita", ("prevista", "recebida", "saldo", "atrasada")),
                ("Despesas registradas", "despesa", ("prevista", "paga", "saldo", "atrasada"))]
        if sphere != "pessoal":
            rows.insert(1, ("Repasses: verba de mídia e reembolsos", "repasse", ("previsto", "recebido", "saldo", "atrasado")))
        if sphere != "consolidado":
            rows += [("Transferências internas — entrada", "transferencia_entrada", ("prevista", "realizada", "saldo", "atrasada")),
                     ("Transferências internas — saída", "transferencia_saida", ("prevista", "realizada", "saldo", "atrasada"))]
        for label, prefix, suffixes in rows:
            cells = " | ".join(amount(area.get(f"{prefix}_{suffix}_centavos")) for suffix in suffixes)
            lines.append(f"| {label} | {cells} |")
        lines += ["", f"Fluxo externo registrado: **{amount(area['fluxo_liquido_registrado_centavos'])}**. Inclui repasses quando existentes; não é saldo bancário nem lucro apurado.", ""]
        if sphere != "consolidado":
            lines += [f"Fluxo registrado incluindo transferências internas: **{amount(area['fluxo_com_transferencias_centavos'])}**.", ""]
        else:
            lines += ["Transferências empresa ↔ pessoal são eliminadas do consolidado; não aumentam a receita externa. Categorias e valores dependem dos registros fornecidos.", ""]
    return lines


def report(root, output, as_of=None, overwrite=False, finance_scope="empresa"):
    state = load_state(root)
    as_of = as_of or date.today().isoformat()
    t = totals(state, as_of)
    summary = finance_summary(state, as_of, finance_scope)
    lines = ["# GRAVV — posição operacional", "", f"Referência para vencimentos: {as_of}.", "",
        "Totais incluem todos os registros atuais. Esta referência não reconstrói saldo histórico. Vencido significa vencimento anterior à referência; o próprio dia ainda não está vencido.", "",
        "Valores recebidos e pagos são lançamentos com referência de evidência informada; não houve conferência bancária automática.", ""]
    lines += finance_report_lines(summary)
    company_lines = ["## Clientes e oportunidades", "", f"Clientes: {len(state['clientes'])}. Oportunidades: {len(state['oportunidades'])}.", "",
        "| Oportunidade | Cliente | Serviço | Natureza | Estado | Contrato assinado |", "| --- | --- | --- | --- | --- | --- |"]
    for o in state["oportunidades"].values():
        company_lines.append(f"| {md(o['id'])} | {md(state['clientes'][o['cliente_id']]['nome'])} | {md(o['servico'])} | {o['natureza']} | {o['status']} | {'sim' if o['contrato_assinado'] else 'não'} |")
    company_lines += ["", "## Contas a receber", "", "| Parcela | Oportunidade | Vencimento | Entrada | Previsto | Recebido | Saldo |", "| --- | --- | --- | --- | ---: | ---: | ---: |"]
    for p in state["parcelas"].values():
        amount = paid(state, p["id"])
        company_lines.append(f"| {md(p['id'])} | {md(p['oportunidade_id'])} | {p['vencimento']} | {'sim' if p['entrada'] else 'não'} | {brl(p['valor_centavos'])} | {brl(amount)} | {brl(p['valor_centavos'] - amount)} |")
    company_lines += ["", "## Contas a pagar", "", "| Despesa | Categoria | Vencimento | Previsto | Pago | Saldo |", "| --- | --- | --- | ---: | ---: | ---: |"]
    for e in state["despesas"].values():
        amount = expense_paid(state, e["id"])
        company_lines.append(f"| {md(e['id'])}: {md(e['descricao'])} | {md(e['categoria'])} | {e['vencimento']} | {brl(e['valor_centavos'])} | {brl(amount)} | {brl(e['valor_centavos'] - amount)} |")
    company_lines += ["", "## Tarefas e passagens entre setores", "", "| ID | Tarefa | Responsável | Status | Prazo | Resultado / próxima passagem |", "| --- | --- | --- | --- | --- | --- |"]
    for task in state["tarefas"].values():
        company_lines.append(f"| {md(task['id'])} | {md(task['titulo'])} | {md(task['responsavel'])} | {task['status']} | {task.get('prazo', '—')} | {md(task['resultado'] or 'Aguardando execução')} |")
    if finance_scope != "pessoal":
        lines += company_lines
    if finance_scope in {"pessoal", "consolidado"}:
        lines += ["", "## Lançamentos pessoais", "", "| ID / descrição | Categoria | Sentido | Vencimento | Previsto | Realizado | Pendente | Fonte |", "| --- | --- | --- | --- | ---: | ---: | ---: | --- |"]
        for p in state["lancamentos_pessoais"].values():
            amount = finance_paid(state, "movimentos_pessoais", "lancamento_id", p["id"])
            lines.append(f"| {md(p['id'])}: {md(p['descricao'])} | {md(p['categoria'])} | {p['sentido']} | {p['vencimento']} | {brl(p['valor_centavos'])} | {brl(amount)} | {brl(p['valor_centavos'] - amount)} | {md(p['fonte'])} |")
        lines += ["", "## Movimentos pessoais com evidência", "", "| Movimento | Lançamento | Data real | Valor | Evidência |", "| --- | --- | --- | ---: | --- |"]
        for p in state["movimentos_pessoais"].values():
            lines.append(f"| {md(p['id'])} | {md(p['lancamento_id'])} | {p['data']} | {brl(p['valor_centavos'])} | {md(p['evidencia'])} |")
    lines += ["", "## Transferências entre empresa e pessoal", "", "| ID | Origem → destino | Vencimento | Previsto | Realizado | Pendente |", "| --- | --- | --- | ---: | ---: | ---: |"]
    for p in state["transferencias_internas"].values():
        amount = finance_paid(state, "movimentos_transferencias", "transferencia_id", p["id"])
        lines.append(f"| {md(p['id'])} | {p['origem']} → {p['destino']} | {p['vencimento']} | {brl(p['valor_centavos'])} | {brl(amount)} | {brl(p['valor_centavos'] - amount)} |")
    if finance_scope in {"pessoal", "consolidado"}:
        lines += ["", "### Pontas realizadas das transferências", "", "| Movimento | Transferência | Data real | Esfera | Sentido | Valor | Evidência |", "| --- | --- | --- | --- | --- | ---: | --- |"]
        for p in state["movimentos_transferencias"].values():
            for leg in p["pontas"]:
                lines.append(f"| {md(p['id'])} | {md(p['transferencia_id'])} | {p['data']} | {leg['esfera']} | {leg['sentido']} | {brl(leg['valor_centavos'])} | {md(leg['evidencia'])} |")
    lines += ["", f"Eventos preservados no diário: {len(state['eventos'])}.", ""]
    target = safe_output(root, output)
    atomic_write(target, "\n".join(lines), overwrite)
    return {"status": "relatorio_criado", "arquivo": str(target),
            **({"totais": t} if finance_scope != "pessoal" else {}), "financeiro": summary}


def render_contract(root, client_id, template, approval, output, opportunity_id=None, extra_fields=None, overwrite=False):
    require(template and Path(template).is_file(), "PENDENTE: falta o arquivo de template externo escolhido pelo usuário.")
    require(approval and Path(approval).is_file(), "PENDENTE: falta a aprovação registrada do template; nenhum contrato foi gerado.")
    template_path = Path(template)
    raw = template_path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeError as exc:
        raise OperationError("Template deve ser texto UTF-8 (.txt ou .md), sem alterar cláusulas.") from exc
    nonempty(text, "template")
    approved = read_json(approval)
    fields(approved, ["aprovado", "template_sha256", "aprovado_por", "data_aprovacao"], label="aprovação")
    require(approved["aprovado"] is True, "PENDENTE: template ainda não aprovado.")
    nonempty(approved["aprovado_por"], "aprovado_por")
    valid_date(approved["data_aprovacao"], "data_aprovacao")
    require(approved["template_sha256"] == hashlib.sha256(raw).hexdigest(), "PENDENTE: hash do template difere da aprovação. A versão alterada precisa de aprovação própria.")
    state = load_state(root)
    client = find(state, "clientes", client_id)
    eligible = [o for o in state["oportunidades"].values() if o["cliente_id"] == client_id and o["status"] == "aceita"]
    if opportunity_id:
        opportunity = find(state, "oportunidades", opportunity_id)
        require(opportunity in eligible, "Oportunidade não é uma proposta aceita deste cliente.")
    else:
        require(len(eligible) == 1, "Informe --opportunity: o cliente precisa ter uma única proposta aceita para seleção automática.")
        opportunity = eligible[0]
    installments = sorted((p for p in state["parcelas"].values() if p["oportunidade_id"] == opportunity["id"]), key=lambda p: (p["vencimento"], p["id"]))
    values = {f"cliente.{key}": str(client[key]) for key in ("id", "nome", "documento", "email") if key in client}
    values.update({f"oportunidade.{key}": str(opportunity[key]) for key in ("id", "servico", "escopo", "valor_centavos", "natureza")})
    values["oportunidade.valor"] = brl(opportunity["valor_centavos"])
    values["oportunidade.parcelas"] = "\n".join(f"{p['id']}: {brl(p['valor_centavos'])}; vencimento {p['vencimento']}; entrada: {'sim' if p['entrada'] else 'não'}" for p in installments)
    if extra_fields:
        extra = read_json(extra_fields)
        obj(extra, "campos extras")
        for key, value in extra.items():
            require(bool(re.fullmatch(r"[a-z][a-z0-9_.]*", key)), f"Nome de campo extra inválido: {key}.")
            require(not key.startswith(("cliente.", "oportunidade.")), f"Campo oficial não pode ser sobrescrito: {key}.")
            values[key] = nonempty(value, f"campo {key}")
    placeholders = PLACEHOLDER.findall(text)
    require(bool(placeholders), "Template não contém campos {{campo}}; não é possível vincular o documento aos registros.")
    residue = PLACEHOLDER.sub("", text)
    require("{{" not in residue and "}}" not in residue, "Template contém placeholder com sintaxe inválida.")
    for key in placeholders:
        require(key in values and bool(values[key].strip()), f"PENDENTE: falta preencher o campo {key}.")
        require("{{" not in values[key] and "}}" not in values[key], f"Campo {key} contém delimitadores de template; substituição recursiva não é permitida.")
    required_contract_fields = {"cliente.nome", "oportunidade.escopo", "oportunidade.valor", "oportunidade.parcelas"}
    require(required_contract_fields.issubset(placeholders), "PENDENTE: o template precisa incluir cliente.nome, oportunidade.escopo, oportunidade.valor e oportunidade.parcelas para vincular as condições aceitas.")
    rendered = PLACEHOLDER.sub(lambda match: values[match.group(1)], text)
    target = safe_output(root, output, [template, approval] + ([extra_fields] if extra_fields else []))
    atomic_write(target, rendered, overwrite)
    return {"status": "minuta_preenchida", "arquivo": str(target), "cliente_id": client_id,
        "oportunidade_id": opportunity["id"], "template_sha256": approved["template_sha256"],
        "observacao": "Preenchimento do template aprovado; não registra assinatura, envio ou revisão jurídica."}


def parser():
    command = argparse.ArgumentParser(description=__doc__)
    sub = command.add_subparsers(dest="command", required=True)
    for name in ("init", "apply", "status", "report", "render-contract"):
        current = sub.add_parser(name)
        current.add_argument("--root", required=True, help="Pasta 08-OPERACAO-GRAVV ou base de teste isolada")
        if name == "apply":
            current.add_argument("--event", required=True, help="Arquivo com um único evento JSON")
        if name in ("status", "report"):
            current.add_argument("--as-of", help="AAAA-MM-DD, referência para vencimentos")
            current.add_argument("--finance-scope", choices=sorted(FINANCE_SCOPES), default="empresa",
                                 help="empresa por padrão; pessoal e consolidado contêm informações privadas")
        if name in ("report", "render-contract"):
            current.add_argument("--output", required=True)
            current.add_argument("--overwrite", action="store_true")
        if name == "render-contract":
            current.add_argument("--client", required=True)
            current.add_argument("--opportunity")
            current.add_argument("--template")
            current.add_argument("--approval")
            current.add_argument("--fields")
    return command


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            result = init(args.root)
        elif args.command == "apply":
            result = apply(args.root, read_json(args.event))
        elif args.command == "status":
            result = status(args.root, args.as_of, args.finance_scope)
        elif args.command == "report":
            result = report(args.root, args.output, args.as_of, args.overwrite, args.finance_scope)
        else:
            result = render_contract(args.root, args.client, args.template, args.approval, args.output,
                                     args.opportunity, args.fields, args.overwrite)
        print(json_text(result), end="")
        return 0
    except (OperationError, OSError, UnicodeError) as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
