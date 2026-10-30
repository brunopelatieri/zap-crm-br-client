# PROMPT — PRD/SPEC Supabase Multi-Tenant por Cliente Owner

**Data:** 2026-10-02  
**Caso de uso:** Unificar `vn` (padrão) + `rs` (dedicado) com suporte a múltiplos Supabase por cliente owner  
**Primeiro cliente:** `rs` (já em produção)  
**Prioridade:** Alta

---

## 🎯 Objetivo

Permitir que o proprietário da plataforma (console `/admin`) crie **contas de cliente owner** com **Supabase dedicado**, mantendo um **Supabase padrão** (`.env`) como fallback. O sistema resolve qual Supabase usar baseado no `account_id` do user logado.

### Cenários

- **Cliente Owner padrão** (hoje): Cadastro normal → conta criada no Supabase `.env` → entrada em `clients` com `supabase_url = NULL`
- **Cliente Owner dedicado** (novo): Admin cria via `/admin` → URL/key de outro Supabase → entrada em `clients` com `supabase_url` preenchida
- **Primeiro caso real:** Cliente `rs` → migração de dados (`rs` → `vn`) → config aponta para novo Supabase

---

## 📐 Escopo

### ✅ **Dentro**

1. **Console do proprietário** (`/admin`):
   - Nova seção **"Supabase por Cliente"**
   - CRUD de clientes: criar, listar, editar (ativar/desativar), deletar
   - Campos por cliente:
     - `name` (ex: "Cliente RS")
     - `account_id` (associado a um account owner existente)
     - `supabase_url` (ex: `https://rs-project.supabase.co`)
     - `supabase_key_encrypted` (AES-256-GCM, só lê admin)
     - `is_active` (booleano)

2. **Validação de credenciais**:
   - Testar conexão ao Supabase fornecido (`GET /{project_id}`)
   - Verificar que schema matches (listar tabelas, comparar migrações aplicadas)
   - Feedback de erro se falhar

3. **Sincronização de migrações**:
   - Ao criar/editar cliente, aplicar todas as migrações pendentes no Supabase dedicado
   - Script de sincronização ou trigger automático

4. **Resolver dinâmico**:
   - Middleware/função que resolve: `user → account_id → supabase_url`
   - Se `account_id` não tem entrada em `clients` ou `supabase_url = NULL`, usa `.env`
   - Cache em memória (TTL 15 min) para não bater o banco a cada request

5. **Fallback**:
   - Se cliente dedicado falhar ou cai, **voltar para Supabase padrão** (graceful degradation)
   - Log de falha + tentativa de reconexão com backoff exponencial

6. **Comportamento preservado**:
   - Cliente owner **padrão** (sem entrada em `clients`): continua usando `.env` como hoje
   - Signup/login: continua criando `account` no Supabase padrão
   - Nenhuma quebra em clientes existentes

### ❌ **Fora**

| Item | Por quê |
|------|---------|
| Migração automática de dados entre Supabase | Fora de escopo — é processo manual operacional |
| Sincronização bidirecional de dados | v1 é read-only do admin para o Supabase cliente |
| Backup automático de Supabase cliente | Responsibility do cliente (Supabase oferece native) |
| Trocar Supabase de um cliente já ativo | Operacional — com downtime aceitável |

---

## 🏗️ Arquitetura esperada

### Tabela `clients` (nova, migração 088)

```sql
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  supabase_url TEXT UNIQUE, -- NULL = usa .env
  supabase_key_encrypted TEXT, -- AES-256-GCM com ENCRYPTION_KEY
  
  is_active BOOLEAN DEFAULT true,
  last_migration_check TIMESTAMPTZ,
  last_health_check TIMESTAMPTZ,
  last_health_error TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: admin+ só consegue CRUD
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Only admin can access clients"
  ON public.clients
  USING (is_account_member(account_id, 'admin'));
```

### Função de Resolução

```typescript
// src/lib/supabase/resolve-client.ts
async function resolveClientSupabase(userId: string): Promise<SupabaseClient> {
  // 1. Resolve account_id do user
  // 2. Busca config em clients (com cache)
  // 3. Retorna client (dedicado ou padrão)
  // 4. Se falha, fallback para .env com log de erro
}
```

### Rota de Validação (POST /api/admin/clients/validate)

```json
POST /api/admin/clients/validate
{
  "supabase_url": "https://xyz.supabase.co",
  "supabase_key": "eyJhbGc..."
}

// Response 200
{
  "valid": true,
  "project_name": "xyz",
  "tables_count": 47,
  "latest_migration": 087,
  "missing_migrations": []
}

// Response 400
{
  "valid": false,
  "error": "Invalid URL or key",
  "details": "Connection timed out"
}
```

---

## 📋 Fases sugeridas

| Fase | Entrega | Modelo | Obs |
|------|---------|--------|-----|
| **F0** | PRD/SPEC review + decisões D-1…D-5 (§4) | Manual | Bloqueia F1 |
| **F1** | Migração 088 + tipos `Client`, `ClientConfig` | Sonnet | Padrão Supabase |
| **F2** | Função `resolveClientSupabase()` + cache | Sonnet | Core do sistema |
| **F3** | Validação de credenciais + sync de migrações | **Opus** | Chamadas externas |
| **F4** | UI Admin: CRUD clientes (`/admin/supabase`) + i18n | Sonnet | 4 telas (list, create, edit, delete) |
| **F5** | Rota `/api/admin/clients` + testes unitários | Sonnet | POST/GET/PATCH/DELETE |
| **F6** | Integração no middleware + fallback | Sonnet | Garantir graceful degradation |
| **F7** | Code review high + testes de integração | Opus | Incluir cenário de falha |
| **F8** | Checklist manual: teste com 2 Supabase reais (vn + rs) | Manual | Proprietário |

---

## 🔑 Decisões esperadas (D-1…D-5)

**D-1: Identificação de cliente no resolver**
- [ ] Via `user_id` → `account_id` (atual proposta) ← **Recomendado**
- [ ] Via header (ex: `X-Client-ID`)
- [ ] Via subdomain (ex: `cli1.zapcrm.com`)

**D-2: Cache e TTL**
- [ ] Memória em processo (10 min) ← **Recomendado (padrão repo)**
- [ ] Redis (se disponível)
- [ ] Postgres + polling (1 min)

**D-3: Migração de dados na mudança de Supabase**
- [ ] Manual (dump/restore) ← **Para rs: será manual com scripts SQL**
- [ ] Script do admin fornecido
- [ ] Automático via endpoint

**D-4: Fallback — silencioso ou com aviso?**
- [ ] Silencioso (log só, sem notificação ao user) ← **Recomendado**
- [ ] Notificação ao admin in-app
- [ ] Bloqueio de operação até reconectar

**D-5: Encriptação da key do Supabase**
- [ ] Reutilizar `ENCRYPTION_KEY` (WhatsApp tokens) ← **Recomendado**
- [ ] Chave separada em `.env`
- [ ] Vault externo (Hashicorp/AWS Secrets)

---

## 📊 Contexto do repositório

| Item | Valor |
|------|-------|
| Stack | Next.js 16.2.6, React 19, TypeScript 6, Supabase Auth |
| i18n | next-intl v4 (en.json + pt-BR.json) |
| Autenticação | Supabase Auth + RLS |
| Console admin | `/admin` (SPEC 062, F9) — usar padrão existente |
| Testes | Vitest, co-locados |
| MCPs disponíveis | `vn` (padrão), `rs` (legado), para Supabase operations |
| Clientes atuais | `vn` (padrão, multi-tenant), `rs` (legado, será primeiro dedicado) |

---

## 🔄 Processo de unificação rs → vn

**Pré-requisitos (fora desta SPEC):**
1. Dados de `rs` copiados para `vn` (schema + dados do cliente)
2. Validação de integridade executada

**Com esta SPEC:**
1. Admin cria entry em `clients`: `account_id={rs_owner} → supabase_url={rs_url}`
2. App resolve `user_rs → account_rs → supabase_url_rs`
3. Cliente `rs` continua funcionando como antes (sem mudança de experiência)
4. Quando pronto: atualizar `supabase_url` para apontar para `vn` (com downtime mínimo)
5. Desativar `rs` (ou manter como backup)

---

## 📝 Aceitação

A SPEC está pronta quando:
- ✅ Tabela `clients` criada + RLS + seed (padrão + rs)
- ✅ Função `resolveClientSupabase()` testada (unit + integração)
- ✅ UI Admin funcional (CRUD completo, validação de URL/key)
- ✅ Validação de credenciais com sync de migrações
- ✅ Fallback para `.env` funcionando (teste de desconexão forçada)
- ✅ i18n: admin.supabase.* traduzido (en + pt-BR)
- ✅ Checklist manual passado (vn + rs reais)
- ✅ Zero clientes existentes afetados (teste de regressão)
- ✅ Código commitado (não mergeado ainda, aguardando aprovação do Bruno)

---

## 🔗 Referências

- [SPEC 062 — Console do proprietário](./spec-062-console-do-proprietario.md) (padrão para `/admin`)
- [AGENTS.md § Convenções](./AGENTS.md) (RLS, i18n, estrutura)
- [docs/comandos-desenvolvimento.md](./comandos-desenvolvimento.md) (validação local)
- Memória: [SPEC 076 — monitor de status](../memory/project_spec_076_monitor_cobranca.md) (como fazer multi-tenant bem)

---

## 📧 Entrega

Este prompt deve ser usado para:

1. **Criar PRD/SPEC oficial** em `docs/prd-088-supabase-por-cliente-owner.md` (ou SPEC se código é primeira)
2. **Revisar decisões D-1…D-5** com mantenedor
3. **Ratificar fases** e alocação de modelo (Sonnet/Opus)
4. **Confirmar caso de uso rs** como primeiro cliente dedicado

**Enviar para:** Bruno Pelatieri (mantenedor)  
**Slack/Email:** Com mensagem: "Preparei PRD/SPEC para Supabase dedicado por cliente owner. Review as decisões D-1…D-5 e aprova a ordem de fases? Primeiro caso: rs → dedicado."

---

**Fim do prompt.**
