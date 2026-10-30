# SPEC 071 — Editar contato pelo modal, a partir do detalhe (Inbox e gerenciador)

| Campo            | Valor                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Status           | **Em implementação** — F1-F2 (`ContactDetailView`) prontas; F4-F5 (extensão §11) em andamento    |
| Data             | 2026-09-04                                                                                        |
| Escopo           | `ContactDetailView` (Sheet de detalhe) + `ContactSidebar` (Chat/Fila) + `ConversationCard` do quadro (Time) — todo lugar onde o Inbox mostra um contato ganha o mesmo caminho de edição |
| Depende de       | SPEC 050 (padronização de telefone BR) — é o contrato que o caminho atual quebra                  |
| Migração         | **Nenhuma.** Nenhuma coluna nova, nenhuma mudança de schema                                       |
| Dependências npm | Nenhuma                                                                                            |

---

## Contexto

Hoje existem **dois caminhos diferentes** para editar os dados de um
contato (nome/telefone/e-mail/empresa), e eles não passam pela mesma
lógica:

1. **`/contacts` → menu "⋯" → "Editar"** (`page.tsx:868`) abre
   [`ContactForm`](../src/components/contacts/contact-form.tsx) em modal
   (`Dialog`). Este é o caminho completo: valida telefone brasileiro com
   `normalizeContactPhone` (SPEC 050 — DDD, 9º dígito, formato de fixo),
   cruza com `isValidPhoneNumber` para número estrangeiro, checa
   duplicidade e faz o resync inteiro de `contact_tags`.

2. **Clicar na linha de um contato** — em `/contacts` (`page.tsx:786`,
   `openDetail`) **ou na aba "Contatos" do Inbox**
   ([`contacts-directory.tsx:227`](../src/components/inbox/contacts-directory.tsx)) —
   abre [`ContactDetailView`](../src/components/contacts/contact-detail-view.tsx),
   um `Sheet` cuja aba **"Detalhes"** tem seus **próprios** campos
   editáveis e seu próprio `saveDetails()` (`contact-detail-view.tsx:272`).

O segundo caminho é o único disponível para quem está atendendo no Inbox
— `ContactsDirectory` nunca usa `ContactForm`, só `ContactDetailView`. E é
o caminho **sem a validação da SPEC 050**:

```ts
// contact-detail-view.tsx:279 — saveDetails()
.update({
  name: editName.trim() || null,
  phone: editPhone.trim(),   // ← string crua do <Input>, sem normalizeContactPhone
  ...
})
```

Um agente que corrige um telefone durante uma conversa no Inbox — o
cenário mais comum de uso deste botão — pode gravar `"+55 (11) 91234-5678"`
ou qualquer outra formatação em `contacts.phone`, quebrando a garantia
"dígitos, com DDI, sem `+`" que `normalizeContactPhone`,
`sanitizePhoneForMeta`, o índice único de telefone (migração 022) e
`formatPhoneForDisplay` assumem em todo o resto do app. Não há checagem
de duplicidade neste caminho, também.

**O próprio dicionário de i18n já antecipa a correção.** Duas chaves em
`Contacts.detailView` existem e **não são usadas em lugar nenhum do
código atual**:

```json
"actions": { "edit": "Edit" / "Editar", ... }
"contactInfo": "Contact Information" / "Informações do contato"
```

Elas só fazem sentido como o rótulo do botão que esta SPEC adiciona e o
título da seção somente-leitura que substitui os campos editáveis — sinal
de que este era o desenho original, que ficou pela metade.

A aba "Etiquetas" do mesmo Sheet **não tem esse problema**: já usa
`assignTag`/`unassignTag` (o mesmo caminho de escrita de todo o app) e
alterna na hora, sem lote. Fica fora do escopo desta SPEC.

---

## Objetivo

### O que esta SPEC entrega

1. Um botão **"Editar"** no cabeçalho do `Sheet` de `ContactDetailView`
   (ao lado de "Enviar template"), usando a chave `actions.edit` já
   existente no dicionário.
2. Clicar nele abre o **mesmo** componente `ContactForm` já usado em
   `/contacts`, em modal, pré-carregado com o contato e as etiquetas
   atuais — a mesma validação de telefone BR, a mesma checagem de
   duplicidade (que já é só para criação — ver §3) e o mesmo resync de
   `contact_tags` que `/contacts` usa hoje.
3. A aba **"Detalhes"** perde os quatro campos de `<Input>` e o botão
   "Salvar alterações" (`saveDetails`, `savingDetails`,
   `editName`/`editPhone`/`editEmail`/`editCompany`) — todos removidos.
   No lugar, uma exibição somente-leitura dos mesmos quatro campos, sob o
   título `contactInfo`. As seções abaixo (consentimento §6.8 da SPEC 044,
   selo de checagem da SPEC 069, número morto/reativação da SPEC 044)
   **continuam exatamente como estão** — seus próprios botões e RPCs não
   passam por `saveDetails`.
4. Salvar no modal atualiza a `Sheet` aberta atrás dele: `onSaved` chama
   `fetchContact()` (recarrega os campos somente-leitura e o cabeçalho)
   e `onUpdated()` — o mesmo callback que `ContactDetailView` já recebe
   por prop e que cada tela chamadora já liga à própria lista
   (`fetchContacts`, em ambas as telas).
5. O botão é protegido pelo mesmo papel que a RLS de `UPDATE` em
   `contacts` já exige — `useCan('send-messages')`, via `GatedButton`,
   igual ao "Editar" de `/contacts`.

### Por que isso conserta as duas telas de uma vez, sem tocar nelas

`ContactDetailView` é o **mesmo componente** nas duas telas — recebido
como prop de `contactId`/`open`/`onOpenChange`/`onUpdated` tanto por
`contacts/page.tsx` quanto por `contacts-directory.tsx` — nenhuma delas
precisa de uma linha de código alterada. `/contacts` ganha um segundo
caminho consistente para editar (o de hoje, pelo menu "⋯", continua
igual); o Inbox ganha o único caminho que faltava.

### Não-objetivos (explicitamente fora de escopo)

- **Aba "Etiquetas".** Continua com o toggle imediato via
  `assignTag`/`unassignTag`, sem relação com o `ContactForm`.
- **Consentimento, selo de checagem, número morto.** Fluxos próprios,
  intocados.
- **Criar contato pelo Inbox.** Esta SPEC é só edição de um contato já
  existente, aberto no detalhe.
- **Checagem de duplicidade na edição.** Já não existe hoje —
  `ContactForm` só chama `checkDuplicate()` quando `!isEdit`
  (`contact-form.tsx:183`) — e continua assim.
- **Novo campo no formulário.** `ContactForm` não ganha nada; é reuso puro.

---

## Decisões a ratificar com o mantenedor

| #   | Pergunta                                                                                   | Recomendação                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | A aba "Detalhes" some ou vira somente-leitura?                                              | **→ vira somente-leitura**, sob o título `contactInfo` (chave já existente, hoje sem uso). Remover a aba inteira reordenaria as demais (`TabsList` é uma lista fixa) e apagaria o lugar natural de consentimento/checagem/status, que moram nela hoje. |
| D-2 | Construir `ContactTag[]` para o `ContactForm` com uma query nova, ou reaproveitar o que já está em memória? | **→ reaproveitar.** `ContactDetailView` já mantém `contactTagIds: string[]` (de `fetchTags`, linha 194). `ContactForm` só lê `.tag_id` de cada item (`contact-form.tsx:109`) — um `useMemo` que mapeia `contactTagIds` para `{ id: tagId, contact_id: contactId, tag_id: tagId }` evita um round-trip ao Supabase só para reconstruir uma forma que já existe. Se `ContactForm` um dia passar a ler outro campo do `ContactTag` (ex.: `.id` para chave de lista), isso quebra silenciosamente — vale um comentário no código apontando a dependência. |
| D-3 | As quatro chaves de i18n que ficam sem call site (`saveChangesBtn`, `toastPhoneRequired`, `toastUpdateFailed`, `toastUpdated`) — apagar ou manter? | **→ apagar**, dos dois dicionários, na mesma mudança. `npm run i18n:check` não acusa chave sobrando (só faltante), mas English/pt-BR já carregam ~1.600 chaves — sobra sem uso não pega bug, só acumula. Confirmar antes que nenhum outro arquivo usa `Contacts.detailView.<essas chaves>` (namespace é exclusivo deste componente, mas vale o grep). |

Nenhuma delas muda o comportamento observável de forma incerta — são
detalhes de implementação com uma resposta claramente melhor. Ratificar
é rápido; nada aqui trava o início do código.

---

## 1. Mudanças, arquivo por arquivo

| Arquivo                                            | Mudança                                                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/contacts/contact-detail-view.tsx`   | **único arquivo de código tocado.** Ver §2.                                                                                                                                                |
| `messages/en.json` / `messages/pt-BR.json`          | Remover as 4 chaves mortas de `Contacts.detailView` (D-3). Nenhuma chave nova — `actions.edit`, `contactInfo`, `nameLabel`, `phone`, `email`, `company` já existem nos dois arquivos.       |
| `src/components/inbox/contacts-directory.tsx`       | **Nenhuma mudança.** Já passa `onUpdated={fetchContacts}` para `ContactDetailView` — é só isso que o novo fluxo de salvar precisa.                                                          |
| `src/app/(dashboard)/contacts/page.tsx`             | **Nenhuma mudança.** O "Editar" do menu "⋯" continua abrindo `ContactForm` do jeito que já abre hoje; o novo botão do Sheet é um segundo caminho para o mesmo modal, não um substituto dele. |

### 1.1 Por que nenhuma migração

Nenhum campo novo, nenhuma coluna nova. `ContactForm` já grava exatamente
as colunas que `saveDetails()` grava hoje (`name`, `phone`, `email`,
`company`, `updated_at`) e mais `contact_tags` — tudo dentro do schema
atual.

---

## 2. `contact-detail-view.tsx` em detalhe

### 2.1 Imports novos

```ts
import { ContactForm } from '@/components/contacts/contact-form';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { Pencil } from 'lucide-react'; // junto dos outros ícones já importados
import type { ContactTag } from '@/types'; // já importa Contact/Tag/etc.; falta este
```

### 2.2 Estado

Removidos: `editName`, `editPhone`, `editEmail`, `editCompany`,
`savingDetails`.

Adicionados:

```ts
const canEdit = useCan('send-messages');
const [editFormOpen, setEditFormOpen] = useState(false);

// D-2: forma sintética de ContactTag[] a partir do que já está em
// memória — ContactForm só lê `.tag_id`, então não há round-trip novo.
const contactTagsForForm = useMemo<ContactTag[]>(
  () =>
    contactTagIds.map((tagId) => ({
      id: tagId,
      contact_id: contactId ?? '',
      tag_id: tagId,
    })),
  [contactTagIds, contactId]
);
```

`fetchContact` perde as quatro linhas `setEditName/setEditPhone/
setEditEmail/setEditCompany` — só resta `setContact(data)`.
`saveDetails()` é removida por inteiro.

### 2.3 Cabeçalho — botão novo

Ao lado do botão "Enviar template" (`contact-detail-view.tsx:612`):

```tsx
<GatedButton
  variant="outline"
  size="sm"
  canAct={canEdit}
  gateReason="edit contacts"
  onClick={() => setEditFormOpen(true)}
  className="border-border text-muted-foreground hover:bg-muted"
>
  <Pencil className="size-4" />
  {t('actions.edit')}
</GatedButton>
```

### 2.4 Aba "Detalhes" — de editável para somente-leitura

Os quatro blocos `<Label> + <Input>` e o botão "Salvar alterações" saem;
entra um bloco somente-leitura equivalente, sob o título já existente
`contactInfo`:

```tsx
<div className="space-y-3">
  <h3 className="text-foreground text-sm font-medium">
    {t('contactInfo')}
  </h3>
  <dl className="space-y-2 text-sm">
    <div>
      <dt className="text-muted-foreground text-xs">{t('nameLabel')}</dt>
      <dd className="text-foreground">
        {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
      </dd>
    </div>
    <div>
      <dt className="text-muted-foreground text-xs">{t('phone')}</dt>
      <dd className="text-foreground">{formatPhoneForDisplay(contact.phone)}</dd>
    </div>
    <div>
      <dt className="text-muted-foreground text-xs">{t('email')}</dt>
      <dd className="text-foreground">{contact.email || '—'}</dd>
    </div>
    <div>
      <dt className="text-muted-foreground text-xs">{t('company')}</dt>
      <dd className="text-foreground">{contact.company || '—'}</dd>
    </div>
  </dl>
</div>
```

Tudo que vem depois no JSX de hoje (consentimento, selo de checagem,
número morto) **permanece exatamente onde está**, na mesma
`TabsContent value="details"`.

### 2.5 O modal, ligado ao final do arquivo

Junto de `<TemplatePicker ... />`, dentro do mesmo `<>` que envolve o
`Sheet`:

```tsx
<ContactForm
  open={editFormOpen}
  onOpenChange={setEditFormOpen}
  contact={contact}
  contactTags={contactTagsForForm}
  onSaved={() => {
    fetchContact();
    onUpdated();
  }}
/>
```

Sem `onViewExisting` — esse prop só importa em criação (`!isEdit`), e
aqui `contact` sempre existe.

---

## 3. Por que a checagem de duplicidade não precisa de nada novo

`ContactForm.checkDuplicate()` já tem a guarda `if (isEdit || !accountId)
return;` (`contact-form.tsx:183`), e `isEdit = !!contact`
(`contact-form.tsx:70`). Como este fluxo sempre passa um `contact` não
nulo, o comportamento é idêntico ao "Editar" de `/contacts`: sem checagem
de duplicidade, só a validação de formato (SPEC 050). Nenhuma mudança em
`contact-form.tsx`.

---

## 4. Permissões

- Papel mínimo: `useCan('send-messages')` — o mesmo predicado do botão
  "Editar" de `/contacts` (`page.tsx:83`) e o que a RLS de `UPDATE` em
  `contacts` já exige. `viewer` vê o botão desabilitado via
  `GatedButton`, com o motivo (`gateReason`).
- `ContactForm` já roda no cliente de sessão (`createClient()`,
  `contact-form.tsx:68`) — sujeito a RLS, sem novo caminho de acesso.
- Nada muda em `is_account_member` nem em qualquer política de RLS —
  zero migração, zero mudança de segurança.

---

## 5. i18n

Nenhuma chave nova. Remover de `Contacts.detailView` em **ambos**
`messages/en.json` e `messages/pt-BR.json` (D-3), depois de confirmar
que não há outro call site:

```
saveChangesBtn
toastPhoneRequired
toastUpdateFailed
toastUpdated
```

Chaves reaproveitadas (já existem, já com paridade en/pt-BR — nenhuma
edição necessária): `actions.edit`, `contactInfo`, `nameLabel`, `phone`,
`email`, `company`, `unnamed`.

---

## 6. Fases de execução

| Fase   | Entrega                                                                                                          | Verificável por                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **F1** | Botão "Editar" + modal `ContactForm` ligado no `Sheet`; aba "Detalhes" vira somente-leitura; `contactTagsForForm` (D-2) | `npm run typecheck` + abrir o Sheet em `/contacts` e no Inbox, editar e salvar |
| **F2** | Remoção das 4 chaves de i18n mortas (D-3), nos dois dicionários                                                     | `npm run i18n:check`                                                |
| **F4** | (§11) Botão "Editar" na `ContactSidebar` das abas Chat/Fila + `handleContactUpdated` em `page.tsx` (D-4)            | `npm run typecheck` + editar pelo Chat, conferir painel e Sheet sincronizados |
| **F5** | (§11) Item "Editar contato" no menu "⋯" do `ConversationCard` (aba Time) + `refreshCard` exposto pelo hook (D-5)     | `npm run typecheck` + editar por um card, conferir card atualizado sem reload |
| **F3** | Checklist de teste manual (§7 + §11.6), executado pelo mantenedor em navegador                                     | §7, §11.6                                                            |

Sem lógica pura nova em `src/lib/` — é composição de UI reaproveitando
dois componentes que já existem e já são testados isoladamente
(`contact-form.tsx`, `phone/br.ts`). Não há `*.test.ts` novo previsto.

---

## 7. Checklist de teste manual (F3, em navegador)

1. **Entrada pelo Inbox.** Aba "Contatos" do Inbox → clicar num contato →
   Sheet abre → botão "Editar" no cabeçalho → modal `ContactForm` abre
   preenchido com nome/telefone/e-mail/empresa/etiquetas atuais.
2. **Validação BR continua valendo.** No modal aberto pelo Inbox, digitar
   um telefone com DDD inválido: a mesma mensagem de erro de sempre
   aparece (SPEC 050) — o caminho antigo (`saveDetails`) nunca a mostrava.
3. **Salvar atualiza a Sheet por trás.** Corrigir o telefone, salvar: o
   modal fecha, e a Sheet (ainda aberta) mostra o telefone novo tanto no
   cabeçalho quanto na aba "Detalhes", sem precisar fechar/reabrir.
4. **Lista atualiza também.** Fechar a Sheet: a linha do contato na lista
   do Inbox (ou de `/contacts`) reflete os dados novos.
5. **Etiquetas preservadas (D-2).** Na aba "Etiquetas" da Sheet, marcar
   uma etiqueta nova. Sem sair da Sheet, abrir o modal "Editar" e salvar
   **sem tocar nas etiquetas do modal**: confirmar que a etiqueta marcada
   continua marcada depois — garante que `contactTagsForForm` não perdeu
   o estado atual.
6. **Mesmo teste a partir de `/contacts`.** Repetir os passos 1-5 clicando
   numa linha da tabela de `/contacts` (não pelo menu "⋯" — pelo clique na
   linha, que abre o mesmo `Sheet`).
7. **O caminho antigo de `/contacts` continua igual.** Menu "⋯" → "Editar"
   em `/contacts` continua abrindo o modal diretamente, sem passar pela
   Sheet — nenhuma regressão.
8. **Papel `viewer`.** Entrar como `viewer`: o botão "Editar" da Sheet
   aparece desabilitado com o motivo, em ambas as telas.
9. **Seções intocadas.** Consentimento, selo de checagem (SPEC 069) e
   número morto/reativação (SPEC 044) continuam funcionando exatamente
   como antes, na mesma aba "Detalhes".
10. **pt-BR e en.** Trocar o idioma e revisitar a Sheet e o modal: nenhuma
    chave crua, nenhum `INVALID_MESSAGE` no console.

---

## 8. Validação local (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 9. Riscos e limites conhecidos

| Risco / limite                                                                                     | Mitigação / registro                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `contactTagsForForm` sintético (D-2) depende de `ContactForm` só ler `.tag_id` de cada `ContactTag`  | Comentário no código apontando a dependência; se `ContactForm` mudar, o teste manual do item 5 (§7) pega a regressão na hora     |
| Aba "Detalhes" perde a edição inline que quem já usa o app pode ter memorizado                        | Troca por um único botão "Editar" bem visível no cabeçalho, mesma posição em toda tela que usa `ContactDetailView`               |
| Remover chaves de i18n sem grep completo antes                                                        | §5 pede a confirmação explícita antes de apagar; `i18n:check` não cobre chave sobrando, só faltante                              |

---

## 10. Git

Commits e push são **manuais do mantenedor** (AGENTS.md). Comando pronto,
após a validação de §8 passar inteira:

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat: SPEC 071 — editar contato pelo modal ContactForm a partir do detalhe

A aba "Detalhes" do Sheet de contato (contact-detail-view.tsx) tinha seu
proprio saveDetails(), que gravava o telefone digitado sem passar por
normalizeContactPhone (SPEC 050) — unico caminho de edicao de contato
disponivel no Inbox, e o unico sem a validacao de telefone BR.

- Novo botao "Editar" no cabecalho do Sheet, abrindo o mesmo modal
  ContactForm ja usado em /contacts (validacao BR + resync de etiquetas)
- Aba "Detalhes" vira somente-leitura; saveDetails() removido
- contacts-directory.tsx e contacts/page.tsx: zero mudancas — o Sheet
  compartilhado propaga o fix para as duas telas
- 4 chaves de i18n mortas removidas (en + pt-BR)

Sem migracao: nenhuma coluna nova.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## 11. Extensão — o mesmo "Editar" no Chat/Fila e no quadro Time

### 11.1 Contexto

F1-F2 cobriram o **Sheet** de detalhe (`ContactDetailView`), aberto a
partir de `/contacts` e da aba **"Contatos"** do Inbox. Mas o Inbox tem
**duas outras telas** que mostram um contato sem passar pelo Sheet, e as
duas ainda dependiam de abrir a aba "Contatos" à parte para corrigir um
nome ou telefone — o mesmo problema que F1 resolveu para o Sheet, só que
sem o Sheet no meio:

1. **Abas "Chat" e "Fila"** (`Inbox.tabs.chat` / `Inbox.tabs.open`) — a
   coluna de detalhes à direita da conversa aberta é `ContactSidebar`
   (`src/components/inbox/contact-sidebar.tsx`), **não**
   `ContactDetailView`. É um painel próprio, com sua própria busca de
   negócios/notas e sem noção nenhuma de `ContactForm`.
2. **Aba "Time"** (`Inbox.tabs.board`, o quadro de atribuição da SPEC
   043) — cada card é `ConversationCard`
   (`src/components/inbox/assignment-board/conversation-card.tsx`), com
   um menu "⋯" que hoje só tem "Abrir conversa" e "Mover para…". Card é
   **presentational puro, sem rede** (comentário no topo do arquivo) —
   qualquer busca ao Supabase precisa subir para quem já fala com a rede
   nesse módulo: `AssignmentBoard` / `useAssignmentBoard`.

Estende exatamente o padrão de F1: reaproveitar `ContactForm` sem
alterá-lo, um botão "Editar"/item de menu por tela, e o papel mínimo
`useCan('send-messages')` de sempre.

### 11.2 Decisões

| #   | Pergunta                                                                       | Recomendação                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-4 | `ContactSidebar` não é dona do `contact` (vem por prop de `inbox/page.tsx`) — como o Sheet aberto atrás reflete a edição? | **→ callback explícito**, mesmo desenho de `handleContactTagsChanged` (já existe em `page.tsx` para o tag-picker): `ContactSidebar` refaz uma leitura enxuta (`name, phone, email, company, contact_tags(tags(*))`) depois do `onSaved` e chama `onContactUpdated(contactId, patch)`; a página aplica o patch em `activeContact` **e** nos dois feeds (`chatFeed`/`openFeed`), do jeito que `handleContactTagsChanged` já faz para etiquetas. Não há assinatura realtime na tabela `contacts` (só `conversations`/mensagens) — sem o callback, o nome/telefone corrigido só apareceria depois de um F5. |
| D-5 | O quadro "Time" busca cada card com um `select` propositalmente enxuto (`BOARD_CONVERSATION_SELECT`, comentário: "cada campo a mais custa N vezes"). `ContactForm` precisa do contato inteiro (inclusive `email`, ausente dali) para pré-carregar sem risco de apagar um campo. Alargar o select da lista, ou buscar sob demanda? | **→ sob demanda.** Ao clicar "Editar contato", `AssignmentBoard.handleEditContact` faz **uma** busca `contacts.select('*, contact_tags(tags(*))').eq('id', contactId).single()` — o mesmo padrão de `ContactDetailView.fetchContact`. `BOARD_CONVERSATION_SELECT` fica como está: o card nunca mostra e-mail, então não há motivo para pagar o custo em toda carga de coluna por um campo que só a edição usa. |

### 11.3 Arquivo por arquivo

| Arquivo                                                                     | Mudança                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/inbox/contact-sidebar.tsx`                                  | Botão "Editar" (`GatedButton` + `useCan('send-messages')`) abaixo do nome/empresa; `ContactForm` montado no fim; `contactTagsForForm` sintético a partir de `contact.tags` (mesmo truque de D-2, adaptado — aqui a fonte é `Tag[]`, não `contactTagIds`); novo prop `onContactUpdated?(contactId, patch)` |
| `src/app/(dashboard)/inbox/page.tsx`                                        | Novo `handleContactUpdated` (mesmo formato de `handleContactTagsChanged`, duas linhas abaixo dele); passado como `onContactUpdated` para `<ContactSidebar>`             |
| `src/components/inbox/assignment-board/conversation-card.tsx`               | Item "Editar contato" no menu "⋯" (`Pencil`, `useCan('send-messages')`, `disabled` sem `contact`); a condição que hoje só abre o menu com `assignTargets.length > 1` passa a abrir também quando há `contact`, para o item existir mesmo numa conta com 0-1 colega atribuível |
| `src/components/inbox/assignment-board/draggable-conversation-card.tsx`     | Repassa `onEditContact` (thread-through mecânico, mesmo padrão de `onOpen`/`onAssign`)                                                                                   |
| `src/components/inbox/assignment-board/agent-column.tsx`                    | Idem                                                                                                                                                                       |
| `src/components/inbox/assignment-board/assignment-board.tsx`                | `handleEditContact(card)` — busca o contato inteiro e abre `ContactForm` num `Dialog` próprio do board; `onSaved` chama `refreshCard(conversationId)` (novo, §11.4)      |
| `src/components/inbox/assignment-board/use-assignment-board.ts`             | Expõe `refetchCardInto` (já existe, uso interno do realtime) como `refreshCard` em `UseAssignmentBoardResult` — zero lógica nova, só publica o que já existia            |
| `messages/en.json` / `messages/pt-BR.json`                                  | `Inbox.sidebar.editContact` e `Inbox.assignmentBoard.editContact` — chaves novas, `actions.edit`/`contactInfo` de `Contacts.detailView` não fazem sentido nestes dois namespaces |

### 11.4 Por que `refreshCard` e não uma escrita otimista

O quadro já tem a peça certa: `refetchCardInto` é chamada pelo próprio
realtime quando chega um card cujo id ainda não está em nenhuma coluna
conhecida — ela busca a linha com `BOARD_CONVERSATION_SELECT`, remove o
card antigo (se houver) e reinsere o card fresco na coluna certa, com
notas/deal já re-hidratados. Editar o contato de um card já visível é o
mesmo problema ("os dados deste card estão velhos"), só que disparado
pela UI em vez do WebSocket — expor a função existente evita reescrever
a mesma reconciliação com um nome diferente.

### 11.5 Riscos e limites conhecidos (extensão)

| Risco / limite                                                                                 | Mitigação                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ContactSidebar` não tem `fetchContact()` próprio (o Sheet tem) — o refetch pós-save é um `select` novo, não uma função reaproveitada | Escopo mínimo (`name, phone, email, company, contact_tags(tags(*))`), mesma forma de `contactTagsForForm` de D-2                     |
| Editar meio de uma sessão de arrasto no quadro Time                                                | `handleEditContact` só é alcançável pelo menu "⋯", que já `stopPropagation` no `pointerdown`/`click` — não interfere no DnD          |
| `refreshCard` remove e reinsere o card — se a coluna do agente atribuído mudou nesse meio-tempo (outra aba reatribuiu) | Comportamento idêntico ao já usado pelo realtime: reinsere na coluna que a linha fresca indicar, não na antiga                       |

### 11.6 Checklist de teste manual (adendo ao §7)

11. **Chat/Fila.** Abrir uma conversa → coluna de detalhes à direita →
    botão "Editar" → modal abre preenchido → corrigir telefone → salvar →
    o painel à direita **e** o cabeçalho da conversa (se mostrar nome)
    refletem o valor novo, sem F5.
12. **Time.** Aba "Time" → menu "⋯" de um card → "Editar contato" → modal
    abre preenchido (inclusive e-mail, que o card não mostra) → salvar →
    o card atualiza nome/telefone/empresa sem recarregar a aba.
13. **Papel `viewer`, nas duas telas acima.** Item/botão de editar
    aparece desabilitado.
14. **pt-BR e en**, nas duas telas acima.

---

## Referências

- [`docs/spec-050-padronizacao-telefone-br.md`](./spec-050-padronizacao-telefone-br.md) — o contrato de formato que `saveDetails()` quebra hoje
- [`docs/spec-043-quadro-de-atribuicao.md`](./spec-043-quadro-de-atribuicao.md) — o quadro "Time" e o vocabulário coluna/card/`ConversationCard` que §11 estende
- `src/components/contacts/contact-form.tsx` — o modal reaproveitado, sem alterações
- `src/components/contacts/contact-detail-view.tsx` — F1-F2, o Sheet de detalhe
- `src/components/inbox/contact-sidebar.tsx` — F4, a coluna de detalhes do Chat/Fila
- `src/components/inbox/assignment-board/` — F5, o quadro "Time"
- `src/components/inbox/contacts-directory.tsx` — consumidor do Sheet no Inbox, sem alterações
- `src/app/(dashboard)/contacts/page.tsx` — consumidor do Sheet no gerenciador, sem alterações
