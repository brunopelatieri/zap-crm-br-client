# Inbox, atribuição, mídia privada, emojis, exportação e apagar mensagem

> Domínio da SPEC 079. Rule: `.claude/rules/inbox-atribuicao.md`. Números mutáveis (migração, versões): [`status.md`](./status.md). RLS e privilégios de função: [`supabase-rls-mcp.md`](./supabase-rls-mcp.md). Mapa geral: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Abas (Chat / Fila / Contatos / Time):** `src/lib/inbox/tabs.ts`, `src/hooks/use-inbox-tabs.ts`, `src/components/inbox/`
- **Reivindicar / reatribuir conversa:** `src/lib/inbox/assignment.ts`, RPCs `claim_conversation` / `reassign_conversation` (039)
- **Quadro de atribuição ("Time"):** `src/lib/inbox/assignment-board.ts`, `src/components/inbox/assignment-board`
- **Mídia privada (upload, URL assinada):** `src/lib/storage/` (`upload-media`, `sign-media*`, `use-media-src`), `src/app/api/inbox/media/`
- **Apagar mensagem enviada:** `src/lib/messages/delete.ts` (regra pura), `src/app/api/inbox/messages/`
- **Exportar conversa (PDF + ZIP de mídias):** `src/lib/inbox/export/`, rota `src/app/api/inbox/conversations/[id]/export`
- **Emojis no composer:** `src/lib/emoji/`, `src/hooks/use-emoji-preferences.ts`, `scripts/sync-emojibase.mjs`
- **Presença, etiquetas, funil (kanban):** `src/lib/{presence,tags}.ts`, `src/lib/pipelines/`

## Regras que não podem quebrar

1. **Filtro de aba no cliente não é autorização.** O isolamento é da RLS por linha da migração 039: o agente vê as conversas atribuídas a ele mais a fila (`assigned_agent_id IS NULL`). Toda decisão de acesso nova precisa existir no banco, não só na UI ([SPEC abas+atribuição](../spec-inbox-tabs-assignment.md) F-01).
2. **Reivindicar é atômico no banco** (`claim_conversation`); reatribuir exige papel que possa atender. `viewer` **não** é atribuível: o destino precisa ser `owner | admin | agent` (`ASSIGNABLE_ACCOUNT_ROLES` em `src/lib/auth/roles.ts`). `isAdmin` não pode excluir o `owner` (F-05).
3. **Quem escreve com service role não herda a 039.** Automação/flow/API que atribui conversa precisa validar conta **e** papel do destino, senão a conversa fica invisível para todos ([SPEC 041](../spec-041-atribuicao-fora-do-inbox.md) F-41-A). A API pública `/api/v1` é cega à atribuição por desenho.
4. **Todo `.update()` leva `.select()`**: sem isso uma recusa de RLS passa em silêncio; zero linhas devolvidas é erro.
5. **Quadro "Time"**: só `admin`+ vê e arrasta; a aba nem é renderizada para `agent`/`viewer` ([SPEC 043](../spec-043-quadro-de-atribuicao.md) §2.1). É sobre `conversations` (colunas = pessoas), **não** o funil de vendas (`deals`). Não misture os dois módulos.
6. **Supervisão** ([SPEC 042](../spec-042-supervisao-e-escopo-de-contatos.md)): admin/owner supervisiona via "ver como"; a aba Contatos filtra no cliente sobre tabela sem RLS por atribuição — a tela não pode prometer isolamento que o banco não dá.
7. **Mídia é privada** ([SPEC 040](../spec-040-media-privada.md)): buckets `chat-media` e `flow-media` não são públicos; leitura é por URL assinada. A rota `/api/whatsapp/media/[mediaId]` (mídia **recebida**) deve conferir a conversa do chamador, não só a sessão.
8. **Apagar mensagem enviada** ([SPEC 074](../spec-074-apagar-mensagem-enviada.md)): a Cloud API **não revoga** — só o canal QRCode tem endpoint. Apagar sempre **marca** (linha preservada, moldura vermelha); o endpoint do canal é disparado quando cabe; falha do canal não desfaz a marca e é mostrada no balão. Mensagem **recebida** nunca se apaga. Marcar: quem envia (owner/admin/agent); excluir do sistema: `admin`+. Automação, flow e IA não apagam. Tudo vai para `message_deletion_log` (append-only). A regra de decisão é a função pura `planDeletion`.
9. **Reenviar** passa por janela de 24 h, cold-send e quota, e **preenche** o composer (não envia sozinho).

## Etiquetas e negócios (gating por papel)

- Etiquetas ([spec](../spec-inbox-tag-management.md), [edição](../spec-settings-tag-editing.md)): criar = `admin`; atribuir/remover = `agent`; ver = qualquer membro.
- Negócio pelo inbox ([spec](../spec-inbox-kanban-integration.md)): criar = `agent`; funis e etapas = `admin`, só em `/pipelines`.

## Emojis (SPEC 066)

Frimousse com dados **Emojibase auto-hospedados**; regra pura em `src/lib/emoji/` (inserção no cursor; recentes e tom de pele **por usuário**). `/scripts` inteiro está no `.gitignore` (linha 72 hoje): um script novo ali não sobrevive ao clone — por isso as fontes do PDF (abaixo) vivem em `src/` ([SPEC 066](../spec-066-emoji-picker-inbox.md)).

## Exportação da conversa (SPEC 067)

Por **conversa**; papel mínimo `agent` somado à RLS; `viewer` não exporta. Tetos, frequência e `maxDuration` estão na [SPEC 067](../spec-067-exportacao-de-conversa-pdf-e-midias.md) (decisões) — não os repita. Mídia que a Meta já expirou entra como `ausente` no manifesto. Fontes do PDF: `src/lib/inbox/export/fonts/`.

## Armadilhas

- Contador de não lidas "trava" após reatribuição: o cliente passou a receber menos linhas pela RLS e trata como "não existe" ([SPEC 041](../spec-041-atribuicao-fora-do-inbox.md) F-41-D). Query vazia no inbox = suspeitar de RLS/cliente errado antes de bug de lógica.
- Reaplicar a migração 017 desfaz a 039 sem erro (F-41-B).
- Quando a última mensagem da conversa é apagada, o preview da lista vira "Mensagem apagada" (SPEC 074 D-10).

## Mais

[`../spec-inbox-tabs-assignment.md`](../spec-inbox-tabs-assignment.md) · [`../spec-049-inbox-multicanal-e-motores.md`](../spec-049-inbox-multicanal-e-motores.md) (inbox multicanal) · [`catalogo-specs.md`](./catalogo-specs.md).
