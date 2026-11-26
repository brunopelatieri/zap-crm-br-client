# Prompt para nova sessão — SPEC 062 F7 (retenção muda de dono)

> Copie e cole tudo abaixo numa sessão nova do Claude Code, aberta na raiz do
> repositório `zap-crm-br-client`, com o modelo em **Opus**. Este arquivo é só
> o "correio" — pode apagá-lo depois de colar o conteúdo.

---

Leia primeiro **`AGENTS.md`** (raiz do repo) — convenções obrigatórias do
projeto — e depois **`docs/spec-062-console-do-proprietario.md`** inteira,
com atenção especial a **§3.8, §5.3, §7.5, §11 (armadilhas) e §12 (itens
13–15 do teste manual)**. Essa SPEC está "pronta para implementação"; você
vai implementar só a **F7** dela.

## O que já está pronto (não é seu trabalho verificar isso de novo)

- **F1** (migração `069_platform_console.sql`) — já **aplicada no projeto
  `vn`** (só nele; `rs` e `jh` continuam sem ela). A migração já fez a parte
  de **banco** da virada de dono da retenção (§3.8): as cinco policies de
  `channel_retention_policies`/`message_retention_state` já foram
  derrubadas, e `platform_settings.retention_defaults JSONB DEFAULT '{}'`
  já existe. **Você não vai escrever nem aplicar migração nova nesta
  fase** — F7 é só código de aplicação alcançando o que o banco já mudou.
- **F2** — `src/lib/retention/global-defaults.ts` já existe, com
  `mergeGlobalDefaults()` e `validateRetentionDefaults()` implementadas e
  testadas (`global-defaults.test.ts`, cobrindo as duas regras da §5.3:
  fusão dimensão a dimensão e tolerância a JSON malformado). **Você não
  cria esse arquivo — só o consome.**
- **F3–F6** — identidade do proprietário (`requirePlatformOwner`, 404
  sempre), layout `(platform)/admin` com `<RequirePlatformOwner>`,
  `/admin` (visão geral), `/admin/accounts` (lista + detalhe),
  `/admin/plans`, `/admin/settings`, `/admin/requests`, bloqueio de
  conta/usuário. Todos esses arquivos já existem e servem de **padrão
  visual e de código** para o que você vai construir — leia
  `src/components/platform/require-platform-owner.tsx`,
  `src/app/(platform)/admin/settings/page.tsx` e
  `src/app/(platform)/admin/accounts/[accountId]/page.tsx` antes de
  escrever qualquer coisa nova, para não reinventar um padrão que já
  existe (fetch + toast + Loader2 + gate duplo).

## O que é a F7

Da tabela de fases da SPEC 062 (§10):

> **F7** — Retenção muda de dono (§3.8, §5.3, §7.5): telas no console,
> `sweep.ts` lendo o padrão global, remoção da aba e das rotas do cliente,
> chaves i18n **movidas**.
> **Pronto quando:** dono da conta: aba ausente, rotas antigas 404, `0`
> linhas na política por SQL. Proprietário: prévia e salvamento funcionando
> por conta. Estrela e aviso da thread **intactos**.

Em cinco frentes, todas descritas em detalhe abaixo: (1) `sweep.ts` lendo o
padrão global do console, (2) duas telas novas no console, (3) remoção da
aba e das rotas do lado do cliente, (4) chaves i18n movidas (não
duplicadas), e (5) atualizar `docs/spec-060-teste-manual.md`.

---

## 1. `sweep.ts` — o elo novo na cadeia de precedência (§5.3)

Arquivo: `src/lib/retention/sweep.ts`, função `runMessageRetention`.

Hoje ela faz `const defaults = readRetentionDefaults(process.env);` e passa
esse `defaults` para `sweepAllPairs` → `sweepOnePair` → `resolveEffectivePolicy`
(em `policy.ts`, que **não muda** — ele já sabe resolver
`linha da política → defaults → sem limite`; o que muda é o que entra no
parâmetro `defaults`).

Você vai:

1. Depois de `readRetentionDefaults(process.env)`, ler
   `platform_settings.retention_defaults` — **uma linha, uma vez por ciclo**,
   com `service_role` (o mesmo `db` que a função já usa para ler
   `message_retention_state` logo abaixo). Não é um SELECT por par — é um
   SELECT só, igual ao de `message_retention_state`.
2. Chamar `mergeGlobalDefaults(consoleRaw, defaults)` de
   `@/lib/retention/global-defaults` e usar o **resultado** (não o
   `defaults` original) daí em diante — é isso que passa a viajar por
   `sweepAllPairs`/`sweepOnePair`.
3. **A leitura de `platform_settings` nunca pode abortar o ciclo.** Se a
   query falhar (erro de rede, coluna ausente num projeto onde a 069 não
   rodou — lembre-se que `rs` e `jh` não têm ela), cai para
   `readRetentionDefaults(process.env)` puro e **segue rodando** — é
   literalmente a armadilha nomeada na §11: "Varredura de retenção parou
   de rodar | `sweep.ts` passou a depender de `platform_settings` e a
   leitura falhou — precisa cair no `.env`, nunca abortar o ciclo".
4. **Regra 1 da SPEC 060 continua valendo primeiro**: se
   `readRetentionDefaults(process.env).enabled` for `false`, a função já
   retorna cedo (`skippedReason: 'disabled'`) **antes** de qualquer leitura
   de banco — não mude essa ordem. O padrão global do console nunca liga a
   varredura sozinho (§3.8 ponto 3, D-13): ele só ajusta os *números*
   quando ela já está ligada pelo `.env`.

Teste a mudar: `sweep.test.ts` (se existir — confira) precisa cobrir o
merge acontecendo, e a leitura de `platform_settings` falhando sem abortar
o ciclo. Se não houver `sweep.test.ts` hoje, não é obrigatório criar uma
suíte nova grande — mas cubra pelo menos esses dois casos, no estilo dos
testes que já existem em `src/lib/retention/*.test.ts`.

## 2. Duas telas novas no console (§7.5)

A SPEC 060 já entregou quatro componentes bons em `src/components/retention/`.
**Três são reaproveitados sem mudar forma, um é reescrito:**

| Componente | O que fazer |
| --- | --- |
| `retention-channel-card.tsx` | Reaproveitar inteiro — os três campos, o placeholder cinza de "herdado" e `formatRetentionSource` continuam certos, agora resolvendo contra um nível a mais na cadeia |
| `retention-preview.tsx` | Reaproveitar — a prévia antes de salvar (`p_dry_run`) é o item nº 1 da §8.2 da SPEC 060 e não pode se perder |
| `retention-usage.tsx` | Reaproveitar — "12.480 de 50.000 mensagens · 37 de 200 favoritas" |
| `retention-panel.tsx` | **Reescrever o invólucro**: sai `<RequireRole min="owner">` (de `@/components/auth/require-role`), entra `<RequirePlatformOwner>` (de `@/components/platform/require-platform-owner`, já existe); entram o seletor de conta (só na tela de conta única, ver abaixo) e a aba "Padrão global" |

Duas telas:

- **`/admin/retention`** (nova, `src/app/(platform)/admin/retention/page.tsx`)
  — o padrão global por tipo de canal, o que o `.env` definia sozinho até
  agora. Precisa mostrar:
  - o aviso do piso de idade (mesmo texto/ideia de `Settings.retention.floorNotice`
    que já existe — vai virar `Platform.retention.floorNotice`, ver seção 4);
  - o estado da última varredura (`message_retention_state.last_run_at` +
    `last_result`) — leia via uma rota nova `GET /api/platform/retention`
    (ver abaixo);
  - um `Alert` destacado quando `MESSAGE_RETENTION_ENABLED` está ausente:
    "a varredura não roda; os limites abaixo são registro, nada é apagado".
    Sem isso o proprietário configura tudo e conclui que o sistema está
    quebrado — é a mesma armadilha "liguei o interruptor e nada mudou" do
    guia de operação, do outro lado.
  - Salvar aqui grava em `platform_settings.retention_defaults` — **um PUT
    que valida com `validateRetentionDefaults()`** (rejeita o payload
    inteiro com erro claro se malformado — é o lado estrito, não o
    tolerante) e funde **dimensão a dimensão** ao salvar (nunca sobrescreve
    o objeto inteiro: editar só `maxMessages` no formulário não pode apagar
    um `retentionDays` que já estava lá para outro canal).
- **Bloco "Retenção" dentro de `/admin/accounts/[accountId]`** (a página já
  existe — `src/app/(platform)/admin/accounts/[accountId]/page.tsx` — você
  acrescenta uma seção nova, no mesmo padrão de `Card` que as seções
  existentes já usam) — a política **daquela conta**, com os mesmos
  cartões e a prévia calculada sobre os dados reais dela.

### Rotas novas necessárias (padrão: `requirePlatformOwner()` → 404 em
qualquer falha, igual a toda rota `/api/platform/**` já existente — leia
`src/app/api/platform/settings/route.ts` como modelo direto)

| Rota | Método | O quê |
| --- | --- | --- |
| `/api/platform/retention` | GET/PUT | Padrão global de retenção por tipo de canal + estado da última varredura (`message_retention_state`) |
| `/api/platform/accounts/[accountId]/retention` | GET/PUT | A política daquela conta, por tipo de canal |
| `/api/platform/accounts/[accountId]/retention/preview` | POST | Prévia (`p_dry_run`) sobre os limites **enviados no corpo**, para a conta escolhida |

Essas três rotas **substituem** `/api/account/retention` e
`/api/account/retention/preview` (ver seção 3 — aquelas são apagadas, não
uma cópia paralela). Olhe o código delas agora (`src/app/api/account/retention/route.ts`
e `src/app/api/account/retention/preview/route.ts`) para replicar a lógica
de leitura/gravação/prévia — a diferença é **quem** autentica
(`requirePlatformOwner()` em vez de `requireRole('owner')`) e, para as
rotas por conta, que o `accountId` vem do path, não da sessão. Toda escrita
grava `platform_audit_log` (padrão já em `src/lib/platform/audit.ts` —
reuse `writePlatformAudit`/`consoleActorTag`, não invente outro escritor).

## 3. O que sai do lado do cliente — sem sobra (§3.8, §7.5)

1. **`src/components/settings/settings-sections.ts`**: a entrada `'retention'`
   sai de `SETTINGS_SECTIONS` (o array `as const`) e de `SECTION_META` (o
   objeto com `id`, `label`, `icon`, `group`, `minRole`); o import de
   `Archive` sai também, **se** nada mais nesse arquivo o usa (confira com
   grep antes de remover o import).
   - **O `minRole` de `SectionMeta` continua existindo como campo do tipo**
     — não é código morto, é o mecanismo de gating do rail e será usado de
     novo por outra seção. Não remova o campo do tipo, só a entrada
     `retention`.
2. **`src/app/(dashboard)/settings/page.tsx`**: remova o import de
   `RetentionPanel` e a linha `retention: <RetentionPanel />,` do mapa de
   seções.
3. **`src/app/api/account/retention/route.ts` e
   `src/app/api/account/retention/preview/route.ts`**: **apagar os arquivos**
   (e a pasta `src/app/api/account/retention/` inteira, se ficar vazia) —
   não deixar respondendo 403/404 "morto". Uma rota que existe e recusa é
   código que alguém "conserta" um dia devolvendo o acesso ao dono da conta
   por engano.
4. Confira que `/settings?tab=retention` (uma URL com querystring apontando
   para uma aba que não existe mais) cai graciosamente no Overview — é
   provavelmente o comportamento padrão de qualquer `tab` desconhecida no
   componente de settings; **confirme, não assuma**.

**O que NÃO muda e você não encosta:** `messages.is_favorite`, a policy
`messages_update` da 017 (favoritar continua `agent+` — é uma coluna de
`messages`, não tem nada a ver com quem configura retenção), o aviso de
thread esvaziada (SPEC 060 §8.3), `purge_channel_messages` e o `REVOKE`
dela, o piso de idade e as três fases da varredura em si (`policy.ts`,
`schedule.ts` — só `sweep.ts` muda, e só na origem dos `defaults`).

## 4. i18n — mover, não duplicar (§7.5 item 3, §7.7)

As chaves `Settings.retention.*` (em `messages/en.json` e
`messages/pt-BR.json`) migram para `Platform.retention.*`. **Mover**: corte
o objeto de dentro de `Settings.retention` e cole dentro de `Platform`
(criando a chave `retention` lá, no mesmo nível de `Platform.plans`,
`Platform.settings` etc. que já existem) — não crie uma cópia e deixe a
antiga para trás. Se deixar as duas, `npm run i18n:check` **passa** (ele só
confere paridade entre os dois idiomas, não confere chaves órfãs) e a tela
do cliente fica com string morta — exatamente a armadilha nomeada na §11.

Depois de mover, ajuste todo `useTranslations('Settings.retention')` que
sobrar (deveria sobrar zero, já que os componentes inteiros mudam de
namespace) para `useTranslations('Platform.retention')`, e adicione as
chaves que as telas novas precisam (título/descrição de `/admin/retention`,
o texto do `Alert` de `MESSAGE_RETENTION_ENABLED` ausente, rótulos da seção
"Retenção" no detalhe da conta) seguindo o padrão dos outros namespaces
`Platform.*` que você já vai ver em `messages/en.json` (fonte) — sempre
escreva em inglês lá primeiro, traduza em `messages/pt-BR.json` depois, e
rode `npm run i18n:check` a cada lote.

## 5. `docs/spec-060-teste-manual.md` (§12, nota de rodapé)

O item 14 daquele arquivo ("Permissão → agente/admin não veem a política;
owner de outra conta recebe `0` linhas via SQL") fica **obsoleto** com a
virada de dono: agora **nenhum** dono de conta — nem o da própria conta —
vê a política pela sessão dele. Substitua aquele item pelos itens 13–15 do
teste manual da SPEC 062 §12 (reproduzidos abaixo, seção 6) ou por uma
referência direta a `docs/spec-062-teste-manual.md` (se esse arquivo já
existir; se não, não é obrigação desta fase criá-lo do zero — só apontar
para lá é suficiente, o roteiro de teste manual completo da 062 é a F10).

---

## 6. Os três itens do teste manual que provam que F7 está pronta (§12)

Não são testes automatizados — envolvem sessão real e RLS. Roteiro
executável (SQL incluso) fica para a F10, mas **você deve conseguir
verificar estes três manualmente antes de dar a fase como concluída**,
contra o projeto `vn` (autorização já dada pelo mantenedor para esse
projeto especificamente — não toque `rs`/`jh`):

13. **O dono da conta perdeu o acesso**: a aba não aparece em
    Configurações; `/settings?tab=retention` cai no Overview; as rotas
    antigas (`/api/account/retention*`) respondem 404 (porque não existem
    mais, não porque recusam); um `SELECT` em `channel_retention_policies`
    com a sessão dele devolve `0` linhas — **mesmo sendo
    `account_role = 'owner'`**.
14. **Nada se perdeu**: uma conta que já tinha política configurada antes
    da 069 continua com os mesmos três valores, conferido por
    `service_role` (não pela sessão do cliente — ela não vê mais nada, por
    design). A varredura seguinte apaga exatamente o que apagaria antes.
15. **O elo novo funciona**: com `.env` definindo `retentionDays` e o
    console definindo só `maxMessages` (para o mesmo canal), a varredura
    respeita **os dois** — a prévia do console bate com o que a execução
    real apaga em seguida.

## Convenções obrigatórias (de `AGENTS.md`)

- **Nenhuma migração nesta fase** — se em algum ponto você achar que
  precisa de uma coluna ou tabela nova, pare: isso significa que você saiu
  do escopo da F7 (a parte de banco já foi feita na F1) ou que entendeu
  algo errado da SPEC. Pergunte antes de escrever SQL.
- Depois de cada lote de mudança, rode a validação padrão:

  ```bash
  npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
  ```

- **Teste manual no navegador**: se você tiver acesso a um navegador (via
  Claude Desktop ou similar) já autenticado em `localhost:3000` com o
  mantenedor logado, use-o para verificar as telas novas e os itens 13–15
  acima **contra o projeto `vn`**. Para isso funcionar, `PLATFORM_OWNER_EMAILS`
  precisa estar setado em `.env.local` (o e-mail do mantenedor é
  `dono@exemplo.com`) — se você mesmo adicionar essa variável para
  testar, **remova-a de novo ao final** (é assim que as sessões anteriores
  desta SPEC fizeram — grep por "TEMPORÁRIO" em `.env.local` para ver se
  sobrou alguma de sessão anterior, o que seria inesperado). Qualquer
  escrita de teste feita direto no banco (bloquear algo, mudar uma
  política) precisa ser **revertida** ao final da sessão — confira o
  estado antes de mexer (`SELECT` primeiro) e depois (`SELECT` de novo)
  para provar que voltou ao original. Prefira testar em uma **transação
  com `ROLLBACK`** quando a checagem for só de RLS (não precisa persistir
  nada) — é o padrão que as sessões de F1 e F5 desta SPEC já usaram.
- **Git**: commits e push são manuais do mantenedor. Não rode `git commit`
  nem `git push`.

## O que NÃO fazer nesta sessão

- Não mexa em `plan-cycle-dialog.tsx`, `plan-panel.tsx`,
  `plan-request-state.tsx` nem em qualquer coisa de `/plan` do cliente —
  isso é §7.6, fase **F8**, fora do escopo.
- Não toque `channel_retention_policies`/`message_retention_state` no
  nível de **schema** — a virada de RLS já aconteceu na 069. Você só lê e
  escreve nelas por `service_role`, como o app já faz.
- Não invente uma quarta tela ou uma rota fora das três listadas na seção
  2 — o escopo é exatamente esse.

## Contexto de origem

Este trabalho vem do PRD `docs/prd-061-console-do-proprietario-e-ciclo-de-plano.md`
e da SPEC irmã `docs/spec-063-notificacoes-do-sistema-smtp.md` (fora do
escopo desta sessão). Todas as decisões de produto (D-1 a D-14) já foram
ratificadas pelo mantenedor — você não precisa perguntar nada sobre regra
de negócio, só implementar o que está escrito. F1 (migração 069, aplicada
em `vn`), F2 (núcleo TypeScript), F3 (identidade/visão geral), F4 (contas),
F5 (bloqueio, testado ao vivo) e F6 (troca de plano, testado ao vivo) já
foram implementadas e verificadas em sessões anteriores — não repita esse
trabalho, só construa em cima dele.

Se encontrar uma ambiguidade real entre o texto da SPEC e o código atual
(por exemplo, um componente que já mudou de forma desde que a SPEC foi
escrita), pare e pergunte antes de adivinhar.

Ao terminar, resuma o que foi criado, rode e reporte o resultado da
validação padrão, aponte qualquer desvio que você teve que fazer em
relação ao texto literal da SPEC (e por quê), e pare — não avance para F8
sem o mantenedor pedir explicitamente.
