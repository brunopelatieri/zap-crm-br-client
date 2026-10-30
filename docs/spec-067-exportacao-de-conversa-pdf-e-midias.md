# SPEC 067 — Exportação da conversa em PDF + ZIP com as mídias

| Campo            | Valor                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — aguardando ratificação das decisões D-1…D-12                                                                               |
| Data             | 2026-09-02                                                                                                                                |
| Escopo           | Inbox — exportar o histórico de uma conversa como PDF e baixar as mídias em `.zip`                                                        |
| Depende de       | SPEC 040 (mídia privada), SPEC 049 (inbox multicanal), SPEC 051 (padrão de exportação), SPEC 060 (retenção), SPEC 064 (múltiplos números)  |
| Migração         | `077_conversation_exports.sql` (a numeração livre é **077** — confira `ls supabase/migrations/` antes de criar)                            |
| Dependências npm | `pdf-lib`, `@pdf-lib/fontkit`, `fflate` + 3 arquivos de fonte vendorizados                                                                 |

---

## Contexto

Hoje o histórico de uma conversa só existe **dentro do produto**. Quem
precisa dele fora — e isso acontece o tempo todo no mercado brasileiro —
não tem saída:

- **Jurídico / Procon / juizado.** "Preciso do print de toda a conversa
  com esse cliente." O agente hoje tira dezenas de capturas de tela, uma
  a uma, e monta um documento à mão. Sem carimbo de quem exportou,
  quando e de qual número saiu — exatamente o que dá valor probatório ao
  material.
- **Passagem de bastão para outro sistema.** O contador, o despachante,
  a seguradora pedem "o histórico". Não existe formato de entrega.
- **LGPD, art. 18, II e V — acesso e portabilidade.** O titular pode
  pedir os dados que temos dele. A conversa inteira, com os anexos que
  ele mesmo mandou, é parte disso, e o prazo de resposta é curto.
- **Retenção (SPEC 060).** A varredura apaga mensagens antigas conforme
  a política da conta. Uma conversa que vai ser cortada em 30 dias não
  tem hoje como ser preservada antes do corte.

E as mídias agravam o problema. Desde a migração 040 os buckets
`chat-media` e `flow-media` são **privados**: a foto do comprovante, o
áudio do cliente e o PDF do contrato só existem atrás de uma URL
assinada de 10 minutos (`SIGNED_URL_TTL_SECONDS`). Não há como o agente
"salvar a pasta da conversa" — ele baixa arquivo por arquivo, pelo botão
de cada bolha (`src/components/inbox/media-download.tsx`), perdendo a
ordem cronológica e o vínculo com a mensagem que carregava o anexo.

O material existente já resolve metade do caminho: a SPEC 051 fixou o
padrão de exportação deste repositório (rota POST, cliente de sessão,
trilha de auditoria em tabela própria, arquivo montado em memória e
devolvido com `Content-Disposition`). Esta SPEC aplica o mesmo padrão à
conversa e acrescenta o que a exportação de contatos não precisou
enfrentar: **bytes binários vindos de três origens diferentes**.

---

## Objetivo

### O que esta SPEC entrega

1. Um botão **"Exportar conversa"** no menu do cabeçalho da thread
   (`message-thread.tsx`), abrindo um diálogo com: formato (**PDF** ou
   **PDF + mídias (.zip)**), período (tudo / intervalo de datas) e um
   resumo do que será exportado (nº de mensagens, nº de anexos).
2. Um **PDF paginado** com a conversa inteira em ordem cronológica:
   cabeçalho de identificação (contato, telefone E.164, canal, período,
   quem exportou, quando, id da exportação), separadores por dia, bolhas
   com remetente/horário/status, **imagens embutidas em linha**, cartões
   de anexo para vídeo/áudio/documento, citação de resposta, reações,
   prévia de template, botões interativos, selo de campanha de origem,
   selo de favorito e o motivo da falha quando a mensagem não foi
   entregue.
3. Um **`.zip`** contendo o PDF, a pasta `midias/` com **todos** os
   arquivos da conversa (imagem, vídeo, áudio, documento e sticker),
   nomeados de forma determinística e **referenciados nominalmente
   dentro do PDF**, mais um `MANIFESTO.csv` que amarra cada arquivo à
   mensagem que o carregava e um `LEIA-ME.txt`.
4. Uma **trilha de auditoria** (`conversation_exports`, migração 077) —
   quem exportou qual conversa, quando, quantas mensagens, quantas
   mídias, quantos bytes. Mesmo espírito de `contact_exports` (064).
5. Cobertura de teste co-locada em tudo que é puro: o modelo do
   transcrito, o plano de nomes de mídia, a partição de runs de fonte, a
   quebra de linha e o manifesto.

### Não-objetivos (explicitamente fora de escopo)

- **Exportar várias conversas de uma vez** (o contato pode ter uma
  conversa por canal — ver D-2). Esta SPEC exporta **uma thread**.
- **Exportar em lote / por filtro** ("todas as conversas fechadas de
  agosto"). É outra feature, com outro perfil de custo.
- **Miniatura de vídeo** no PDF. Extrair um frame exige `ffmpeg`, que
  não existe no host serverless. Vídeo vira cartão de anexo.
- **Transcrição de áudio** no PDF. Existe `src/lib/ai/` e isso é
  tentador, mas é custo de terceiro por exportação e uma decisão de
  produto separada.
- **Emoji colorido** no PDF. Ver §6 — o `pdf-lib` não interpreta tabelas
  de cor (COLR/CBDT). Emoji sai monocromático.
- **Assinatura digital / carimbo do tempo ICP-Brasil.** O cabeçalho e o
  rodapé carregam a identificação da exportação, o que cobre o uso
  corrente; assinatura qualificada é projeto próprio.
- **Envio do arquivo por e-mail.** O SMTP existe (SPEC 063), mas
  exportação é download síncrono, como na SPEC 051.

---

## Decisões a ratificar com o mantenedor

Nenhuma trava a escrita do código; todas mudam comportamento observável.
A recomendação está marcada com **→**.

| #    | Pergunta                                                                                    | Recomendação                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Qual papel mínimo pode exportar?                                                            | **→ `agent`**, somado à visibilidade da RLS (`can_access_conversation`): o agente exporta a conversa que ele já enxerga, e só ela. `viewer` fica de fora — quem não pode escrever também não leva a base. |
| D-2  | Exportar por **conversa** ou por **contato** (juntando as N conversas de canais diferentes)? | **→ por conversa.** É o que o cabeçalho da thread oferece e mantém "de qual número saiu" sem ambiguidade. Contato-com-N-canais entra depois, reusando os mesmos módulos, se a demanda aparecer.           |
| D-3  | Imagem embutida no PDF **e** repetida no ZIP, ou só no ZIP?                                 | **→ nos dois.** No PDF em resolução reduzida, para leitura; no ZIP o arquivo original, íntegro. Duplicar bytes é aceitável perto de perder a prova.                                                       |
| D-4  | Emoji no PDF: descartar, virar `:codigo:` ou embutir fonte monocromática?                   | **→ embutir Noto Emoji monocromática** (§6). Descartar muda o sentido da mensagem; `:codigo:` polui um documento que vai para o jurídico.                                                                 |
| D-5  | Tetos padrão (§5).                                                                          | **→ 10 000 mensagens, 500 arquivos, 100 MB de mídia no total, 50 MB por arquivo, 40 MB de imagem embutida.** Estourou → `413` com a sugestão de recortar o período.                                       |
| D-6  | Mídia que a Meta já expirou e que nunca foi para o bucket: falhar ou seguir?                | **→ seguir.** A linha entra no PDF e no `MANIFESTO.csv` com `status=ausente`. Uma foto perdida em 2024 não pode impedir a exportação de 2026.                                                             |
| D-7  | Fuso horário dos carimbos.                                                                  | **→ o do navegador de quem exporta**, enviado no corpo do POST e validado no servidor. Não há coluna de fuso na conta; assumir UTC produziria um documento que não bate com o que a tela mostra.          |
| D-8  | Mensagem apagada pela retenção (SPEC 060) aparece como lacuna?                              | **→ não.** O PDF exporta o que existe; o cabeçalho já declara o período coberto. Marcar "aqui havia algo" exigiria contabilidade que a 068 não guarda.                                                    |
| D-9  | Limitar frequência?                                                                         | **→ sim: 3 exportações por usuário a cada 10 min** (`checkRateLimit`). Uma exportação pode custar 100 MB de egresso do Storage.                                                                           |
| D-10 | Nome do arquivo final.                                                                      | **→ `conversa-<contato-slug>-<AAAA-MM-DD>.pdf` / `.zip`**, seguindo `contactExportFilename` da 051.                                                                                                       |
| D-11 | As fontes entram no repositório ou são baixadas por script?                                 | **→ no repositório**, sob `src/lib/inbox/export/fonts/`, com o `OFL.txt` ao lado. `scripts/` inteiro está no `.gitignore` (achado da SPEC 066) — um script de sync não sobreviveria ao clone.             |
| D-12 | `maxDuration` da rota.                                                                      | **→ 300 s**, com os tetos de D-5 dimensionados para caber. Se o host cortar em 60 s, baixar o teto de mídia para ~25 MB é o ajuste de uma linha.                                                          |

---

## 1. Arquitetura

### 1.1 O caminho de uma exportação

```
[diálogo no inbox]
      │  POST /api/inbox/conversations/<id>/export
      │  { format: 'pdf' | 'zip', from?, to?, locale, timeZone }
      ▼
[route handler]  requireRole('agent')  +  checkRateLimit
      │
      ├─► fetch-thread.ts ──── cliente de SESSÃO (RLS: can_access_conversation)
      │      conversa + contato + canal + perfis + mensagens (paginado)
      │
      ├─► model.ts (PURO) ──── Message[] → TranscriptBlock[]
      │      dia, bolha, anexo, evento; rótulos i18n injetados
      │
      ├─► media-plan.ts (PURO) ─ blocos → MediaPlanEntry[]
      │      nome determinístico, origem (bucket | meta | externo), dedupe
      │
      ├─► fetch-media.ts ────── bytes, pool de 6, tetos de D-5
      │      bucket: download direto  ·  meta: media_id + token do canal
      │
      ├─► pdf.ts ────────────── pdf-lib + fontkit → Uint8Array
      │
      ├─► zip.ts ────────────── fflate: PDF + midias/ + MANIFESTO.csv + LEIA-ME.txt
      │
      └─► trilha em `conversation_exports` (service role, best-effort)
             │
             ▼
      Response(bytes, Content-Disposition: attachment)
```

### 1.2 Por que no servidor, e por que com o cliente de sessão

**Servidor** porque os bytes não estão ao alcance do navegador em bloco:
`chat-media` é privado desde a 040 e a mídia recebida por Cloud API pode
só existir na Meta, atrás do token da conta — que **nunca** vai ao
cliente. Baixar 200 arquivos no navegador significaria 200 chamadas a
`/api/inbox/media/sign` e 200 assinaturas de 10 min circulando.

**Cliente de sessão** (`ctx.supabase`, não `supabaseAdmin()`) porque a
autorização é linha a linha e já está escrita em SQL: `messages_select` →
`can_access_conversation(conversation_id)`
(`supabase/migrations/039_conversation_assignment.sql:146`). Um agente
com a conversa atribuída a outro colega **não** enxerga aquelas
mensagens, e a exportação tem de herdar isso de graça, sem recodificar a
regra em TypeScript. Vale a mesma advertência que a rota-proxy de mídia
carrega em letras garrafais: **autenticar não é autorizar**.

`supabaseAdmin()` aparece em **um** lugar só: o `INSERT` na trilha de
auditoria, depois de o papel já ter sido checado — idêntico ao que a
SPEC 051 faz em `contact_exports`.

### 1.3 As três origens de um mesmo anexo

É a diferença essencial entre esta exportação e a de contatos. Para cada
mensagem com mídia, `resolveMediaRef(media_url, media_path)`
(`src/lib/storage/media-url.ts`) devolve uma de quatro coisas, e cada uma
exige um caminho diferente:

| `kind`     | Quando acontece                                                              | Como obter os bytes                                                                            |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `storage`  | Tudo que o agente enviou pós-040; toda mídia recebida pós-_download ansioso_  | `supabase.storage.from(bucket).download(path)`                                                 |
| `proxy`    | Mídia recebida por Cloud API cujo download ansioso falhou ou é anterior a ele | `getMediaUrl(media_id, token)` + `downloadMedia()`, com o token **do canal daquela mensagem**   |
| `external` | URL de terceiro colada pelo usuário (header de template, nó de flow)          | `fetch` direto — **passando pela guarda SSRF de `src/lib/webhooks/`** (§5)                      |
| `none`     | Mensagem de texto                                                            | nada a baixar                                                                                   |

O caso `proxy` é o que quebra na vida real: a Meta apaga mídia recebida
**bem antes** do que a documentação promete — é o comentário que motivou
o download ansioso em `src/app/api/whatsapp/webhook/route.ts:736`. Uma
conversa de um ano atrás vai ter anexos que não existem mais em lugar
nenhum. Por isso D-6: `status=ausente` no manifesto, cartão "mídia
indisponível" no PDF, e a exportação segue.

Para o `proxy`, o token correto é o do **canal da mensagem** (SPEC 064):
`resolveCloudConfig(supabase, accountId, message.channel_id ?? undefined)`.
Numa conta com dois números oficiais, o token do outro número devolve 404
da Graph API.

### 1.4 Dependências novas

```bash
npm install pdf-lib @pdf-lib/fontkit fflate
```

| Pacote             | Versão alvo | Por quê                                                                                                                                                                  |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pdf-lib`          | `^1.17.1`   | PDF em JavaScript puro, sem binário nativo — requisito do host serverless. Embute JPEG/PNG **sem recodificar**: o byte original vira o stream do PDF, custo zero de CPU.  |
| `@pdf-lib/fontkit` | `^1.1.1`    | O `pdf-lib` só embute TTF/OTF através dele. Sem fonte embutida, as fontes padrão são WinAnsi e **lançam exceção** no primeiro caractere fora do Latin-1 (§6).             |
| `fflate`           | `^0.8.2`    | ZIP em ~8 KB, sem dependências, com nível de compressão por arquivo (`level: 0` para mídia já comprimida). `jszip` é 3× maior e mais lento.                               |

Nada disso vai para o bundle do cliente: os três só são importados dentro
do route handler e de módulos `src/lib/inbox/export/` que só ele importa.
Onde couber, usar **import dinâmico** dentro do handler — mesmo padrão
que a 051 usa para `write-excel-file/node`.

---

## 2. Coleta — `src/lib/inbox/export/fetch-thread.ts` (novo)

```ts
export interface ThreadExportScope {
  conversationId: string;
  /** ISO. Inclusivo. Ausente = desde a primeira mensagem. */
  from?: string;
  /** ISO. Inclusivo até 23:59:59.999 do dia, no fuso do chamador. */
  to?: string;
}

export interface ThreadExportData {
  conversation: Conversation;
  contact: Contact;
  channel: Channel | null;
  /** user_id → nome, para nomear o remetente `agent`. */
  agentNames: Map<string, string>;
  messages: Message[];
  reactions: MessageReaction[];
  /** true se o teto de D-5 cortou a leitura. */
  truncated: boolean;
  total: number;
}

export const CONVERSATION_EXPORT_MAX_MESSAGES = 10_000;

export async function fetchThreadForExport(
  supabase: SupabaseClient,
  scope: ThreadExportScope
): Promise<ThreadExportData>;
```

Pontos que o código precisa acertar:

- **A conversa primeiro.**
  `select('*, contact:contacts(*), channel:channels(*)')` com
  `.eq('id', conversationId).maybeSingle()`. Vazio → o chamador responde
  **404 genérico**, sem distinguir "não existe" de "não é sua" — mesma
  regra de `lib/inbox/assignment.ts` e da rota-proxy de mídia. Um 403
  aqui confirmaria a existência da conversa para quem sonda ids.
- **Mensagens em lotes de 1 000** com `.range()`, ordenadas por
  `created_at ASC, id ASC`. O desempate por `id` importa: duas mensagens
  no mesmo milissegundo alternariam de ordem entre execuções e o PDF não
  seria reproduzível. O embed `broadcast:broadcasts(name)` vem junto,
  como o inbox já faz (SPEC 057 F6).
- **Reações numa consulta só**, `.in('message_id', ids)` por lote — nunca
  N+1.
- **Nomes de agente** de `profiles`, um `select` para os `sender_id`
  distintos. Agente removido da conta → rótulo i18n `unknownAgent`, nunca
  deixar o UUID vazar para o PDF.
- Se `total > CONVERSATION_EXPORT_MAX_MESSAGES`, **não** truncar em
  silêncio: devolver `truncated: true` e deixar a rota responder `413`
  com o total, para o diálogo sugerir um período menor. Foi o que a 051
  fez, pelo mesmo motivo — um documento silenciosamente incompleto é pior
  que um erro.

---

## 3. Modelo puro do transcrito — `src/lib/inbox/export/model.ts` (novo)

O renderizador de PDF não deve saber o que é `interactive_payload`, e o
teste do conteúdo não deve precisar abrir um PDF. Este módulo é a
fronteira: **`Message[]` entra, uma lista de blocos declarativos sai.**

```ts
export type TranscriptBlock =
  | { kind: 'day'; label: string } // "12 de agosto de 2026"
  | { kind: 'bubble'; bubble: TranscriptBubble };

export interface TranscriptBubble {
  messageId: string;
  side: 'left' | 'right'; // customer → left; agent/bot → right
  senderLabel: string; // "Maria (cliente)" | "João" | "Bot (IA)"
  timeLabel: string; // "14:32"
  statusLabel: string | null; // "lida" | "falhou" | null
  /** Parágrafos já normalizados (\r\n → \n, tab → espaço). */
  text: string[];
  /** Marcadores textuais acima do corpo. */
  badges: string[]; // "★ favorita" · "Campanha: Black Friday" · "IA"
  quote: { senderLabel: string; snippet: string } | null;
  reactions: string[]; // ["👍 cliente", "❤️ João"]
  buttons: string[]; // template ou interativo, um por linha
  attachment: TranscriptAttachment | null;
  errorText: string | null; // messages.error_message
}

export interface TranscriptAttachment {
  messageId: string;
  contentType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  /** O que `resolveMediaRef` devolveu, sem os bytes. */
  ref: MediaRef;
  /** Nome que o usuário reconhece — ver `deriveMediaFilename`. */
  displayName: string;
  caption: string | null;
}

export interface TranscriptLabels {
  /* … todos os rótulos, i18n injetado … */
}

export function buildTranscript(
  data: ThreadExportData,
  labels: TranscriptLabels,
  formatDateTime: (iso: string, style: 'day' | 'time') => string
): TranscriptBlock[];
```

Regras de mapeamento que o teste precisa fixar:

| Entrada                                                     | Bloco resultante                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `content_type: 'text'`                                      | bolha só com `text`                                                                                |
| `content_type: 'image' \| 'video' \| 'audio' \| 'document'` | bolha com `attachment`; `content_text` vira `caption` (e não `text`)                                |
| `content_type: 'template'` + `template_preview`             | header + body + footer como parágrafos, `buttons` preenchido, badge com `template_name`             |
| `content_type: 'template'` sem preview (pré-037)            | badge `template_name` + `content_text` cru — degradação explícita, não silenciosa                   |
| `content_type: 'interactive'` de saída                      | corpo + `buttons` a partir de `interactive_payload`                                                 |
| `content_type: 'interactive'` de entrada                    | texto prefixado pelo rótulo `buttonReply` + `interactive_reply_id` entre parênteses                 |
| `content_type: 'location'`                                  | bolha com o rótulo `location` e as coordenadas do `content_text`                                    |
| `status: 'failed'`                                          | `statusLabel` = rótulo de falha, `errorText` = `error_message`                                      |
| `is_favorite`                                               | badge `★` — favorita é **da conta** (SPEC 060 D-6), então nunca personalizar como "sua favorita"    |
| `channel_id` ≠ canal da conversa                            | badge de desvio de canal (SPEC 049 §6.1)                                                            |
| `broadcast.name`                                            | badge de campanha (SPEC 057)                                                                        |
| `ai_generated`                                              | badge "IA"                                                                                          |
| `reply_to_message_id`                                       | `quote` com os 120 primeiros caracteres da mensagem citada, **se** ela estiver no conjunto exportado |

`deriveMediaFilename` merece nota própria: **não existe coluna de nome de
arquivo em `messages`.** O webhook grava
`document.caption || document.filename` em `content_text`
(`src/app/api/whatsapp/webhook/route.ts:900`), então nome do documento e
legenda ocupam o mesmo campo e não dá para distinguir com certeza. A
heurística, testada:

1. Para `document`, se `content_text` casa
   `/^[^\n]{1,120}\.[a-z0-9]{1,8}$/i` (uma linha, com extensão
   plausível), é nome de arquivo → usar, sanitizado.
2. Senão, derivar de `media_path`/`media_url` (o basename do objeto).
3. Senão, `<tipo>-<8 primeiros do messageId>.<ext do mime>`.

Sanitização obrigatória em qualquer caso (§8): sem `/`, `\`, `..`, sem
caractere de controle, ≤ 100 caracteres.

---

## 4. Plano de mídia — `src/lib/inbox/export/media-plan.ts` (novo)

Puro. Decide **antes de baixar qualquer byte** o nome de cada arquivo
dentro do ZIP, para que o PDF possa citá-lo e o manifesto conferir.

```ts
export interface MediaPlanEntry {
  index: number; // 1-based, ordem cronológica
  messageId: string;
  ref: MediaRef;
  contentType: TranscriptAttachment['contentType'];
  /** Caminho dentro do zip: `midias/0007-imagem-3f2a1b9c.jpg` */
  zipPath: string;
  displayName: string;
  /** Mensagens que apontam para o MESMO objeto (encaminhamento). */
  duplicateOfIndex: number | null;
}

export function buildMediaPlan(blocks: TranscriptBlock[]): MediaPlanEntry[];
```

- **Nome determinístico**: `NNNN-<tipo>-<8 hex do messageId>.<ext>`. O
  índice com zeros à esquerda mantém a ordem cronológica na listagem do
  descompactador; o sufixo do id impede colisão entre dois "foto.jpg"; a
  extensão vem do MIME/`media_path`, com `bin` de último recurso.
- **Deduplicação por objeto**: duas mensagens que apontam para o mesmo
  `path`/`media_id` (reenvio, encaminhamento) baixam **uma vez** e entram
  no ZIP **uma vez**; a segunda entrada aponta para o mesmo `zipPath` via
  `duplicateOfIndex`. Sem isso, uma conversa com um catálogo reenviado 30
  vezes multiplica o download por 30.
- **O PDF cita `zipPath` literal** debaixo de cada anexo. É o que faz o
  par PDF+ZIP ser navegável por um humano — e é por isso que o plano
  precisa existir **antes** do render, não depois.

---

## 5. Bytes — `src/lib/inbox/export/fetch-media.ts` (novo)

```ts
export interface MediaFetchLimits {
  maxFiles: number; // 500
  maxTotalBytes: number; // 100 * 1024 * 1024
  maxFileBytes: number; //  50 * 1024 * 1024
  concurrency: number; // 6
}

export type MediaFetchStatus =
  | 'ok'
  | 'missing' // expirou na Meta / objeto sumiu do bucket
  | 'too_large' // passou de maxFileBytes
  | 'skipped' // teto global atingido
  | 'error';

export interface FetchedMedia {
  index: number;
  status: MediaFetchStatus;
  bytes: Uint8Array | null;
  mimeType: string | null;
  byteLength: number;
}

export async function fetchMediaBytes(
  supabase: SupabaseClient,
  accountId: string,
  plan: MediaPlanEntry[],
  limits: MediaFetchLimits
): Promise<Map<number, FetchedMedia>>;
```

Como cada origem é resolvida:

- **`storage`** → `supabase.storage.from(bucket).download(path)`. O
  cliente de sessão faz a policy da 040 decidir; erro vira `missing`, sem
  distinguir "não existe" de "não é sua". Preferir `download()` a
  assinar-e-buscar: uma viagem a menos e nenhuma URL assinada criada para
  algo que só o servidor vai consumir.
- **`proxy`** →
  `resolveCloudConfig(supabase, accountId, message.channel_id)` →
  `decrypt(config.access_token)` → `getMediaUrl` → `downloadMedia`. O
  `ChannelNotConfiguredError` vira `missing`, não 500: um canal
  desconectado não invalida a exportação do resto.
- **`external`** → `fetch` **passando pela guarda SSRF de
  `src/lib/webhooks/`**. Uma URL de header de template é conteúdo
  controlado pelo usuário; sem a guarda, a exportação vira um leitor de
  `169.254.169.254` e de `localhost` com as credenciais do servidor. É o
  ponto de maior risco de segurança desta SPEC (§15).
- **`none`** → não entra no plano.

Contabilidade: um acumulador de bytes compartilhado; ao cruzar
`maxTotalBytes`, tudo que falta vira `skipped` — **sem abortar**, para o
usuário receber a exportação parcial com o manifesto dizendo o que ficou
de fora. O pool de concorrência é um `for` sobre lotes de `concurrency`
com `Promise.allSettled`; nada de `Promise.all` (uma rejeição perderia o
lote inteiro).

---

## 6. Fontes e texto — `src/lib/inbox/export/pdf-font.ts` (novo)

**A armadilha:** as 14 fontes padrão do `pdf-lib` são codificadas em
WinAnsi. `drawText('Обед')` — ou qualquer emoji — **lança exceção**, não
degrada. Uma conversa de WhatsApp sem emoji não existe. Logo: fonte
embutida, via `fontkit`, obrigatoriamente.

Arquivos vendorizados em `src/lib/inbox/export/fonts/` (D-11):

| Arquivo                 | Papel                          | Licença |
| ----------------------- | ------------------------------ | ------- |
| `NotoSans-Regular.ttf`  | corpo do texto                 | OFL 1.1 |
| `NotoSans-SemiBold.ttf` | nomes de remetente, cabeçalhos | OFL 1.1 |
| `NotoEmoji-Regular.ttf` | emoji **monocromático** (D-4)  | OFL 1.1 |
| `OFL.txt`               | texto da licença — obrigação da OFL | —  |

`NotoEmoji` (a estática monocromática, **não** `NotoColorEmoji`) é `glyf`
puro e embute sem problema. A colorida usa CBDT/COLR, que o `pdf-lib` não
interpreta — daí o não-objetivo.

**Inclusão no bundle.** Ler `.ttf` com `fs` dentro de um route handler só
funciona se o _file tracing_ do Next levar o arquivo para o pacote de
deploy. Acrescentar em `next.config.ts`:

```ts
outputFileTracingIncludes: {
  '/api/inbox/conversations/[id]/export': [
    './src/lib/inbox/export/fonts/**',
  ],
},
```

Sem isso o build passa e a rota estoura `ENOENT` **só em produção** — é
exatamente a armadilha "build passa em `dev` e falha no host" que o
`AGENTS.md` já cataloga. Plano B, se o tracing der trabalho: gerar um
`.ts` com a fonte em base64 (à prova de bala, ~1,3 MB por fonte no
repositório e no bundle).

API do módulo:

```ts
export type Run = { text: string; font: 'text' | 'emoji' };

/** Parte a string em runs conforme a cobertura de glifo de cada fonte. */
export function splitRuns(
  text: string,
  hasEmojiGlyph: (cp: number) => boolean
): Run[];

/** Remove o que nenhuma das duas fontes cobre (senão `drawText` lança). */
export function sanitizeForPdf(
  text: string,
  covered: (cp: number) => boolean
): string;

/** Quebra em linhas respeitando a largura, por palavra e por grafema. */
export function wrapText(
  runs: Run[],
  maxWidth: number,
  measure: (run: Run) => number
): Run[][];
```

Três detalhes que o teste tem de cravar:

1. **Iterar por code point**, não por unidade UTF-16 —
   `for (const ch of s)`. `'👍'.length === 2`; fatiar por índice parte o
   par surrogate e produz lixo.
2. **Sequências ZWJ** (`👨‍👩‍👧`) e modificadores de tom de pele: manter
   juntas no mesmo run, senão a família vira três pessoas soltas.
3. **Palavra maior que a linha** (URL de 400 caracteres, comum em
   conversa) tem de quebrar **dentro** da palavra; senão o texto sai da
   caixa e some da página.

---

## 7. Render — `src/lib/inbox/export/pdf.ts` (novo)

```ts
export interface PdfRenderInput {
  header: {
    contactName: string;
    contactPhone: string; // E.164
    channelLabel: string; // "WhatsApp Oficial · +55 11 …"
    periodLabel: string;
    messageCount: number;
    attachmentCount: number;
    exportedByLabel: string; // "Exportado por João em 02/09/2026 14:31"
    exportId: string; // id da linha de `conversation_exports`
  };
  blocks: TranscriptBlock[];
  plan: MediaPlanEntry[];
  media: Map<number, FetchedMedia>;
  labels: PdfLabels;
  includeZipReferences: boolean; // false quando o formato é só PDF
}

export async function renderConversationPdf(
  input: PdfRenderInput,
  fonts: LoadedFonts
): Promise<Uint8Array>;
```

**Layout.** A4 (595,28 × 841,89 pt), margens de 40 pt. Bolha com largura
máxima de 70 % da coluna (≈ 360 pt), alinhada à esquerda para `customer`
e à direita para `agent`/`bot`, com fundo cinza-claro e verde-claro
respectivamente — desenhados com `drawRectangle`, cantos retos (o
`pdf-lib` não tem canto arredondado nativo e emular com curvas não paga o
custo). Nome do remetente em SemiBold 8 pt; corpo em 10 pt; horário e
status em 7 pt junto à borda da bolha.

**Imagens (D-3).** `embedJpg` para `image/jpeg`, `embedPng` para
`image/png`. Escala para caber em 260 × 320 pt preservando proporção. O
byte original vira o stream do PDF **sem recodificação** — nenhum
processamento de imagem no servidor. Tudo o mais (WebP, sticker, GIF,
HEIC) **não é embutível**: vira cartão de anexo. Sticker de WhatsApp é
WebP, então a maioria dos stickers cai aqui — é esperado e está no
`LEIA-ME.txt`.

**Cartão de anexo.** Retângulo com borda de 1 pt contendo: rótulo do tipo
(`Vídeo`, `Áudio`, `Documento`, `Imagem (formato não exibível)`), o
`displayName`, o tamanho formatado e — quando `includeZipReferences` — a
linha `→ midias/0007-video-3f2a1b9c.mp4`. Para `status !== 'ok'`, o
rótulo correspondente: _mídia indisponível (expirada na origem)_,
_arquivo grande demais para o pacote_, _não incluído: limite do pacote_.

**Paginação.** Uma passada única, medindo a altura de cada bolha antes de
desenhar; se não couber no que resta da página, `addPage()`. Bolha mais
alta que uma página inteira (mensagem de 8 000 caracteres) **quebra entre
páginas**, continuando o corpo — nunca estourar silenciosamente para fora
da margem. Rodapé em todas as páginas: `página N de M` à direita,
`exportId` à esquerda em 6 pt cinza. O total `M` só é conhecido no fim →
segunda passada só para o rodapé, sobre as páginas já criadas.

**Metadados do PDF**: `setTitle`, `setAuthor` (nome da conta),
`setSubject` (contato + período), `setCreator('ZAP CRM BR')`,
`setCreationDate`. É o que aparece nas propriedades do arquivo e ajuda
quem recebe o documento a saber a origem.

---

## 8. Pacote — `src/lib/inbox/export/zip.ts` (novo)

```ts
export interface ZipInput {
  pdfBytes: Uint8Array;
  pdfName: string; // "conversa-maria-silva-2026-09-02.pdf"
  plan: MediaPlanEntry[];
  media: Map<number, FetchedMedia>;
  manifest: string; // CSV pronto
  readme: string;
}

export function buildConversationZip(input: ZipInput): Uint8Array;

export function buildMediaManifestCsv(
  plan: MediaPlanEntry[],
  media: Map<number, FetchedMedia>,
  blocks: TranscriptBlock[],
  labels: ManifestLabels
): string;
```

Conteúdo:

```
conversa-maria-silva-2026-09-02.pdf
LEIA-ME.txt
MANIFESTO.csv
midias/
  0001-imagem-3f2a1b9c.jpg
  0002-audio-77b0c2de.ogg
  0004-documento-9c11a4f0.pdf
```

- `fflate.zipSync` com `{ level: 0 }` **por arquivo de mídia** (JPEG, MP4
  e OGG já estão comprimidos; deflate sobre eles queima CPU para ganhar
  ~1 %) e `{ level: 6 }` para PDF, CSV e TXT.
- **`mtime`** de cada entrada = `created_at` da mensagem. Descompactar
  preserva a cronologia no gerenciador de arquivos, de graça.
- **Zip slip é responsabilidade nossa**: `zipPath` sai de
  `buildMediaPlan`, que sanitiza (§3). Nenhum nome vindo do usuário entra
  em caminho de arquivo sem passar por lá. O teste do `media-plan` cobre
  `../../etc/passwd` e nome com byte nulo explicitamente.
- `MANIFESTO.csv` — mesmo dialeto do CSV da 051 (BOM, CRLF, toda célula
  entre aspas), colunas: `arquivo, indice, data_hora, remetente, tipo,
nome_exibido, tamanho_bytes, status, mensagem_id`. É por ele que quem
  recebe o pacote refaz o vínculo arquivo ↔ mensagem sem depender do PDF.
- `LEIA-ME.txt` — 10 linhas em pt-BR: o que é o pacote, quem gerou,
  quando, o id da exportação, e as duas ressalvas honestas (stickers e
  vídeos não aparecem como imagem no PDF; itens com `status` diferente de
  `ok` não estão na pasta).

---

## 9. Rota — `src/app/api/inbox/conversations/[id]/export/route.ts` (novo)

```ts
export const maxDuration = 300; // D-12

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
);
```

Sequência, na ordem exata:

1. `requireRole('agent')` (D-1) → `toErrorResponse(err)` no catch.
2. `checkRateLimit('conv-export:' + ctx.userId, { limit: 3, windowMs: 600_000 })`
   → `429` com `Retry-After` (D-9).
3. Validar o corpo: `format ∈ {'pdf','zip'}`; `from`/`to` ISO e
   `from ≤ to`; `locale ∈ {'pt-BR','en'}`; `timeZone` aceito por
   `new Intl.DateTimeFormat(locale, { timeZone })` dentro de `try/catch`
   (D-7) — fuso inválido **não** é 500, é `400`.
4. `id` tem de casar o regex de UUID (o mesmo da 051) antes de tocar o
   banco.
5. `fetchThreadForExport` → 404 genérico se vazio; `413` com
   `{ error: 'export_too_large', total }` se `truncated`.
6. Rótulos por `getTranslations('Inbox.exportConversation')`, datas por
   `Intl.DateTimeFormat` com o fuso do passo 3.
7. `crypto.randomUUID()` para o `exportId` (o PDF o imprime no rodapé) →
   `buildTranscript` → `buildMediaPlan`.
8. `format === 'zip'` → `fetchMediaBytes` com os tetos de D-5.
   `format === 'pdf'` → baixar **somente** as imagens embutíveis (as
   demais viram cartão sem `zipPath`), respeitando
   `maxEmbeddedImageBytes`.
9. `renderConversationPdf`; se `zip`, `buildConversationZip`.
10. Trilha em `conversation_exports` via `supabaseAdmin()`, com o
    `exportId` do passo 7. Falha aqui é `console.error` e segue: o
    arquivo já está pronto e derrubá-lo puniria o usuário por um problema
    nosso (mesma escolha da 051).
11. `NextResponse` com `Content-Type` (`application/pdf` ou
    `application/zip`), `Content-Disposition` com `filename` **e**
    `filename*=UTF-8''…` (nome de contato tem acento), e os cabeçalhos de
    diagnóstico `X-Export-Message-Count`, `X-Export-Media-Count`,
    `X-Export-Media-Missing`.

### 9.1 Migração `077_conversation_exports.sql`

Molde da 064, sem policy de INSERT/UPDATE/DELETE — só a rota escreve, com
service role, depois de checar o papel.

```sql
CREATE TABLE IF NOT EXISTS conversation_exports (
  id               UUID PRIMARY KEY,            -- gerado na rota (rodapé do PDF)
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  format           TEXT NOT NULL CHECK (format IN ('pdf','zip')),
  message_count    INT  NOT NULL,
  media_count      INT  NOT NULL DEFAULT 0,
  media_missing    INT  NOT NULL DEFAULT 0,
  total_bytes      BIGINT NOT NULL DEFAULT 0,
  period_from      TIMESTAMPTZ,
  period_to        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_exports_account
  ON conversation_exports(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_exports_conversation
  ON conversation_exports(conversation_id);

ALTER TABLE conversation_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_exports_select ON conversation_exports;
CREATE POLICY conversation_exports_select ON conversation_exports
  FOR SELECT USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE conversation_exports IS
  'Trilha de auditoria de exportacoes de conversa (SPEC 067). So escrita pela rota POST /api/inbox/conversations/[id]/export via service role, depois de checar requireRole(agent). Sem policy de INSERT/UPDATE/DELETE de proposito.';
```

Três escolhas com motivo:

- **`id` não tem `DEFAULT gen_random_uuid()`**: quem gera é a rota,
  porque o valor precisa estar impresso no rodapé do PDF **antes** do
  `INSERT`. Um default aqui esconderia essa dependência.
- **`conversation_id`/`contact_id` são `SET NULL`**: apagar a conversa
  (retenção, LGPD) não pode apagar o registro de que ela foi exportada —
  a pergunta "quem levou esses dados embora" sobrevive ao dado.
- **Só `SELECT`, e só para `admin`+**: o agente exporta, mas quem audita
  é a administração. `is_account_member(x,'admin')` já cobre `owner`.

⚠️ Existem **três projetos Supabase** (MCPs `vn`, `rs`, `jh`). **Confirmar
com o mantenedor antes de aplicar** — e conferir
`ls supabase/migrations/` para o próximo número livre, que pode ter
avançado.

---

## 10. UI — `src/components/inbox/export-conversation-dialog.tsx` (novo)

Ponto de entrada: o menu do cabeçalho da thread
(`src/components/inbox/message-thread.tsx`, o `DropdownMenu` por volta de
1311–1335, onde "Transferir de canal" já mora). Item **"Exportar
conversa"** com ícone `Download`, visível para papel ≥ `agent` (D-1).

O diálogo (`@base-ui/react` + primitivos de `components/ui`, como o resto
do módulo):

- **Formato** — dois rádios: _Somente PDF_ / _PDF + mídias (.zip)_, com a
  contagem de anexos ao lado do segundo.
- **Período** — _Toda a conversa_ (padrão) ou _Intervalo_, com dois
  `input[type=date]`. Datas convertidas para ISO no fuso do navegador
  antes do POST.
- **Resumo** — "1 284 mensagens · 37 anexos", a partir do que a thread já
  tem em memória, sem chamada extra.
- **Botão exportar** → `fetch` POST → `res.blob()` →
  `URL.createObjectURL` → `<a download>` → `revokeObjectURL`. É
  exatamente o que `media-download.tsx:84-90` já faz; reusar o helper em
  vez de reescrever.
- **Estados**: botão em carregamento com o texto "Gerando… isso pode
  levar alguns minutos" (não é exagero: 100 MB de mídia leva mesmo),
  `toast` de sucesso informando quantas mídias ficaram ausentes quando
  houver, e tratamento nominal de `413` ("período grande demais — recorte
  as datas") e `429` ("aguarde N minutos").

### 10.1 i18n

Novo bloco `Inbox.exportConversation` em `messages/en.json` (fonte da
verdade) **e** `messages/pt-BR.json`, com a mesma árvore —
`npm run i18n:check` falha se divergir. Chaves previstas: `menuItem`,
`title`, `description`, `formatLabel`, `formatPdf`, `formatZip`,
`periodLabel`, `periodAll`, `periodRange`, `from`, `to`, `summary`,
`submit`, `generating`, `success`, `successWithMissing`, `errorTooLarge`,
`errorRateLimited`, `errorGeneric`, `filenamePrefix`.

Mais o bloco de rótulos que vai **dentro do documento** —
`Inbox.exportConversation.doc.*`: `header*`, `dayFormat`, `customer`,
`bot`, `unknownAgent`, `statusSent|Delivered|Read|Failed`, `favorite`,
`aiBadge`, `campaign`, `sentVia`, `replyTo`, `reactions`, `buttons`,
`location`, `buttonReply`,
`attachmentVideo|Audio|Document|ImageUnsupported`, `mediaMissing`,
`mediaTooLarge`, `mediaSkipped`, `inZip`, `page`, `manifest*`, `readme*`.

O documento sai **no locale do exportador**, não em inglês fixo: ele é
para o cliente/juiz brasileiro, não para uma integração — a regra de
"`/api/**` responde em inglês" vale para as **mensagens de erro** da
rota, não para o conteúdo do arquivo gerado.

---

## 11. Fases de execução

Cada fase termina com a suíte verde. F1–F3 são puras e podem ser escritas
e testadas sem tocar em Supabase.

| Fase   | Entrega                                                     | Arquivos                                                             |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| **F1** | Modelo puro do transcrito + `deriveMediaFilename`            | `model.ts` + `model.test.ts`                                         |
| **F2** | Plano de mídia (nomes, dedupe, sanitização)                  | `media-plan.ts` + teste                                              |
| **F3** | Fontes: `splitRuns`, `sanitizeForPdf`, `wrapText`            | `pdf-font.ts` + teste; fontes + `OFL.txt` vendorizados               |
| **F4** | Coleta e bytes                                               | `fetch-thread.ts`, `fetch-media.ts` + testes com Supabase mockado     |
| **F5** | Render do PDF                                                | `pdf.ts`; `next.config.ts` (`outputFileTracingIncludes`)             |
| **F6** | ZIP + manifesto + LEIA-ME                                    | `zip.ts` + teste                                                     |
| **F7** | Rota + migração 077                                          | `route.ts` + `route.test.ts`, `077_conversation_exports.sql`         |
| **F8** | UI + i18n (en + pt-BR)                                       | `export-conversation-dialog.tsx`, `message-thread.tsx`, `messages/*` |
| **F9** | Teste manual em navegador (§13) e ajuste de tetos ao host    | —                                                                    |

Recomendação de modelo por fase: **F1–F3 e F6** (lógica pura, muito
teste) rendem bem com **Sonnet 5** — trabalho mecânico e bem
especificado. **F4, F5 e F7** tocam RLS, credenciais por canal e
geometria de PDF, onde um erro é silencioso e caro: **Opus 5**. **F8** é
UI + i18n rotineiro: **Sonnet 5** basta.

---

## 12. Plano de testes (Vitest, co-locados)

**`model.test.ts`**

- cada `content_type` vira o bloco esperado (tabela do §3, um caso por
  linha);
- template sem `template_preview` degrada para badge + texto cru;
- separador de dia aparece na virada e **não** aparece entre duas
  mensagens do mesmo dia;
- agente removido da conta → `unknownAgent`, e o UUID **não** aparece em
  lugar nenhum do bloco;
- `reply_to_message_id` apontando para fora do período exportado →
  `quote: null`, sem estourar;
- `deriveMediaFilename`: nome com extensão vence; legenda de duas linhas
  não vira nome; `../../etc/passwd` é neutralizado; nome de 300
  caracteres é truncado.

**`media-plan.test.ts`**

- índice 1-based, com 4 dígitos, na ordem cronológica;
- dois `messageId` com o mesmo `media_path` → um só `zipPath`, o segundo
  com `duplicateOfIndex`;
- `zipPath` nunca contém `..`, `/` fora do prefixo `midias/`, nem byte
  nulo;
- extensão derivada do MIME, com `bin` de último recurso.

**`pdf-font.test.ts`**

- `'oi 👍'` → dois runs, o segundo com o par surrogate **inteiro**;
- família com ZWJ permanece num run só;
- caractere sem cobertura nas duas fontes é removido por
  `sanitizeForPdf` — o teste real seria `drawText` lançando, então é aqui
  que ele tem de morrer;
- `wrapText` quebra dentro de uma "palavra" de 400 caracteres;
- texto vazio e só-espaços não geram linha fantasma.

**`fetch-media.test.ts`** (Supabase e Meta mockados)

- `storage` ok; `storage` negado pela policy → `missing` (não `error`);
- `proxy` usa o token do **canal da mensagem**, não o do canal padrão — o
  teste falha se alguém "simplificar" para o padrão (regressão da SPEC
  064);
- `ChannelNotConfiguredError` → `missing`;
- teto global atingido → os seguintes viram `skipped` e a promessa
  **resolve**;
- um `reject` no meio não derruba o lote (`allSettled`);
- URL externa que resolve para IP privado é **recusada** pela guarda
  SSRF.

**`zip.test.ts`**

- o pacote descompacta (ler de volta com `unzipSync`) e contém exatamente
  as entradas planejadas;
- mídia com `status !== 'ok'` **não** vira arquivo, mas **aparece** no
  manifesto com o status;
- CSV com BOM, CRLF e todas as células citadas;
- `mtime` de uma entrada bate com o `created_at` da mensagem.

**`route.test.ts`**

- `viewer` → 403; membro de outra conta → **404**, nunca 403 (não
  confirmar existência);
- corpo inválido → 400 com mensagem em inglês (regra de `/api/**`);
- fuso inválido → 400, não 500;
- acima do teto de mensagens → 413 com `total`;
- quarta chamada em 10 min → 429;
- caminho feliz: `Content-Type`, `Content-Disposition` com `filename*` e
  **uma** linha em `conversation_exports` com o mesmo `id` impresso no
  PDF;
- falha ao gravar a trilha **não** derruba o download.

---

## 13. Checklist de teste manual (F9, em navegador)

Contra uma conversa real, com número real, num canal Cloud e num QRCode:

1. Conversa longa (> 300 mensagens), formato **PDF**: abre no Adobe
   Reader, no Chrome e no visualizador do Windows sem aviso de arquivo
   corrompido.
2. Acentuação (`ção`, `à`, `ê`) e emoji (inclusive 👨‍👩‍👧 e 👍🏽)
   aparecem — em preto e branco, que é o esperado (D-4).
3. Foto JPEG enviada pelo agente aparece **em linha** no PDF.
4. Foto recebida do cliente (origem `proxy` ou bucket) aparece em linha.
5. Sticker aparece como **cartão**, com o texto de formato não exibível.
6. Vídeo, áudio (nota de voz `.ogg`) e PDF viram cartão com o nome de
   arquivo em `midias/…` idêntico ao que está no ZIP.
7. Formato **ZIP**: descompacta no Explorer do Windows e no 7-Zip; a
   pasta `midias/` tem a mesma contagem que o cabeçalho do PDF anuncia.
8. Abrir cada mídia do ZIP: a imagem abre, o áudio toca, o PDF abre —
   nenhum arquivo de 0 byte.
9. `MANIFESTO.csv` abre no Excel com acentuação correta (BOM) e colunas
   alinhadas.
10. Conversa **antiga**, com mídia que a Meta já expirou: a exportação
    **conclui**, o cartão diz "mídia indisponível" e o manifesto marca
    `ausente` (D-6).
11. Intervalo de datas: o PDF cobre exatamente o período e o cabeçalho o
    declara.
12. Como `agent` **não** atribuído a uma conversa de outro colega: a rota
    devolve 404 (conferir na aba Rede, não só na tela).
13. Como `viewer`: o item de menu não aparece; um POST via `curl` devolve
    403.
14. Quarta exportação em 10 minutos: 429 com a mensagem traduzida.
15. Conta com **dois números oficiais** (SPEC 064): mídia recebida no
    número B baixa corretamente — é o caso que quebra se o token do canal
    padrão for usado.
16. `SELECT * FROM conversation_exports ORDER BY created_at DESC LIMIT 5;`
    — o `id` da linha bate com o impresso no rodapé do PDF.
17. Trocar o idioma para inglês e exportar: o documento inteiro sai em
    inglês.

---

## 14. Validação local (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

O `build` importa mais que o normal nesta SPEC: é ele que exercita o
_file tracing_ das fontes (§6). Depois do build, conferir que os `.ttf`
aparecem no rastro da rota — `dev` é mais tolerante e não pega isso.

---

## 15. Segurança e LGPD

- **Autorização é da RLS.** Cliente de sessão do começo ao fim; a única
  exceção é o `INSERT` da trilha, depois do papel checado. Nenhuma
  consulta desta feature pode usar `supabaseAdmin()` para ler mensagem ou
  mídia — seria reabrir o furo que a 039/040 fecharam.
- **404 genérico** para conversa inexistente e para conversa alheia. A
  distinção é vazamento de informação, e a rota-proxy de mídia já
  estabeleceu esse padrão no repositório.
- **SSRF na mídia `external`** é o risco mais afiado (§5): a URL vem de
  campo controlável pelo usuário e o `fetch` sai do **nosso** servidor,
  de dentro da rede do host. Passar pela guarda de `src/lib/webhooks/` —
  sem exceção, sem "só nesse caso".
- **Zip slip** e travessia de caminho: todo nome de arquivo passa por
  `media-plan.ts`, com teste dedicado.
- **URL assinada não é persistida** (regra da 040). Preferir
  `storage.download()`, que nem chega a criar uma.
- **O arquivo gerado é um pacote de dados pessoais.** Nunca gravá-lo em
  bucket, cache ou disco do servidor: é montado em memória, devolvido na
  resposta e descartado. Sem link temporário, sem "seu arquivo está
  pronto em /exports/…" — a URL vazaria o pacote inteiro.
- **`Cache-Control: no-store`** já vale para `/api/*` pela regra do
  `next.config.ts`; conferir que a resposta binária não ganha cache de
  CDN por outro caminho.
- **Trilha para a LGPD**: `conversation_exports` responde "quem levou os
  dados deste titular, quando e quanto". É o registro que o encarregado
  de dados vai precisar apresentar.
- **Licença das fontes**: OFL 1.1 permite redistribuição embutida; o
  `OFL.txt` ao lado do `.ttf` é obrigação, não zelo.

---

## 16. Riscos e limites conhecidos

| Risco                                                          | Mitigação                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Memória: 100 MB de mídia + ZIP em RAM ≈ 250 MB de pico          | Tetos de D-5 conservadores; `level: 0` no ZIP evita buffers intermediários de deflate; medir no host antes de subir       |
| `maxDuration` do host menor que 300 s                           | D-12: baixar o teto de mídia. O diálogo já sugere recortar o período no 413                                              |
| Fonte não incluída no bundle → `ENOENT` só em produção          | `outputFileTracingIncludes` + verificação pós-`build` (§14); plano B é a fonte em base64                                 |
| Mídia expirada na Meta em conversas antigas                     | D-6: degradar e marcar no manifesto. É perda de dado **anterior** a esta feature, não causada por ela                    |
| Emoji monocromático decepciona visualmente                      | Documentado no `LEIA-ME.txt` e no diálogo; a alternativa colorida exigiria outro renderizador de PDF                     |
| Conversa gigante (10 000 mensagens) gera PDF de 500 páginas     | É o comportamento correto; o filtro de período existe justamente para isso                                               |
| Egresso do Storage por exportação abusiva                       | D-9: 3 por usuário a cada 10 min, e a trilha permite ver quem exporta demais                                             |

---

## 17. Git

Commits e push são **manuais** (regra do `AGENTS.md`). Ao fim das fases,
entregar o comando pronto — algo como:

```bash
git add -A && git commit -F- <<'EOF'
feat: exportar conversa em PDF e baixar as mídias em ZIP (SPEC 067)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Referências

- [docs/spec-040-media-privada.md](./spec-040-media-privada.md) — buckets privados, URL assinada, autorização da rota-proxy
- [docs/spec-049-inbox-multicanal-e-motores.md](./spec-049-inbox-multicanal-e-motores.md) — canal por conversa e desvio de canal
- [docs/spec-051-exportacao-de-contatos.md](./spec-051-exportacao-de-contatos.md) — o padrão de exportação que esta SPEC segue
- [docs/spec-060-retencao-e-limpeza-de-mensagens.md](./spec-060-retencao-e-limpeza-de-mensagens.md) — por que preservar antes do corte
- [docs/spec-064-multiplos-numeros-oficiais.md](./spec-064-multiplos-numeros-oficiais.md) — token por canal no download de mídia
- [src/lib/storage/media-url.ts](../src/lib/storage/media-url.ts) — `resolveMediaRef`, as quatro origens
- [src/app/api/whatsapp/media/[mediaId]/route.ts](<../src/app/api/whatsapp/media/[mediaId]/route.ts>) — "autenticar não é autorizar"
- [supabase/migrations/039_conversation_assignment.sql:146](../supabase/migrations/039_conversation_assignment.sql) — `can_access_conversation`
- [supabase/migrations/064_contact_exports.sql](../supabase/migrations/064_contact_exports.sql) — molde da trilha de auditoria
