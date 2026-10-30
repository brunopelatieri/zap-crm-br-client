# Flows Forms Lib — Arquitetura e Padrões

> **Relatório técnico** sobre a bibliotéca de forms reutilizáveis que alimenta o editor visual de fluxos no ZAP CRM BR.  
> Escrito como referência para portar padrões similares a outros projetos (ex.: automação de licitações públicas com agentes de IA).

---

## 1. Visão Geral

### O que é

`src/components/flows/forms/` é uma **biblioteca de componentes React reutilizáveis** que renderiza e gerencia formulários de configuração por tipo de nó. Cada nó (ex.: "enviar mensagem", "enviar botões", "condição") tem sua própria forma de edição, mas compartilham:

- **Primitivos de UI** (campos de texto, selects, dropdowns)
- **Sistema de validação** (tipos TypeScript discriminados)
- **Padrão de callback** (edições sobem via `onUpdateConfig`)
- **Contexto compartilhado** (lista de nós, tradução i18n, metadados)

### Contexto de uso

A lib é montada em **dois contextos diferentes**:

1. **List view** (`flow-builder.tsx`) — formulário colapsado dentro de um card de nó
2. **Canvas view** (`flow-canvas.tsx`) — painel lateral expandido quando clica num nó

Mesmo código, dois layouts. Isso foi a razão de extrair a lib para `src/components/flows/forms/`: garantir paridade 100% entre os dois contextos.

### Arquivos

```
src/components/flows/forms/
  ├── fields.tsx              # 3 componentes: TextRow, NextNodeRow, NodeKeySelect
  └── node-config-form.tsx    # 10 cases de node_type, cada um com sua forma sub-renderizada
```

---

## 2. Arquitetura e Padrões

### 2.1 Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Callers (flow-builder.tsx / flow-canvas.tsx)               │
│  ├─ Montam <NodeConfigForm> e fornecem:                     │
│  │  • node: BuilderNode                                     │
│  │  • allNodes: BuilderNode[]                               │
│  │  • onUpdateConfig: (patch) => void                       │
│  │  • showAdvanced: boolean                                 │
│  └─ Recebem callbacks de edição                             │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  NodeConfigForm (dispatcher)                                │
│  • Switch por node_type                                     │
│  • Renderiza a forma específica                             │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  Per-node forms (10 cases)                                   │
│  ├─ SendButtonsForm, SendListForm, etc.                     │
│  └─ Cada um é um sub-componente que:                        │
│     • Lê apenas os campos relevantes da config              │
│     • Chama onUpdateConfig com patch JSONB                  │
│     • Reutiliza primitivos (TextRow, NextNodeRow, etc.)     │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│  Primitivos (TextRow, NextNodeRow, NodeKeySelect)           │
│  • Input/Textarea do shadcn/ui                              │
│  • Select (dropdown) com ícones de nó                       │
│  • Labels + styling consistente                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Fluxo de dados

```
Usuário edita input em SendButtonsForm
              ↓
          onChange={...}
              ↓
          updateButton() (local state mutation helper)
              ↓
          onUpdateConfig({ buttons: [...] })
              ↓
          Caller (flow-builder ou flow-canvas) recebe o patch
              ↓
          Persiste em estado local (Redux/Zustand/etc)
              ↓
          Próximo render: BuilderNode.config atualizado
              ↓
          Form re-renderiza com novo valor
```

**Key insight:** A forma nunca tem estado local (exceto `uploading` em `SendMediaForm` — temporário). Tudo é **controlled component** — props fluem de cima para baixo, callbacks sobem para cima.

### 2.3 Padrão de extensão

Adicionar um novo tipo de nó requer **3 mudanças**:

1. **Type definition** (`src/lib/flows/types.ts`):
   ```typescript
   export interface NewNodeConfig {
     field1: string;
     field2?: number;
     next_node_key: string;
   }
   // Estender FlowNodeConfig union
   ```

2. **Metadata** (`src/components/flows/shared.tsx`):
   ```typescript
   export type NodeType = 'start' | ... | 'new_node'; // Adicione aqui
   export const NODE_META: Record<NodeType, {...}> = {
     ...
     new_node: {
       label: 'My new node',
       icon: MyIcon,
       color: 'text-cyan-400',
       blurb: 'Does something cool',
       category: 'logic',
     },
   };
   ```

3. **Form case** (`src/components/flows/forms/node-config-form.tsx`):
   ```typescript
   case 'new_node':
     return (
       <NewNodeForm
         cfg={cfg as NewNodeConfig}
         allNodes={allNodes}
         currentKey={node.node_key}
         onUpdateConfig={onUpdateConfig}
         showAdvanced={showAdvanced}
         t={t}
       />
     );
   ```

Falta **uma** dessas 3 = a forma fica quebrada e TypeScript acusa (exhaustiveness check no switch).

---

## 3. Tecnologias Usadas

### Stack

| Camada | Tecnologia | Função |
| --- | --- | --- |
| **UI Base** | `shadcn/ui` | Input, Textarea, Select, Button |
| **Icons** | `lucide-react` | Ícones do tipo de nó + ações (Plus, Trash2, etc.) |
| **Storage** | Supabase Storage (`flow-media` bucket) | Upload de mídia privada (fotos, vídeos, PDFs) |
| **i18n** | `next-intl` | Rótulos e placeholders em pt-BR/en |
| **Type safety** | TypeScript + discriminated unions | Props, configs, exhaustiveness checks |
| **Styling** | Tailwind v4 + `cn()` utility | Responsive grid, cores por tipo de nó |
| **State** | React hooks (`useState`, `useCallback`, `useRef`) | Upload em progresso, file input ref |
| **Async** | `useEffect` + cleanup | Carregamento de tags, assinatura de mídia (temporário) |

### Decisões de design

1. **Sem state local** (exceto `uploading`): Simplifica reasoning e torna o componente testável isoladamente.

2. **Callbacks acima de Redux/Zustand**: O caller gerencia o estado global. A form é "dumb" — só edita patch local e reporta.

3. **TypeScript discriminated unions**: Força exhaustiveness no switch de node_type. Adicionar um tipo novo sem implementar a forma = erro de compilação.

4. **Ícones do Lucide como props**: Evita import gigante; apenas o ícone do tipo atual é incluído no bundle.

5. **Tailwind grid dinâmico**: `md:grid-cols-[1fr_2fr_2fr_auto]` se advanced, `md:grid-cols-[2fr_2fr_auto]` se não. Responsivo sem media queries manualmente escritas.

---

## 4. Componentes

### 4.1 Primitivos (`fields.tsx`)

#### `TextRow`

```typescript
<TextRow
  label="Texto para o cliente"
  value={message}
  onChange={setMessage}
  rows={2}  // Textarea se > 1, Input se 1
/>
```

**Props:**
- `label` (string): Rótulo visível (traduzido externamente)
- `value` (string): Valor controlado
- `onChange` ((string) => void): Callback de edição
- `rows` (number, default 1): Se > 1, renderiza Textarea em vez de Input

**Padrão de uso:** Todo campo de texto livre usa isso. Centraliza:
- Label styling (`text-xs text-muted-foreground`)
- Input styling (`bg-muted`)
- Lógica de switcheroo (Input vs Textarea)

---

#### `NodeKeySelect`

```typescript
<NodeKeySelect
  value={nextNodeKey}
  nodes={allNodes}
  excludeKey={currentNode.node_key}  // Evita auto-loop
  onChange={setNextNodeKey}
  placeholder="Próximo nó…"
/>
```

**Props:**
- `value` (string | null): Chave do nó destino
- `nodes` (BuilderNode[]): Todos os nós do fluxo
- `excludeKey` (string?): Nó a ignorar no dropdown
- `onChange` ((string | null) => void): Callback
- `placeholder` (string?): Texto quando vazio
- `className` (string?): Classes Tailwind extras

**Padrão:** Renderiza um Select onde cada opção mostra:
- Ícone colorido do tipo do nó
- node_key como label

Isso evita opções como "btn_1", "btn_2" sem contexto. O ícone + label fazem a intent ficar clara.

**Internals:**
- Usa valor especial `__none__` para "nenhum" em vez de aceitar `null` (Select do shadcn exige string)
- Transforma `__none__` ↔ `null` nas bordas

---

#### `NextNodeRow`

```typescript
<NextNodeRow
  value={nextNodeKey}
  allNodes={allNodes}
  currentKey={node.node_key}
  onChange={setNextNodeKey}
  label="Depois, ir para…"
/>
```

**Props:** Mesmas que `NodeKeySelect`, + `label`.

**O que é:** Wrapper que monta `NodeKeySelect` dentro de um `<label>` + `<div>`. Economiza repetição quando a maioria dos nós tem um "próximo nó".

---

### 4.2 Dispatcher (`NodeConfigForm`)

Função principal que recebe um `BuilderNode` e despacha para a forma correta.

```typescript
export function NodeConfigForm({
  node,
  allNodes,
  showAdvanced,
  onUpdateConfig,
}: NodeConfigFormProps) {
  const t = useTranslations('Flows.builder.form');
  const cfg = node.config;
  
  switch (node.node_type) {
    case 'start':
      return <NextNodeRow ... />;
    case 'send_message':
      return <> <TextRow .../> <NextNodeRow .../> </>;
    case 'send_buttons':
      return <SendButtonsForm cfg={cfg as SendButtonsCfg} ... />;
    // ... 10 cases total
  }
}
```

**Pattern:**
- Casos simples (start, send_message, end) renderizam 1-2 primitivos direto
- Casos complexos (send_buttons, send_list, condition) delegam para sub-componentes
- TypeScript força exhaustiveness: se esquecer um caso, erro na compilação

---

### 4.3 Forms por tipo de nó

#### 1. **start**, **send_message**, **end**

Simples. `start` e `send_message` têm `NextNodeRow`. `end` é apenas uma mensagem de ajuda.

#### 2. **send_buttons** (`SendButtonsForm`)

```
Body text (TextRow com 3 linhas)
Footer text (TextRow)
[Botões iterados]
  └─ [grid dinâmico por showAdvanced]
      └─ Se advanced: reply_id (Input monospace)
      └─ Title (Input, max 20 chars)
      └─ Next node (NodeKeySelect)
      └─ Delete (Button)
[Add button] se < 3
```

**Lógica:**
- `buttons` vem de `cfg.buttons` (array)
- `updateButton(idx, patch)` → clona array + substitui índice
- `removeButton(idx)` → filter
- `addButton()` → gera `reply_id` como `btn_${length + 1}`

**Constraints:**
- Max 3 botões (limite da Meta Cloud API)
- Title max 20 chars
- reply_id é slugificado automaticamente

#### 3. **send_list** (`SendListForm`)

```
Body text (TextRow com 3 linhas)
[2-col grid]
  ├─ Button label
  └─ Footer text
[Sections iteradas]
  └─ Section title (Input)
      └─ Delete section (Button) se > 1
      └─ [Rows dentro de section]
          └─ grid por showAdvanced
              └─ reply_id? Title Next Delete
      └─ [Add row] se total < 10
[Add section] se < 10
```

**Estrutura de dados:**
```typescript
sections: [
  {
    title: "Billing",
    rows: [
      { reply_id: "row_1", title: "Fatura", next_node_key: "..." },
      ...
    ]
  },
  ...
]
```

**Constraints:**
- Max 10 seções (Meta)
- Max 10 linhas total (Meta)
- Rows slugificadas por `updateRow(sIdx, rIdx, patch)`

#### 4. **send_media** (`SendMediaForm`)

```
Media type dropdown (image | video | document)
File picker
  ├─ Se vazio: botão "Clique para upload"
  ├─ Se uploading: spinner + "Enviando…"
  └─ Se pronto: chip com nome + ícone X
Caption (TextRow)
Filename (Input, só se document)
Next node (NextNodeRow)
```

**Detalhes técnicos:**

- Upload para bucket `flow-media` (escopo por conta via RLS)
- File input ref escondido, disparado por clique no botão
- `handleFile` valida:
  - Tamanho (max 16 MB)
  - MIME type (depende de `media_type`)
- `useMediaSrc(url)` → assinatura temporária (S3-style signed URL)
- Quando muda `media_type`, limpa `media_url` e `filename`

**Mimes aceitos:**
```typescript
const MEDIA_ACCEPT = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document: 'application/pdf,...' // 9 tipos
};
```

#### 5. **collect_input**

```
Prompt to customer (TextRow, 2 linhas)
[Variable key]
  ├─ Input monospace + validation (alphanumeric + underscore)
  └─ Ajuda: {{vars.name}}
Next node (NextNodeRow)
```

**Validação:**
```typescript
var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '')
```

Apenas alphanumeric + `_`. Tudo mais é descartado ao digitar.

#### 6. **condition** (`ConditionForm`)

```
[3-col grid]
  ├─ If (subject picker: var | tag | contact_field)
  └─ Subject key (depende de subject)
      ├─ Se tag: Select de tags (async carregado)
      ├─ Se contact_field: Select fixo (name/email/phone/company)
      └─ Se var: Input monospace
Operator (Select: present | absent | equals | contains)
Value (Input, mostrado só se operator = equals/contains)
[2-col grid]
  ├─ If true advance to (NextNodeRow)
  └─ If false advance to (NextNodeRow)
```

**Lógica condicional:**
- `showValue` = `operator === 'equals' || operator === 'contains'`
- Muda `subject` → reseta `subject_key`

**Hook de tags:** `useUserTags()` carrega via `/api/tags` e cai back para Input se endpoint não existe (deploy antigo).

#### 7. **set_tag** (`SetTagForm`)

```
[2-col grid]
  ├─ Mode (add | remove)
  └─ Tag (Select ou Input fallback)
Then advance to (NextNodeRow)
```

Semelhante ao `condition`, mas mais simples: só picker de tag + modo.

#### 8. **handoff**

```
Internal note (TextRow, 2 linhas)
```

Apenas uma nota (armazenada em `flow_run_events.payload.note`). Nenhuma navegação.

---

## 5. Tipos e Interfaces

### BuilderNode (em `shared.tsx`)

```typescript
export interface BuilderNode {
  node_key: string;                    // Identificador estável
  node_type: NodeType;                 // Discriminador
  config: Record<string, unknown>;     // JSONB — config por tipo
  position_x?: number;                 // Canvas only
  position_y?: number;                 // Canvas only
}
```

### Discriminated Union (em `types.ts`)

```typescript
export type FlowNodeConfig =
  | { node_type: 'start'; config: StartNodeConfig }
  | { node_type: 'send_message'; config: SendMessageNodeConfig }
  | { node_type: 'send_buttons'; config: SendButtonsNodeConfig }
  // ... 10 total
```

Força TypeScript a aceitar **apenas** as config shapes válidas por tipo.

### NodeType (em `shared.tsx`)

```typescript
export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'collect_input'
  | 'condition'
  | 'set_tag'
  | 'handoff'
  | 'end';
```

Mantem sincronizado com `NODE_META` keys. Se divergir, tanto add-menus quanto forms quebram.

---

## 6. i18n (Internacionalização)

Todas as strings de label, placeholder, help text vêm de `useTranslations('Flows.builder.form')`.

**Chaves em `messages/en.json`:**

```json
{
  "Flows": {
    "builder": {
      "form": {
        "textToCustomer": "Text to customer",
        "advancesTo": "Advances to",
        "pickNextNode": "Pick a node…",
        "bodyText": "Body text",
        "footerText": "Footer text",
        "buttonsHelp": "Up to 3 buttons",
        "addButton": "Add button",
        "varKeyLabel": "Variable key",
        "varKeyPlaceholder": "my_answer",
        "varKeyHelp": "Reference in conditions or handoff notes via",
        // ... 40+ chaves
      }
    }
  }
}
```

**Espelho em pt-BR.json:** Mesmas chaves, valores traduzidos. Validado por `npm run i18n:check`.

**Padrão:** Nunca hardcode strings inglesas em componentes. Use `const label = t('keyName')`.

---

## 7. Lições Aprendidas e Anti-patterns

### ✅ O que funciona

1. **Controlled components everywhere** — nenhuma state local em campos (exceto async `uploading`)
2. **Discriminated unions** — TypeScript obriga exaustividade
3. **Reusable primitives** — `TextRow` + `NextNodeRow` evita copy-paste
4. **Callback acima, não Redux** — mais simples, testável, desacoplado
5. **JSONB config** — cada nó carrega a shape exata que precisa; schema é flexível
6. **Icons como componentes** — renderizam corretamente, importação automática otimizada
7. **Separate presentation from logic** — Forms só lidam com UI; validação vive em `src/lib/flows/validate.ts`

### ❌ Anti-patterns evitados

1. **Estado local que diverge** — form diverge do caller se houver cache local
2. **Hardcoded strings** — impossível traduzir; use `t()`
3. **Node type picker sem ícone** — opções viram "btn_1", "btn_2" sem contexto
4. **Um gigantesco arquivo de form** — dividir por tipo mantém cada case legível
5. **Validação na form** — a form renderiza; validação vive em `src/lib/flows/validate.ts` e roda ao salvar

---

## 8. Fluxo de Salvamento

```
Usuário clica "Save flow"
         ↓
Caller (flow-builder) chama validate(flow)
         ↓
Validator (src/lib/flows/validate.ts) roda:
  • Todas as referências node_key existem?
  • Nenhum nó órfão?
  • Config shapes match tipos?
  • Button titles <= 20 chars?
         ↓
   Se válido: Caller faz POST /api/flows/[id]
   Se inválido: Toast de erro + não salva
         ↓
Backend persiste em Supabase (flows + flow_nodes)
```

A form **nunca valida** — apenas renderiza inputs. Isso mantém o UX fluido (nenhum "campo inválido" piscando) e garante que o backend é a fonte de verdade.

---

## 9. Exemplo Completo: Adicionar um Novo Node Type

### Cenário

Adicionar um nó `delay` que aguarda N minutos antes de avançar.

### Passo 1: Type definition

`src/lib/flows/types.ts`:

```typescript
export interface DelayNodeConfig {
  delay_minutes: number;
  next_node_key: string;
}

export type FlowNodeConfig =
  | ... // existing
  | { node_type: 'delay'; config: DelayNodeConfig };
```

### Passo 2: Metadata

`src/components/flows/shared.tsx`:

```typescript
export type NodeType = ... | 'delay';

export const NODE_META: Record<NodeType, {...}> = {
  ...existing,
  delay: {
    label: 'Delay',
    icon: Clock, // import Clock from 'lucide-react'
    color: 'text-orange-400',
    blurb: 'Waits before advancing',
    category: 'flow',
  },
};
```

### Passo 3: Summarizer

`shared.tsx` — estender `summarizeNode()`:

```typescript
case 'delay': {
  const mins = typeof cfg.delay_minutes === 'number' ? cfg.delay_minutes : 0;
  return mins > 0 ? `Wait ${mins}m` : null;
}
```

### Passo 4: Form

`src/components/flows/forms/node-config-form.tsx`:

```typescript
case 'delay':
  return (
    <DelayForm
      cfg={cfg as DelayNodeConfig}
      allNodes={allNodes}
      currentKey={node.node_key}
      onUpdateConfig={onUpdateConfig}
      t={t}
    />
  );
```

Adicionar a function:

```typescript
function DelayForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: DelayNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      <div>
        <label className="text-muted-foreground mb-1 block text-xs">
          {t('delayMinutes')} {/* Adicionar em messages/en.json */}
        </label>
        <Input
          type="number"
          value={cfg.delay_minutes ?? 0}
          onChange={(e) =>
            onUpdateConfig({
              delay_minutes: Math.max(1, parseInt(e.target.value) || 0),
            })
          }
          min="1"
          className="bg-muted"
        />
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ''}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t('advancesTo')}
      />
    </>
  );
}
```

### Passo 5: i18n

`messages/en.json`:

```json
"Flows": {
  "builder": {
    "form": {
      "delayMinutes": "Wait (minutes)"
    }
  }
}
```

`messages/pt-BR.json`:

```json
"Flows": {
  "builder": {
    "form": {
      "delayMinutes": "Aguardar (minutos)"
    }
  }
}
```

### Pronto!

TypeScript avisará se esquecer qualquer step. O nó aparece no add-menu, renderiza nos dois contextos (list + canvas), e salva na DB.

---

## 10. Referências Externas

### Padrões React

- **Controlled components:** https://react.dev/reference/react-dom/components/input#controlling-an-input-with-a-state-variable
- **Hooks (useCallback, useRef, useEffect):** https://react.dev/reference/react
- **TypeScript discriminated unions:** https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-func.html#discriminated-unions

### Bibliotecas usadas

- **shadcn/ui:** https://ui.shadcn.com/ — Componentes headless React
- **Lucide React:** https://lucide.dev/ — Ícones SVG
- **next-intl:** https://next-intl-docs.vercel.app/ — i18n para Next.js 13+
- **Tailwind CSS v4:** https://tailwindcss.com/docs
- **Supabase Storage:** https://supabase.com/docs/guides/storage

### No ZAP CRM BR

- **Validação de flows:** `src/lib/flows/validate.ts`
- **Engine (executor):** `src/lib/flows/engine.ts`
- **Tipos de domínio:** `src/lib/flows/types.ts`
- **Editor visual (canvas):** `src/components/flows/flow-canvas.tsx`
- **Editor de lista:** `src/components/flows/flow-builder.tsx`

---

## 11. Desvios do ZAP CRM BR para Seus Projetos

### Ao portar para outro contexto (ex.: licitações públicas):

1. **Substitua shadcn/ui** — use sua própria lib de componentes. O padrão (TextRow, NextNodeSelect) continua válido.

2. **Valide em tempo de compilação** — discriminated unions são TI agressivo. Se seu contexto aceita mais flexibilidade, uma `Record<string, unknown>` pode funcionar (menos seguro, mais flexível).

3. **Assincron de opções** — `useUserTags()` carrega de `/api/tags`. Para licitações, seria `/api/participants`, `/api/agencies`, etc. O padrão é idêntico.

4. **Upload de arquivos** — no ZAP, é Supabase Storage. Em licitações, pode ser AWS S3, Azure Blob, ou GCS. A abstração é a mesma: `uploadFile()` retorna URL pública.

5. **i18n** — Next.js com next-intl é específico. Migre para `react-i18next` (React puro) ou similar se não usa Next.js.

6. **Callback vs state management** — aqui a forma reporta para o caller. Se seu projeto usa Redux/Zustand, a integração é simples: dispatch actions em vez de chamar callback.

---

## 12. Resumo da Arquitetura

| Aspecto | Solução |
| --- | --- |
| **Compartilhamento** | Primitivos (TextRow, NodeKeySelect) + tipos (BuilderNode) |
| **Extensão** | Adicionar type em 3 arquivos (types, shared, node-config-form) |
| **Validação** | No salvamento (via validate.ts), não na form |
| **State** | Controlled components; caller gerencia |
| **i18n** | `next-intl` + chaves em `messages/*.json` |
| **Estilo** | Tailwind grid dinâmico por `showAdvanced` |
| **Upload** | Supabase Storage + assinatura temporária |
| **Ícones** | Lucide React renderizado por NODE_META |
| **Type safety** | Discriminated unions + exhaustiveness checks |

---

**Última atualização:** setembro de 2026  
**Autor:** ZAP CRM BR team  
**Contexto:** Documentação de referência para reutilização em projetos similares.
