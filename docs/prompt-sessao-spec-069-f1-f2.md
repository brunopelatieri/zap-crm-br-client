# Prompt para nova sessão — SPEC 069, fases F1 e F2 (modelo: **Opus 5**)

> Copie e cole tudo abaixo da linha em uma sessão nova do Claude Code, aberta na raiz do
> repositório `zap-crm-br-client`, com o modelo **Opus 5**. Este arquivo é só o "correio" —
> pode apagá-lo depois de colar o conteúdo.
>
> **Por que Opus 5 nas duas fases:** a F2 é refatoração transversal com contrato de
> compatibilidade exato ("ninguém pode perceber") sobre um módulo de segurança que protege o
> número do cliente. É o tipo de mudança em que um erro sutil não aparece em teste nenhum e
> só se manifesta como número banido semanas depois. A F1 vai junto porque a F2 depende do
> schema dela e separar as duas em sessões diferentes custaria recontextualizar tudo.

---

Leia primeiro **`AGENTS.md`** (raiz do repositório) — inteiro, são as convenções obrigatórias
do projeto. Depois leia **`docs/prd-068-enriquecimento-e-validacao-por-instancia-qrcode.md`**
e **`docs/spec-069-checagem-captacao-e-cascata-de-limites.md`**, esta última inteira, mesmo as
seções que não são das suas fases — você precisa saber para onde a coisa vai para não fechar
portas.

**As decisões D-1 a D-14 da SPEC 069 foram todas ratificadas pelo mantenedor em 2026-09-03.**
Não reabra nenhuma delas. Se encontrar um problema real numa decisão ratificada, diga em duas
frases, registre no documento, e **siga implementando o que está escrito** — a decisão de mudar
o rumo é do mantenedor, não sua.

Você vai implementar **somente a F1 e a F2**. Nada de rota, nada de UI, nada de cliente
Evolution novo. **Pare depois da F2** e entregue o comando de commit pronto.

---

## Autorizações e proibições desta sessão

| | |
| --- | --- |
| ✅ **Aplicar a migração 078 no projeto Supabase `vn`** | O mantenedor autorizou explicitamente, e **só** o `vn`. Use o MCP `vn` (`apply_migration`). |
| ❌ **Não aplique no `rs`** | Ele fica para trás de propósito. Avise no fim da sessão que `vn` e `rs` estavam sincronizados até a 077 e que a partir de agora divergem em uma migração. |
| ❌ **Não rode git** | Commits e push são manuais do mantenedor. Entregue a linha pronta, não execute. |
| ❌ **Não implemente F3+** | Cliente Evolution, filas, crons, UI — nada disso nesta sessão. |

---

## F1 — Migração 078 e tipos

### O arquivo

`supabase/migrations/078_qr_enrichment_and_limits.sql`.

**Confira antes de nomear:** rode `ls supabase/migrations/`. Se já existir alguma `078` que eu
não conheço (outra sessão pode ter avançado), **pare e pergunte** ao mantenedor. Quando este
prompt foi escrito, a última era `077_conversation_exports.sql`.

O SQL completo está na **§5 da SPEC 069**, com as oito seções numeradas. Ele foi escrito para
ser copiado — mas **não copie sem ler**: confira cada `ALTER TABLE` contra o schema real
(`list_tables` do MCP `vn`, ou as migrações 056, 062, 065 e 067) antes de rodar. Uma coluna
que já existe com outro tipo, um CHECK com nome diferente do que a SPEC supõe, uma FK para uma
tabela que mudou — qualquer um desses transforma "copiei da SPEC" em migração que falha no meio.

### Os pontos sensíveis, em ordem de risco

1. **§5.6 — o CHECK de `broadcasts.status`.** É o mais perigoso da migração. Existem **duas**
   formas anteriores possíveis: a anônima por posição (migração 001) e a nomeada
   `broadcasts_status_streaming_check` (migração 065 §1.2). O `DO $$` da SPEC localiza a
   constraint **por conteúdo** justamente por isso. Leia a §1.2 da `065_inbound_contact_webhook.sql`
   antes de escrever, e confirme no `vn` qual das duas formas está lá de fato
   (`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.broadcasts'::regclass AND contype='c'`).
   O resultado tem que ser **um** CHECK com os **sete** valores.

2. **§5.3 — `channel_cold_sends.kind`.** `DEFAULT 'send'` é o que preserva a contagem: toda
   linha existente é envio. **Adicione também, nesta fase, o `.eq('kind', 'send')` em
   `src/lib/channels/cold-send-usage.ts`** (as três consultas) e o teste que prova que linha
   com `kind='check'` não entra na contagem de envio frio. A SPEC atribuiu esse filtro à F4;
   está errado — sem ele existe uma janela em que a invariante depende de ninguém inserir
   `kind='check'`, e "depende de ninguém fazer X" não é invariante. **Atualize a linha da F4 na
   tabela de fases da SPEC** removendo esse item, para os documentos não divergirem.

3. **§5.7 — bucket `contact-avatars`.** Privado, com policy só de SELECT. A expressão da policy
   extrai o `account_id` do primeiro segmento do caminho (`account-<uuid>`); teste o cast no
   `vn` antes de confiar nele — um caminho fora da convenção faz o `::uuid` **lançar**, não
   devolver falso, e isso derruba o SELECT inteiro em vez de negar uma linha. Se o cast for
   frágil, envolva em `regexp` de validação antes do cast e registre a mudança na SPEC.

4. **§5.8 — asserções.** Siga o estilo das migrações 041/052/059/061/062: `DO $$ … RAISE
   EXCEPTION … $$`, mensagem em português sem acento (o padrão da casa nesses blocos). As três
   mais fáceis de esquecer estão escritas na SPEC — em especial **"nenhuma instância pode
   nascer com checagem/captação ligada"**, que é a promessa do PRD 068 §6.2 virando código.

5. **Idempotência.** `IF NOT EXISTS` em toda `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`;
   `DROP … CREATE` para toda policy, trigger e constraint nomeada. **Rode a migração duas
   vezes seguidas no `vn`** — a segunda tem que passar sem erro e sem duplicar nada.

### Os tipos em `src/types/index.ts`

- `BroadcastStatus` ganha `'awaiting_check'`, com comentário no mesmo estilo do que já
  documenta `'streaming'`.
- `Contact` ganha `avatar_path`, `avatar_source`, `avatar_fetched_at`, `whatsapp_checked_at`,
  `whatsapp_checked_channel_id`, `whatsapp_check_note` — todos opcionais/nuláveis.
- Tipos novos para as duas tabelas novas (`ContactCheckQueueItem`, `HarvestedContact`) e para
  os campos novos de `Broadcast` (`check_before_send`, `check_channel_id`, `checked_count`,
  `check_resumed_at`).

**Consequência que vai quebrar o `typecheck`, e é para quebrar mesmo:**
`broadcastStatusConfig` em `src/lib/broadcast-status.ts:26` é
`Record<BroadcastStatus, StatusDisplay>` — exaustivo. Adicionar o valor ao tipo obriga a
adicionar a entrada. Faça:

- entrada `awaiting_check` com `label: 'awaiting_check'` (o `label` é o **slug da chave de
  i18n**, não texto), classes na paleta âmbar/laranja (é espera, não erro nem sucesso), e
  `pulse: false` — a campanha está **parada** esperando cota, ao contrário de `sending` e
  `streaming`, que pulsam porque estão vivas;
- chave `Broadcasts.status.awaiting_check` em **`messages/en.json` e `messages/pt-BR.json`**
  (`"Awaiting check"` / `"Em espera — disparo parcial"`). Note a convenção real: as chaves
  desse nó usam o **slug cru** (`streaming`, não `Streaming`), então é `awaiting_check` e não
  `awaitingCheck`. A §9 da SPEC escreveu `awaitingCheck` — **corrija a SPEC** para bater com o
  código.

Esta é a única string de UI permitida na F1, e ela existe porque sem ela o `i18n:check` e o
`build` não passam.

### Pronto quando (F1)

- [ ] `078_qr_enrichment_and_limits.sql` rodou **duas vezes** no `vn` sem erro e sem duplicação.
- [ ] O CHECK resultante de `broadcasts.status` tem os sete valores, num único constraint.
- [ ] Todas as asserções da §5.8 passam — inclusive a dos switches desligados.
- [ ] `SELECT count(*) FROM evolution_instances WHERE check_enabled OR harvest_enabled` = 0.
- [ ] `cold-send-usage.ts` filtra por `kind='send'`, com teste.
- [ ] `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — tudo verde.
- [ ] **Nenhum comportamento observável do app mudou.** Nenhuma tela nova, nenhum limite novo em
      vigor, nenhuma cota diferente. Se você não consegue afirmar isso com convicção, a F1 não
      acabou.

---

## F2 — A cascata de limites (o coração do R7)

Esta é a fase que decide se o R7 sai certo. Leia a **§3 inteira da SPEC** (inventário e desenho
da cascata) e a **§4** (módulos) antes de escrever a primeira linha. E leia, antes disso, dois
arquivos existentes que são o precedente direto:

- `src/lib/channels/cold-send-limit.ts` — a semântica de leitura que você tem que **preservar
  exatamente**: ausente/não-inteiro/negativo cai no padrão; `0` bloqueia; `0` em `silenceHours`
  cai no padrão.
- `src/lib/retention/global-defaults.ts` — o precedente mais próximo do parser de nível novo.
  O `parseConsoleDimension` dele distingue "chave ausente" de "chave presente com null", e o
  comentário explica que colapsar os dois **era o bug**. Você vai enfrentar o mesmo problema no
  JSONB de `evolution_instances.limit_overrides`.

### O que construir

1. **`src/lib/limits/registry.ts`** — o catálogo. Uma entrada por limite, com a forma
   `LimitEntry` da §4.1. Ele é a fonte de verdade da tabela §3 da SPEC: **as 22 linhas do §3.1
   + §3.2 viram 22 entradas**, com os tetos duros do §3.3 acoplados. Dado puro, sem lógica.

2. **`src/lib/limits/resolve.ts`** — módulo puro. `resolveLimitValue(entry, { instance, account, env })`
   → `{ value, level, clamped, hardCap }`. Sem banco, sem `process.env` implícito (o `env` é
   parâmetro, como em `readColdSendLimits` hoje).

3. **`src/lib/limits/load.ts`** — a metade impura. `loadEvolutionLimits(db, { accountId, channelId })`.
   **Uma** chamada a `account_effective_limits(account_id)` para todas as chaves (não uma
   `plan_limit()` por chave), mais o JSONB da instância. Memoizado por `(accountId, channelId)`
   dentro da requisição — o cron da F5 vai resolver uma vez por instância por ciclo, não uma
   vez por contato, e é aqui que isso é garantido.

4. **`QUOTA_KEYS`** em `src/lib/plans/types.ts` ganha as **dez** chaves de conta marcadas com
   nível 1a na §3.1/§3.2 da SPEC. Confira o `catalog.test.ts` — ele testa `QUOTA_KEYS` como
   contrato e vai precisar de atualização.

5. **`readColdSendLimits(env)`** reimplementada sobre o registro (níveis 2 e 3), **com a
   assinatura e o comportamento intactos**, mais a irmã nova `resolveColdSendLimits(db, { accountId, channelId })`
   que percorre os quatro níveis. `cold-send-wiring.checkColdSend` passa a chamar a segunda.

6. **`src/lib/evolution/limits.ts`** e **`src/lib/evolution/config.ts`** passam a pegar os
   valores de limite pela cascata. Atenção: `config.ts` também lê `EVOLUTION_API_URL`,
   `EVOLUTION_GLOBAL_API_KEY`, `EVOLUTION_INSTANCE_PREFIX` e `EVOLUTION_WEBHOOK_PUBLIC_URL` —
   isso é **conectividade, não limite**, e continua onde está. Só os quatro numéricos
   (`maxInstancesPerAccount`, `maxInstancesTotal`, `requestTimeoutMs`, `mediaRequestTimeoutMs`)
   migram para o registro.

### As cinco regras que os testes têm que prender (§3.4 da SPEC)

1. O nível 3 **sempre** responde — nunca existe "sem limite" por ausência de configuração.
2. Valor inválido **desce um nível**, nunca vira ausência de limite.
3. `0` é valor (bloqueia), não ausência — exceto em `silence_hours`.
4. O resolvedor devolve **qual nível venceu** (a UI da F9 depende disso para dizer "herdando da
   conta").
5. Nenhum call site lê `process.env` para decidir limite.

### O teste que é a razão de existir desta fase

```
env vazio + sem override de conta + sem override de instância
    ⇒ deepEqual(resolvido, COLD_SEND_DEFAULTS)
```

Esse teste é a promessa do R7 por escrito: **refatoramos a origem do valor, não a política.**
Um deployment que não configurou nada — nem painel, nem `.env` — tem que se comportar
exatamente como hoje, com os mesmos números. Escreva-o primeiro.

E replique, **em cada nível**, os casos que `cold-send-limit.test.ts` já cobre para o `.env`
(ausente, não numérico, negativo, `0`, `0` em `silenceHours`): a regra "valor inválido desce um
nível" vale para o JSONB da instância também, não só para variável de ambiente. É exatamente
onde um JSONB torto poderia virar "sem limite", que é o pior resultado possível aqui.

Mais: precedência com os quatro níveis divergentes; clamp de override de conta acima do teto
duro (`clamped: true`); `.env` acima do teto duro **não** clampado, mas com `console.warn`
(D-7); piso de `min_interval_seconds`.

### Pronto quando (F2)

- [ ] O teste de compatibilidade acima passa.
- [ ] Precedência instância > conta > `.env` > código coberta com os quatro níveis diferentes.
- [ ] Clamp, piso e o `warn` do `.env` acima do teto cobertos.
- [ ] `grep -rn "process.env.EVOLUTION_" src/` retorna **apenas** `src/lib/limits/` e as quatro
      variáveis de conectividade em `src/lib/evolution/config.ts`. Cole a saída do grep na sua
      resposta final — é a prova de que não existe um segundo resolvedor.
- [ ] **Nenhum teste existente foi alterado para passar.** Se `cold-send-limit.test.ts` precisou
      mudar, você mudou o comportamento — pare e reveja. O único teste existente que pode mudar
      é `catalog.test.ts`, e só para acomodar as chaves novas em `QUOTA_KEYS`.
- [ ] Gate completo verde: `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build`.
- [ ] Ainda **nenhuma UI nova** e nenhum limite novo em vigor: as chaves de checagem e captação
      existem no registro, mas ninguém as consome ainda.

---

## Convenções que valem para as duas fases

- **Lógica de negócio em `src/lib/`, com `*.test.ts` co-locado.** Regra nova sem teste ao lado
  não está pronta.
- **Comentário explica o *porquê*, não o *o quê*.** Leia dois ou três módulos vizinhos
  (`cold-send-limit.ts`, `retention/global-defaults.ts`, `evolution/limits.ts`) e escreva no
  mesmo tom — cabeçalho de arquivo dizendo qual problema o módulo resolve e qual armadilha ele
  fecha.
- **Cliente Supabase certo:** `admin.ts` (service_role) só em rota de servidor com autorização
  já validada; nunca importado em código que chega ao browser.
- **Este Next.js não é o que você conhece.** Antes de escrever qualquer coisa de framework,
  consulte `node_modules/next/dist/docs/`.
- **Rode o gate inteiro antes de dizer que acabou** — não existe CI neste repositório:
  ```bash
  npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
  ```

## O que entregar no fim

1. Resumo do que a F1 e a F2 mudaram, e a confirmação explícita de que **nada mudou para quem
   não configurou nada**.
2. A saída do `grep -rn "process.env.EVOLUTION_" src/`.
3. Confirmação de que a 078 foi aplicada **no `vn`** e o aviso de que o `rs` ficou uma migração
   atrás (estavam sincronizados até a 077).
4. As correções que você fez **na própria SPEC 069** (o item do `kind` que saiu da F4, a chave
   `awaiting_check` na §9, e qualquer divergência entre o SQL da §5 e o schema real que você
   encontrou).
5. A linha de `git add` + `git commit` **pronta para o mantenedor rodar** — não execute.
   Termine a mensagem com:
   ```
   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
   ```

**Pare na F2.** A F3 começa verificando as seis pendências do D-14 contra o servidor Evolution
real, e isso é sessão própria.
