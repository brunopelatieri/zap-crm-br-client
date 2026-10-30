# Agents & AI Components — Arquitetura e Padrões

> **Relatório técnico** sobre os componentes de interface e integração de IA no ZAP CRM BR.  
> Cobre o playground de testes, dashboard de uso de tokens, e a camada abstrata de providers.  
> Escrito como referência para portar padrões similares a outros projetos (ex.: automação de licitações públicas com agentes de IA).

---

## 1. Visão Geral

### O que é

`src/components/agents/` é uma biblioteca de **componentes React de interface para agentes de IA** (assistentes baseados em LLM) que falam com providers (OpenAI, Anthropic) via chaves de usuário (bring-your-own-key).

Trabalha em conjunto com `src/lib/ai/`, a camada lógica que:

- Carrega + descriptografa as chaves dos providers
- Normaliza chamadas entre OpenAI e Anthropic
- Registra consumo de tokens
- Gerencia contexto (documentos de knowledge base, mensagens, handoff)

### Contexto de uso

Os componentes aparecem em:

1. **Página `/agents/playground`** — teste interativo do agente antes de ativar auto-reply
2. **Aba "Configuração de IA" em `/settings`** — dashboard de consumo de tokens, status da integração
3. **Auto-reply workflow** — o motor roda invisível, mas o playground mostra como funciona

### Arquivos

```
src/components/agents/
  ├── ai-playground.tsx       # Chat interativo (tester)
  └── ai-usage.tsx            # Dashboard de consumo de tokens

src/lib/ai/
  ├── types.ts                # Tipos compartilhados (AiConfig, ChatMessage, AiError)
  ├── config.ts               # Carrega + descriptografa chaves
  ├── generate.ts             # Orquestra chamada a um provider
  ├── auto-reply.ts           # Motor de auto-reply (auto-dispatch)
  ├── providers/
  │   ├── anthropic.ts        # Adapter Anthropic
  │   ├── openai.ts           # Adapter OpenAI
  │   └── shared.ts           # Normalização, error handling
  ├── knowledge.ts            # Knowledge base (embeddings + retrieval)
  ├── embeddings.ts          # Preparação de chunks para embedding
  ├── chunk.ts               # Split de documentos em chunks
  ├── handoff.ts             # Lógica de transfer para humano
  ├── usage.ts               # Logging de consumo (ai_usage_log)
  └── ...
```

---

## 2. Arquitetura e Padrões

### 2.1 Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  React Components (ui)                                      │
│  ├─ AiPlayground (chat tester)                              │
│  └─ AiUsageCard (stats + gráfico)                           │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  Route Handlers (/api/ai/*)                                 │
│  ├─ POST /api/ai/playground   (generate + log usage)        │
│  ├─ GET  /api/ai/usage        (fetch stats)                 │
│  ├─ POST /api/ai/draft        (generate + strip handoff)    │
│  ├─ POST /api/ai/autoreply    (inbound dispatch)            │
│  └─ POST /api/ai/config       (update settings)             │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  Logic Layer (src/lib/ai/)                                  │
│  ├─ loadAiConfig()    (decrypt + load)                      │
│  ├─ generateReply()   (dispatch → provider)                 │
│  ├─ dispatchInboundToAi() (auto-reply)                      │
│  └─ queryKnowledgeBase() (retrieval)                        │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  Provider Adapters                                          │
│  ├─ callOpenAi()      (fetch → OpenAI API)                  │
│  ├─ callAnthropic()   (fetch → Anthropic API)               │
│  └─ normalizeUsage()  (tokens: OpenAI → AiUsage)            │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  External APIs                                              │
│  ├─ OpenAI Messages API (chat completion)                   │
│  ├─ Anthropic Messages API (chat completion)                │
│  └─ OpenAI Embeddings API (semantic search)                 │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Fluxo de dados

#### A. Playground (teste interativo)

```
Usuário digita mensagem em AiPlayground
              ↓
          onClick="send()"
              ↓
          POST /api/ai/playground
              │ body: { messages: [...] }
              ↓
        Route Handler
          ├─ loadAiConfig(db, accountId)
          ├─ generateReply(config, messages)
          │   ├─ callOpenAi() or callAnthropic()
          │   ├─ parseHandoff(response)  ← detecta "🤝" ou [HUMAN]
          │   └─ return { text, handoff, usage }
          ├─ logUsage(db, { model, tokens, mode: 'draft' })
          └─ return { reply, handoff }
              ↓
        Component recebe resposta
          ├─ Adiciona turn { role: 'assistant', content, handoff }
          └─ Re-renderiza transcript
```

#### B. Auto-reply (produção)

```
Inbound webhook recebe mensagem do WhatsApp
              ↓
        POST /api/whatsapp/webhook
              ├─ dispatchInboundToFlows()
              └─ dispatchInboundToAi()  ← se flow não consumiu
                  ├─ loadAiConfig(db, accountId, {requireActive})
                  ├─ generateReply(config, context)
                  │   └─ context = { contact info, conversation history, KB docs }
                  ├─ parseHandoff(response)
                  ├─ sendReply(contact_id, text, channel_id)
                  └─ logUsage(db, { mode: 'auto_reply' })
                      ↓
                  Resposta sai pelo WhatsApp
```

#### C. Usage Dashboard

```
Usuário acessa /settings#ai-usage
              ↓
        AiUsageCard monta
          ├─ GET /api/ai/usage?days=30
              │
              └─ Route Handler
                  ├─ SELECT FROM ai_usage_log
                  │   WHERE account_id = X
                  │   AND created_at > now() - 30 days
                  ├─ Aggregate by_model, by_mode, daily
                  └─ return UsageResponse
              ↓
        Component renderiza
          ├─ Stats cards (total_tokens, calls, by_mode)
          ├─ BarChart (tokens/day)
          └─ Model breakdown (provider, model, calls)
```

### 2.3 Padrão de integração de providers

```typescript
// 1. Define interface genérica
interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  timeoutMs: number;
}

// 2. Implementa para cada provider
async function callOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  // OpenAI-specific fetch logic
  // Returns { text, usage }
}

async function callAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  // Anthropic-specific fetch logic
  // Returns { text, usage }
}

// 3. Dispatcher agnóstico
async function generateReply(
  config: AiConfig,
  messages: ChatMessage[]
): Promise<GenerateResult> {
  const adapter = config.provider === 'openai' ? callOpenAi : callAnthropic;
  const { text, usage } = await adapter({
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt: config.systemPrompt || DEFAULT_PROMPT,
    messages,
    timeoutMs: 30000,
  });
  return { text, handoff: parseHandoff(text), usage };
}
```

**Key insight:** Cada provider é um arquivo isolado. A lógica de app (draft, auto-reply, playground) não sabe qual está sendo usado — apenas chama `generateReply()`.

---

## 3. Tecnologias Usadas

### Stack

| Camada | Tecnologia | Função |
| --- | --- | --- |
| **UI** | React 19 + shadcn/ui | Componentes, layout |
| **Chat** | Textarea + ref scrolling | Composer, auto-scroll |
| **Gráficos** | Tremor (BarChart) | Dashboard de uso |
| **Icons** | Lucide React | Status, ações (Send, Reset, etc.) |
| **Async** | `useEffect` + `useRef` + `useCallback` | Fetch, debounce, cleanup |
| **Auth** | `useAuth()` hook | Verificar role (admin only) |
| **i18n** | `next-intl` | Labels em pt-BR/en |
| **Encryption** | AES-256-GCM (Node.js `crypto`) | Chaves de API armazenadas encrypted |
| **Type safety** | TypeScript + discriminated unions | Providers, errors, configs |
| **Logging** | Supabase (ai_usage_log) | Auditoria de tokens |

### Decisões de design

1. **Bring-your-own-key** — usuário entra sua chave (OpenAI/Anthropic), nunca confiamos em chaves globais. Encriptado no Supabase.

2. **Provider abstraction** — two adapters (OpenAI, Anthropic), uma interface compartilhada. Adicionar Cohere/Llama é só um novo adapter.

3. **Typed errors** — `AiError` com `.code` e `.status` permite o UI/testes distinguir `invalid_key` de `rate_limited` de `timeout`.

4. **Handoff signalling** — o model envia `🤝` ou `[HUMAN]` no reply; `parseHandoff()` detecta e marca. Auto-reply processa isso para transferência.

5. **Usage logging** — toda chamada produtiva logs `ai_usage_log` com { account_id, model, tokens, mode, created_at }. Dashboard é uma agregação.

6. **Controlled transcript** — Playground monta um array de `Turn[]` localmente. Usuário edita input, onClick dispara fetch, callback atualiza state.

---

## 4. Componentes

### 4.1 AiPlayground

**Propósito:** Chat interativo para testar o agente antes de ativar auto-reply.

```typescript
<AiPlayground onGoToSetup={() => navigate('/settings')} />
```

**Props:**
- `onGoToSetup` (function?): Callback quando user clica "Go to setup" (empty state)

**State:**
- `turns: Turn[]` — array de mensagens { role, content, handoff? }
- `input: string` — valor do textarea
- `sending: boolean` — flag de fetch em progresso

#### Layout

```
┌─ Header ──────────────────────────────────┐
│  [Bot Icon] AI Playground  [Reset Button] │
├─ Transcript (scrollable) ──────────────────┤
│  👤 User message (right, blue bubble)      │
│  🤖 Agent reply (left, gray bubble)        │
│     └─ [🤝 Handoff note] se handoff       │
│  🤖 [Loader] Thinking...                   │
├─ Composer ────────────────────────────────┤
│  [Textarea] ↑  [Send Button]              │
└───────────────────────────────────────────┘
```

**Key behaviors:**

1. **Auto-scroll** — `useEffect` roda `scrollRef.current?.scrollTo()` após cada turn
2. **Enter to send** — `onKeyDown` envia se `key === 'Enter' && !shiftKey`
3. **Rollback on error** — se fetch falha, volta `turns` e restaura `input`
4. **Handoff badge** — se `data.handoff`, mostra note `[🤝 Transfer to human]`

#### Flow de envio

```typescript
const send = async () => {
  const text = input.trim();
  if (!text || sending) return;

  // 1. Append user turn
  const next = [...turns, { role: 'user', content: text }];
  setTurns(next);
  setInput('');
  setSending(true);

  try {
    // 2. POST /api/ai/playground
    const res = await fetch('/api/ai/playground', {
      method: 'POST',
      body: JSON.stringify({
        messages: next.map((t) => ({ role: t.role, content: t.content })),
      }),
    });

    // 3. Parse response
    const data = await res.json();
    if (!res.ok) {
      // Rollback se erro
      setTurns(turns);
      setInput(text);
      toast.error(data.error);
      return;
    }

    // 4. Append assistant turn
    setTurns([
      ...next,
      {
        role: 'assistant',
        content: data.reply || '',
        handoff: Boolean(data.handoff),
      },
    ]);
  } catch (err) {
    setTurns(turns);
    setInput(text);
    toast.error(t('agentUnreachable'));
  } finally {
    setSending(false);
  }
};
```

**Error codes:**
- `ai_not_configured` → "Set up your API key in Settings"
- Generic errors → "Agent is unreachable"

#### Turnos como objetos

```typescript
interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handoff?: boolean;  // assistant-only, sinaliza transferência
}
```

Simples: role + content. Handoff é um flag booleano.

---

### 4.2 AiUsageCard

**Propósito:** Dashboard de consumo de tokens por janela de tempo (7, 30, 90 dias).

```typescript
<AiUsageCard />
```

**Props:** Nenhuma. Interno: `accountId` via `useAuth()`, acesso checado por role.

**State:**
- `days: 7 | 30 | 90` — janela selecionada
- `loading: boolean` — fetch em progresso
- `data: UsageResponse | null` — resposta agregada

#### Data shape

```typescript
interface UsageResponse {
  window_days: number;
  truncated: boolean;  // true se há mais dados que 100 modelos / 1000 rows
  totals: {
    calls: number;           // Quantas chamadas
    prompt_tokens: number;   // Tokens de prompt (entrada)
    completion_tokens: number;
    total_tokens: number;
  };
  by_mode: {
    auto_reply: { calls: number; tokens: number };
    draft: { calls: number; tokens: number };      // playground + draft assists
  };
  by_model: Array<{
    model: string;        // "gpt-4o", "claude-3-sonnet", etc.
    provider: string;     // "openai", "anthropic"
    calls: number;
    tokens: number;
  }>;
  daily: Array<{
    date: string;         // "2026-09-15"
    tokens: number;
    calls: number;
  }>;
}
```

#### Layout

```
┌─ Header ──────────────────────────────────────────┐
│  [BarChart3] AI Token Usage  [Window Dropdown]     │
│  "See your account's token spend"                 │
├─ Grid de Stats ──────────────────────────────────┤
│  ┌─ Total Tokens ─┐ ┌─ LLM Calls ─┐ ...          │
│  │ 245.3K         │ │ 512         │               │
│  └─────────────────┘ └─────────────┘               │
├─ Tokens per Day (BarChart) ─────────────────────┤
│  [Sep 8] [Sep 9] [Sep 10] ... [Sep 15]            │
├─ By Model ────────────────────────────────────────┤
│  gpt-4o (openai)              120.4K tokens, 48c  │
│  claude-3-sonnet (anthropic)  125K tokens, 464c   │
└──────────────────────────────────────────────────┘
```

#### Permissões

```typescript
const { accountRole } = useAuth();
const canView = accountRole ? canEditSettings(accountRole) : false;

if (!canView) return null;  // Só admins veem
```

Só administradores veem consumo de tokens (info de billing).

#### Fetch com cache-busting

```typescript
useEffect(() => {
  if (!canView || !accountId) return;
  
  const key = `${accountId}:${days}`;
  if (loadedRef.current === key) return;  // Já carregou
  
  loadedRef.current = key;
  fetchUsage(days);
}, [canView, accountId, days, fetchUsage]);
```

Refetch quando:
- `days` muda (user clica outro window)
- `accountId` muda (switch de conta)

Não refetch se `loadedRef` já aponta para essa combinação (evita duplicate fetches).

#### Componente auxiliar: Stat

```typescript
function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof Bot;  // Opcional Lucide icon
}) {
  return (
    <div className="border-border rounded-md border p-3">
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="text-foreground mt-1 text-lg font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}
```

Reutilizado em 4 posições (total tokens, calls, auto_reply, draft).

---

## 5. Lógica de IA (src/lib/ai/)

### 5.1 Tipos centrais

#### AiConfig

```typescript
export interface AiConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;  // Descriptografado (plaintext em memória)
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  handoffAgentId: string | null;  // UUID de agente para handoff
  embeddingsApiKey: string | null;  // Para semantic search
}
```

Carregado por `loadAiConfig(db, accountId)`. Ambas as chaves (chat + embeddings) são decriptadas do banco.

#### ChatMessage

```typescript
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

Normalizado: funciona com qualquer provider.

#### AiError

```typescript
export class AiError extends Error {
  readonly code: string;  // 'invalid_key' | 'timeout' | 'rate_limited' | ...
  readonly status: number;  // HTTP status
}
```

Permite UI + testes distinguirem cenários:

```typescript
if (error.code === 'invalid_key') {
  return 401;  // Auth error
} else if (error.code === 'rate_limited') {
  return 429;  // Retry later
} else if (error.code === 'timeout') {
  return 504;  // Gateway timeout
}
```

#### GenerateResult

```typescript
export interface GenerateResult {
  text: string;           // Reply com handoff stripped
  handoff: boolean;       // true se model pediu transfer
  usage: AiUsage | null;  // Token counts
}
```

Retornado por `generateReply()`. Pronto para logar e exibir.

### 5.2 Config loading

```typescript
async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {}
): Promise<AiConfig | null> {
  const { data } = await db
    .from('ai_configs')
    .select('provider, model, api_key, ...')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!data) return null;
  if (opts.requireActive && !data.is_active) return null;
  if (!data.api_key) return null;

  return {
    provider: data.provider,
    model: data.model,
    apiKey: decrypt(data.api_key),  // ← AES-256-GCM
    systemPrompt: data.system_prompt,
    isActive: data.is_active,
    autoReplyEnabled: data.auto_reply_enabled,
    autoReplyMaxPerConversation: data.auto_reply_max_per_conversation,
    handoffAgentId: data.handoff_agent_id,
    embeddingsApiKey: data.embeddings_api_key ? decrypt(data.embeddings_api_key) : null,
  };
}
```

**Comportamento:**
- Retorna `null` se não há config (BYO key nunca foi setada)
- Retorna `null` se `is_active === false` (toggle "master switch")
- Throws se chave não pode ser descriptografada (erro de `ENCRYPTION_KEY`)
- Embeddings key corruptível é tolerada (cai back para lexical KB)

### 5.3 Generate (orquestração)

```typescript
export async function generateReply(
  config: AiConfig,
  messages: ChatMessage[],
  opts: { contextDoc?: string; timeoutMs?: number } = {}
): Promise<GenerateResult> {
  const adapter = config.provider === 'openai' ? callOpenAi : callAnthropic;

  const systemPrompt =
    config.systemPrompt || DEFAULT_PROMPT;
  
  if (opts.contextDoc) {
    systemPrompt += `\n\n[Context from knowledge base]\n${opts.contextDoc}`;
  }

  try {
    const { text, usage } = await adapter({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      timeoutMs: opts.timeoutMs ?? 30000,
    });

    return {
      text: stripHandoff(text),
      handoff: parseHandoff(text),
      usage,
    };
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw toNetworkError(err);
  }
}
```

**Padrão:**
1. Escolher adapter baseado em `config.provider`
2. Montar system prompt (+ KB context se presente)
3. Chamar adapter com timeout
4. Parse handoff signal
5. Retornar typed result

### 5.4 Provider adapters

#### OpenAI

```typescript
async function callOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const url = 'https://api.openai.com/v1/chat/completions';
  
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        ...args.messages,
      ],
      temperature: 0.7,
      max_tokens: 500,
    }),
    timeout: args.timeoutMs,
  });

  if (!res.ok) {
    throw await providerHttpError('openai', res);
  }

  const json = (await res.json()) as OpenAiResponse;
  const text = json.choices[0]?.message?.content || '';
  
  const usage = normalizeUsage({
    prompt: json.usage?.prompt_tokens,
    completion: json.usage?.completion_tokens,
    total: json.usage?.total_tokens,
  });

  return { text, usage };
}
```

#### Anthropic

```typescript
async function callAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const url = 'https://api.anthropic.com/v1/messages';
  
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'x-api-key': args.apiKey,  // ← Header différent
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 500,
      system: args.systemPrompt,  // ← Param différent
      messages: args.messages,  // ← Pas de system message ici
    }),
    timeout: args.timeoutMs,
  });

  if (!res.ok) {
    throw await providerHttpError('anthropic', res);
  }

  const json = (await res.json()) as AnthropicResponse;
  const text = json.content[0]?.text || '';
  
  const usage = normalizeUsage({
    prompt: json.usage?.input_tokens,  // ← Clés différentes
    completion: json.usage?.output_tokens,
    total: undefined,  // Anthropic não envia total
  });

  return { text, usage };
}
```

**Diferenças:**
- OpenAI: `Authorization: Bearer`, `messages` inclui `system`
- Anthropic: `x-api-key`, `system` separado, usa `input`/`output`

`normalizeUsage()` abstrai essas diferenças.

### 5.5 Handoff signalling

```typescript
function parseHandoff(text: string): boolean {
  // Model pode sinalizar transfer via emoji ou tag
  return text.includes('🤝') || text.includes('[HUMAN]');
}

function stripHandoff(text: string): string {
  return text
    .replace(/🤝/g, '')
    .replace(/\[HUMAN\]/g, '')
    .trim();
}
```

**Instrução no system prompt:**

> Quando você não conseguir ajudar ou a conversa exigir um agente humano, sinalize com 🤝 no final da sua resposta.

Em auto-reply, se `handoff === true`, o motor:
1. Salva o contexto
2. Transfere a conversa para um agent humano
3. Para de responder automaticamente

---

## 6. Fluxos de Uso

### 6.1 Playground (teste)

```
User: "What's your name?"
↓
POST /api/ai/playground
  body: { messages: [{ role: 'user', content: 'What\'s your name?' }] }
↓
Handler:
  1. const config = await loadAiConfig(db, accountId, { requireActive: false })
     ↑ Permite testar mesmo se ainda não ativo
  2. const result = await generateReply(config, messages)
  3. await logUsage(db, { accountId, model: config.model, tokens: result.usage?.totalTokens, mode: 'draft' })
  4. return { reply: result.text, handoff: result.handoff }
↓
Response: { reply: "I'm Claude, an AI assistant...", handoff: false }
↓
Component:
  • Adiciona turn { role: 'assistant', content: reply, handoff: false }
  • Renderiza no transcript
```

**Por que `requireActive: false`?** User está testando. Queremos que possa ver como funciona antes de ativar auto-reply no master switch.

### 6.2 Auto-reply (produção)

```
Inbound webhook WhatsApp
  → dispatchInboundToFlows() (procura flow por keyword/trigger)
  → Se flow consumiu: sai
  → Se não: dispatchInboundToAi()
      ↓
      1. loadAiConfig(db, accountId, { requireActive: true })
         ↑ Só processa se is_active && auto_reply_enabled
      2. loadConversationHistory(db, conversationId, limit: 20)
      3. queryKnowledgeBase(config.embeddingsApiKey, query)
         ↑ Retorna top-3 chunks com scores
      4. generateReply(config, [...history], { contextDoc: relevantChunks })
      5. parseHandoff(result.text)
         ↑ Detecta se model quer transfer
      6. Se handoff:
           a. markConversationHandedOff(db)
           b. assignAgent(db, conversationId, config.handoffAgentId)
         Senão:
           a. sendReply(conversationId, result.text, channel_id)
      7. logUsage(db, { mode: 'auto_reply', tokens: result.usage?.totalTokens })
```

**Características:**
- Só roda se `is_active && auto_reply_enabled`
- Injeta contexto (histórico + KB top-3)
- Detecta handoff, transfere se sinalizado
- Loga tudo para dashboard

### 6.3 Draft assist (futuro)

Pla noem breve: usuário pode pedir "Draft a reply" e o modelo gera uma sugestão que o human revisa antes de enviar.

---

## 7. Knowledge Base (KB)

### Fluxo de ingestão

```
User faz upload de documento (.pdf, .txt, etc.)
         ↓
POST /api/ai/knowledge
         ↓
Handler:
  1. Chunk documento via chunkDocument(text)
     → Splits em ~500-char chunks com 50-char overlap
  2. Para cada chunk:
     a. Embed via OpenAI Embeddings API (se key presente)
     b. Salva em kb_documents { account_id, chunk_text, embedding, ... }
  3. Return { success, chunks_created }
         ↓
Dashboard mostra: "5 chunks added to knowledge base"
```

### Fluxo de retrieval

```
During generateReply():
  1. queryKnowledgeBase(embeddingsKey, query)
     ↓
     a. Embed query via OpenAI Embeddings API
     b. SQL: SELECT * FROM kb_documents
        ORDER BY embedding <-> query_embedding
        LIMIT 3
     c. Retorna top-3 chunks com scores
  2. Montar context_doc = "Relevant context:\n" + chunks.join('\n\n')
  3. Passar para generateReply(..., { contextDoc })
     ↓ Injeta no system prompt
```

**Fallback:** Se embeddings_key ausente/inválido, cai para lexical search (full-text).

---

## 8. Segurança

### Encrypt at rest

```typescript
// Ao salvar (admin route)
const encrypted = encrypt(plaintextApiKey);
await db.from('ai_configs').update({ api_key: encrypted });

// Ao carregar (qualquer rota)
const plaintext = decrypt(encryptedApiKey);  // Sobe para memória
generateReply(config);  // Usa brevemente
// Plaintext sai de scope → garbage collected
```

**Algoritmo:** AES-256-GCM (Node.js `crypto` module)

**Key source:** `process.env.ENCRYPTION_KEY` (rotated externamente)

**Risco:** Se `ENCRYPTION_KEY` vazar, todas as chaves são comprometidas. Mitigar com rotation + monitoring.

### RLS (Row-Level Security)

```sql
CREATE POLICY "ai_configs_account_isolation"
  ON ai_configs
  FOR SELECT
  USING (account_id = auth.uid()::uuid OR is_service_role());
```

Usuário A não consegue ler `ai_configs` de Usuário B mesmo com SQL direto.

### Usage logging é append-only

```sql
INSERT INTO ai_usage_log (account_id, model, mode, tokens, created_at)
VALUES (...);
```

Não há UPDATE/DELETE. Auditoria inviolável.

---

## 9. Lições Aprendidas

### ✅ O que funciona

1. **Provider abstraction** — um interface genérica, múltiplos adapters. Fácil adicionar novo provider.
2. **Typed errors** — distinguir `invalid_key` de `timeout` permite retry logic inteligente.
3. **Controlled transcript** — Playground é um array local. Re-render é rápido, estado previsível.
4. **Handoff signalling** — emoji 🤝 no reply é simples, resiliente, fácil para model treinar.
5. **Usage logging** — toda chamada registrada. Dashboard é view pura sobre logs imutáveis.
6. **Config caching** — carrega uma vez, reutiliza. Não refetch a cada reply.

### ❌ Anti-patterns evitados

1. **Não reutilizar chaves globais** — BYO key é mais seguro, usuário controla spend.
2. **Não confiar em plaintext keys no código** — sempre encrypt-at-rest + decrypt on-load.
3. **Não fazer logs assincrones** → pode perder dados se processo crasha. Logging é síncrono ou enfileirado via PG.
4. **Não misturar playground + produção** — playground cria logs "draft", produção cria "auto_reply". Fácil depurar.

---

## 10. Extensão: Adicionar um Novo Provider

### Cenário

Suporte a Cohere (alternativa a OpenAI/Anthropic).

### Passo 1: Interface

`src/lib/ai/types.ts`:

```typescript
export type AiProvider = 'openai' | 'anthropic' | 'cohere';

// Config table já tem provider como string, sem alterar schema
```

### Passo 2: Adapter

`src/lib/ai/providers/cohere.ts`:

```typescript
import { AiError, type ChatMessage } from '../types';
import { ProviderArgs, normalizeUsage, toNetworkError } from './shared';

export async function callCohere(args: ProviderArgs): Promise<ProviderResult> {
  const url = 'https://api.cohere.com/v1/chat';
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,  // "command-r-plus"
      chat_history: args.messages.map((m) => ({
        role: m.role === 'user' ? 'USER' : 'CHATBOT',
        message: m.content,
      })),
      message: args.systemPrompt,  // Cohere trata system como first user msg
      temperature: 0.7,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!res.ok) {
    throw await providerHttpError('cohere', res);
  }

  const json = await res.json() as CohereResponse;
  const text = json.text || '';
  
  const usage = normalizeUsage({
    prompt: json.meta?.billed_units?.input_tokens,
    completion: json.meta?.billed_units?.output_tokens,
  });

  return { text, usage };
}
```

### Passo 3: Dispatcher

`src/lib/ai/generate.ts`:

```typescript
import { callCohere } from './providers/cohere';

async function generateReply(config: AiConfig, messages: ChatMessage[], ...): Promise<GenerateResult> {
  let adapter;
  if (config.provider === 'openai') {
    adapter = callOpenAi;
  } else if (config.provider === 'anthropic') {
    adapter = callAnthropic;
  } else if (config.provider === 'cohere') {
    adapter = callCohere;  // ← Nova linha
  } else {
    throw new AiError('Unknown provider', { code: 'provider_not_supported', status: 400 });
  }

  // ... resto igual
}
```

### Passo 4: i18n

`messages/en.json`:

```json
{
  "Agents": {
    "config": {
      "providerCohere": "Cohere"
    }
  }
}
```

### Pronto!

Usuário pode agora:
1. Ir para `/settings#ai`
2. Selecionar "Cohere" no dropdown de provider
3. Entrar sua chave Cohere
4. Testar no playground
5. Ativar auto-reply

TypeScript garante que:
- `callCohere` retorna `ProviderResult` (mesma shape)
- Todos os providers são tratados no dispatcher
- Nenhum é esquecido

---

## 11. Referências Externas

### Providers

- **OpenAI API:** https://platform.openai.com/docs/api-reference/chat/create
- **Anthropic API:** https://docs.anthropic.com/en/api/messages
- **Cohere API:** https://docs.cohere.com/reference/chat

### Supabase

- **Encryption:** https://www.postgresql.org/docs/current/pgcrypto.html
- **RLS:** https://supabase.com/docs/guides/auth/row-level-security
- **Vector types (pgvector):** https://supabase.com/docs/guides/database/extensions/pgvector

### React patterns

- **useCallback + useRef:** https://react.dev/reference/react/useCallback
- **Controlled components:** https://react.dev/reference/react-dom/textarea

### ZAP CRM BR specific

- **Auto-reply engine:** `src/lib/ai/auto-reply.ts`
- **Knowledge base:** `src/lib/ai/knowledge.ts`
- **Usage logging:** `src/lib/ai/usage.ts`

---

## 12. Desvios para Seus Projetos

### Ao portar para licitações públicas:

1. **Contexto estruturado** — em licitações, o KB seria:
   - Editais (documentos longos, necessário chunking)
   - Jurisprudência (RFP patterns)
   - Regulamentações (LGPL, lei de licitações)
   
   Integração com `queryKnowledgeBase()` é idêntica.

2. **Agentes especializados** — LLMs podem ser finetunados para vocabulário de licitação.
   - Providers já suportam model selection
   - Adicione nova opção no dropdown provider.

3. **Handoff para compliance** — se modelo é incerto sobre regulamentação, sinaliza 🤝 para revisor humano.
   - `parseHandoff()` já existe
   - Customizar assignment logic em `config.handoffAgentId`

4. **Usage monetization** — sua plataforma cobra por token.
   - `ai_usage_log` já existe
   - Agregar diariamente para cobrar na fatura mensal

5. **Custom prompts** — cada account pode ter seu system prompt customizado.
   - `ai_config.system_prompt` já suporta
   - UI para editar em `/settings`

---

## 13. Resumo da Arquitetura

| Aspecto | Solução |
| --- | --- |
| **Integração** | BYO key (bring-your-own-key) + AES-256-GCM encrypt-at-rest |
| **Providers** | 2 adapters (OpenAI, Anthropic) + 1 shared interface; adicionar Cohere é isolado |
| **Erros** | Typed `AiError` com `.code` + `.status`; UI/testes usam para retry logic |
| **Playground** | Chat local com `Turn[]`; POST /api/ai/playground orquestra geração |
| **Auto-reply** | Webhook dispatch, context injection (histórico + KB), handoff detection |
| **Knowledge base** | Chunk → embed → search; fallback para lexical si embeddings indisponíveis |
| **Usage** | Logging append-only em `ai_usage_log`; dashboard agrega por mode/model/day |
| **i18n** | Labels via `next-intl`; error messages em inglês (para APIs) |
| **Type safety** | Discriminated unions; TypeScript força exhaustiveness |

---

**Última atualização:** setembro de 2026  
**Autor:** ZAP CRM BR team  
**Contexto:** Documentação de referência para reutilização em projetos similares com agentes de IA.
