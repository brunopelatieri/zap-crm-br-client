# PRD 077 — Outra URL com outro Supabase (Supabase dedicado por cliente)

|              |                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**   | Modelo decidido em 2026-10-30: **uma instância por URL**, com stack, Evolution Go e console próprios (§3). Execução na [SPEC 080](./spec-080-instancia-por-url.md) |
| **Datas**    | Escrito em 2026-10-02 · **refeito em 2026-10-30** (o objetivo deixou de ser consolidar o antigo `rs`, desativado)                                                  |
| **Migração** | Nenhuma                                                                                                                                                            |
| **Origem**   | [`prompt-prd-supabase-por-cliente-owner.md`](./prompt/prompt-prd-supabase-por-cliente-owner.md) (resolver por usuário, fallback para o `.env`), corrigido no §4    |
| **Contexto** | [`deploy-docker`][dd] (stack, `runtime-env`) · [`supabase-rls-mcp`][sr] (três clientes Supabase) · [`canais-e-qrcode`][cq] · [`whatsapp-cloud`][wc]                |

[dd]: ./context/deploy-docker.md
[sr]: ./context/supabase-rls-mcp.md
[cq]: ./context/canais-e-qrcode.md
[wc]: ./context/whatsapp-cloud.md

---

## 1. Objetivo

1. **Um Supabase oficial do Zap CRM BR:** o `vn`, configurado no `.env` da
   instância oficial em `https://zap.local.ia.br`. Ele tem vários clientes e
   continua sendo o padrão.
2. **Poder configurar outra URL** (ex.: `crm.cliente2.com.br`) que abre o
   mesmo Zap CRM BR, mesma versão e mesma interface, só que gravando num
   **outro projeto Supabase**, isolado do `vn`.

Caso de uso: cliente que exige banco próprio (contrato, LGPD, volume ou dado
sob controle dele) sem que o mantenedor tenha de manter um fork.

---

## 2. Fatos que decidem o desenho (2026-10-30)

**Uma imagem, configuração por container.** A imagem pública
`brunopelatieri/zap-crm-br` é construída uma vez com valores-marcador. Ao subir,
`docker/runtime-env.mjs` troca cada `NEXT_PUBLIC_*` pelo valor da stack
([`deploy-docker`][dd], regra 2). Os segredos (`service_role`,
`ENCRYPTION_KEY`, …) entram só pela stack. **Rodar a mesma imagem com outro
`.env` já é "o Zap CRM BR com outro Supabase"**, sem build novo.

**Um processo fala com um Supabase só.** Como o código obtém URL e chave:

| Ponto de acesso (fora de testes)              | Arquivos | Origem da URL/chave                                                            |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `supabaseAdmin()` (service_role, singleton)   | 97       | `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, uma vez por processo |
| `lib/supabase/client.ts` (browser, singleton) | 66       | `NEXT_PUBLIC_*` no bundle, trocado uma vez ao subir o container                |
| `lib/supabase/server.ts` (SSR)                | 23       | `NEXT_PUBLIC_*` + cookies da sessão                                            |
| `middleware.ts` · Realtime                    | 1 · 7    | `NEXT_PUBLIC_*` · cliente do browser                                           |
| Rotas de cron · webhooks Meta/Evolution       | 7 · 2    | `supabaseAdmin()`                                                              |

Remedir: `grep -rl --exclude='*.test.ts*' "supabaseAdmin\b" src | wc -l` (menos
`admin.ts`), idem para `from '@/lib/supabase/client'` e `.../server`.

**O resto também é por processo:** `ENCRYPTION_KEY`, `PLATFORM_OWNER_EMAILS`
(console `/admin`), `NEXT_PUBLIC_SITE_URL` (links de e-mail, webhook do
Evolution), `AUTOMATION_CRON_SECRET`, SMTP, URL e chave da Evolution Go.
O cookie de sessão do `@supabase/ssr` não define `domain`, então fica preso ao
host: duas URLs nunca compartilham sessão.

---

## 3. Decisão: uma instância por URL

Cada instância é um **conjunto próprio de stacks no Portainer**, todas com as
mesmas imagens:

- **Stack do app:** a imagem do Zap CRM BR, com a própria URL, o próprio
  `.env` (outro Supabase) e o próprio console `/admin`.
- **Stack da Evolution Go:** a mesma imagem da Evolution oficial, com URL,
  `GLOBAL_API_KEY` e banco próprios.

```text
Instância   Stack do app     URL do app            Supabase   Evolution Go (stack · URL)
oficial     zapcrm           zap.local.ia.br       vn         oficial · go.local.ia.br
cliente 2   zapcrm-<nome>    crm.cliente2.com.br   próprio    evogo-<nome> · <host-evolution>
```

Decidido em 2026-10-30 (SPEC 080, D-2 a D-4 e D-8): uma URL de app e uma stack
por instância; Evolution Go própria; console `/admin` próprio, com
`PLATFORM_OWNER_EMAILS` da instância.

| Ganha                                                                                                    | Paga                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Zero mudança de código**: o desenho atual já é "um processo, um banco"                                 | Duas stacks por instância (app + Evolution Go, com o banco e o armazenamento dela): RAM da VPS            |
| Isolamento total: processo, chave de cifragem, banco, console, crons e sessões de WhatsApp               | Cada migração nova é aplicada em N bancos, cada banco **antes** de reimplantar a stack dele (SPEC 080 §5) |
| Cada instância atualiza no próprio ritmo; uma fora do ar não afeta as outras e **nunca cai para o `vn`** | Crons, Auth do Supabase, DNS e webhooks configurados por instância                                        |
| Nada guarda chave de banco de cliente no `vn`                                                            | O `/admin` de cada instância só enxerga a própria (visão agregada = Opção C, §5)                          |

**Restrições que vêm do mundo de fora** (detalhe na SPEC 080 §3):

- **App da Meta não se divide entre instâncias.** O App tem **uma** URL de
  callback, e `subscribeWabaToApp` não usa o override por WABA. Instância com
  WhatsApp Cloud usa App próprio, com callback na URL dela. A migração 073 já
  guarda o `app_secret` por número.
- **Evolution Go exclusiva**: a `GLOBAL_API_KEY` manda em todas as sessões de
  um servidor Evolution. Por isso cada instância tem o seu, e uma nunca
  enxerga nem derruba o WhatsApp da outra.
- **Cada Supabase é um projeto à parte**: plano, backup, região e Auth (Site
  URL, SMTP, templates) configurados um a um.

---

## 4. Alternativas descartadas

**Resolver por usuário com fallback para o `.env` (o prompt original).** Não fecha:

- **B-1, ovo e galinha no login:** o `user_id` só existe no `auth.users` do
  banco onde o usuário nasceu, e o login bate no GoTrue do `.env` antes de
  qualquer resolução.
- **B-2, o browser fala direto com o banco:** 66 arquivos, inclusive escrita
  e Realtime.
- **B-3, trabalho sem sessão fica sem tenant:** 97 arquivos com
  `supabaseAdmin()` (webhooks, motores, crons, `/api/v1`).
- **B-4, o fallback grava no banco errado:** dado de um cliente aparece no do
  outro, em split-brain.
- **B-5, DDL não passa pela chave REST:** aplicar migração pelo app exigiria
  guardar a senha do Postgres.
- **B-6, a RLS proposta entrega a chave cifrada ao admin do cliente.**

**Um container que escolhe o Supabase pelo host da requisição.** É o jeito
viável de "uma instância atende várias URLs": tenant resolvido no middleware
antes do auth; os três singletons viram fábricas por host; o browser recebe URL
e chave anon em runtime; contexto de tenant carregado via `AsyncLocalStorage`
até `after()` e os motores; todo cache em memória separado por tenant;
`ENCRYPTION_KEY`, console e SMTP por tenant. São várias SPECs mexendo em
~190 arquivos, com risco permanente de vazar dado entre clientes por um cache ou
singleton esquecido. Em troca economiza só a RAM do container do app por instância.
Reabrir só se o número de URLs tornar a RAM o gargalo.

---

## 5. Evoluções previstas (fora da SPEC 080)

- **Opção C — painel de instâncias no `/admin` do `vn`:** a partir de 2
  instâncias extras. Cada instância expõe um endpoint de saúde (segredo
  compartilhado) com versão de schema e último cron; o `vn` **acompanha**, sem
  guardar chave de banco nem rotear dado.
- **Override de callback por WABA** (`override_callback_uri` em
  `subscribed_apps`): permitiria duas instâncias usarem o mesmo App da Meta.
  SPEC pequena, só se um App por cliente pesar.

## 6. Fora de escopo

- Roteamento por host num processo único (§4) e resolver por usuário.
- Migração de schema disparada pelo app; sincronização de dados entre bancos.
- Mover uma conta existente do `vn` para uma instância dedicada. Se surgir,
  vira SPEC própria: dump e restauração da conta com triggers desligados.

## 7. Como saber que deu certo

- `zap.local.ia.br` continua no `vn`, sem nenhuma mudança percebida pelos
  clientes atuais.
- Uma segunda URL abre o Zap CRM BR, faz login, envia e recebe mensagem, e
  nenhum dado dela aparece no `vn` (nem o contrário).
- Parar as stacks da segunda instância não afeta a oficial, e vice-versa; a sessão QR dela não aparece na Evolution oficial.
- Uma migração nova chega aos dois bancos antes da imagem nova, conferida pelo
  verificador de versão da SPEC 080.
