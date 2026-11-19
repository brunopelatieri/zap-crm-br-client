# SPEC 087 — Formulários de captação: domínio próprio do owner (CNAME, verificação por TXT, certificado automático e tutorial de DNS)

**PRD:** [`docs/prd-084-formularios-de-captacao.md`](./prd-084-formularios-de-captacao.md) (D-16)
**Depende de:** [`SPEC 085`](./spec-085-formularios-nucleo.md) em produção; [`SPEC 086`](./spec-086-formularios-integracoes.md) não é pré-requisito.
**Status:** **decisões B-2…B-10 ratificadas com o PRD em 2026-11-06**; a B-1 (borda) segue como recomendação até o mantenedor configurar a VPS (F9-a). Contém **uma decisão de infraestrutura** (§3, B-1) que só o mantenedor pode tomar, porque depende da configuração da borda da VPS, que está em `docs/deploy/` (não lida por esta SPEC, por regra).
**Número provisório:** migração **100** (conferir `ls supabase/migrations/` e [`status.md`](./context/status.md)). A SPEC 086 também precisa renumerar a dela (a 099 foi usada pela área do contato): a que for aplicada depois toma o próximo número livre.
**Modelo de trabalho:** PRD 084 §10, F9 (Opus 5.5 decide a borda; Sonnet 5.5 implementa).

---

## 1. Resumo

O owner quer que o link do formulário seja `https://formularios.suaempresa.com.br/orcamento` em vez de `https://zap.local.ia.br/f/orcamento`. Para isso ele cria dois registros de DNS (um CNAME apontando para o ZAP e um TXT que prova que o domínio é dele), clica em "Verificar" no app, e o ZAP passa a responder naquele host com certificado TLS emitido automaticamente. Daí em diante, todo link que o ZAP gera para formulários daquela conta (inbox, disparo, automação, IA, área) usa o domínio verificado.

Três problemas, três partes: **prova de posse** (DNS), **certificado** (a borda da VPS) e **roteamento** (o app saber que `formularios.suaempresa.com.br/orcamento` é o formulário `orcamento` da conta X).

## 2. Estado de partida (medido em 2026-11-06)

| Fato                                                                                                           | Onde                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| O app roda numa VPS com Docker Swarm + Traefik, host `zap.local.ia.br`, certificado Let's Encrypt pelo Traefik | [`plano-implantacao-vps-zap-local-ia-br.md`](./plano-implantacao-vps-zap-local-ia-br.md) |
| Traefik é a borda e a porta do app não é publicada (premissa dos limites por IP, SPEC 083 A-5)                 | idem                                                                                     |
| `resolveRequestOrigin` prefere `NEXT_PUBLIC_SITE_URL`, depois `X-Forwarded-Host/Proto`                         | `src/lib/http/request-origin.ts`                                                         |
| `NEXT_PUBLIC_SITE_URL` é obrigatória na imagem Docker                                                          | `docker/runtime-env.mjs`                                                                 |
| O middleware decide por `pathname`; nunca olhou `host`                                                         | `src/middleware.ts`                                                                      |
| `Strict-Transport-Security: … includeSubDomains; preload` em toda resposta                                     | `next.config.ts`                                                                         |
| A página pública `/f/[slug]` e as rotas `/api/forms/public/**` exigem `Origin` igual à origem do app           | SPEC 085 §7.2                                                                            |
| Não há tabela de domínios nem código de DNS no repo                                                            | —                                                                                        |

## 3. Decisões de execução

| #    | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Motivo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B-1  | **Certificado sob demanda na borda, com consulta ao app antes de emitir.** Recomendação: **Caddy** como terminador TLS **só para hosts desconhecidos**, atrás de um roteador TCP do Traefik com `HostSNI(\`*\`)`em prioridade mínima e`tls.passthrough = true`; o Caddy usa `on_demand_tls`com`ask`apontando para`GET /api/forms/domains/ask?domain=<host>`e faz proxy HTTP para o serviço do app na rede`bru`. Alternativa a testar em staging antes de descartar: **Traefik sozinho**, roteador HTTP `HostRegexp(\`{host:.+}\`)`em prioridade mínima com`certResolver`, confiando na emissão sob demanda do Traefik para SNI desconhecido. | O Traefik não tem um gancho equivalente ao `ask` do Caddy: qualquer SNI que chegue à VPS (varredura, host inventado) viraria um pedido ao Let's Encrypt, e os limites de pedidos novos e de validações falhas são por conta ACME. O `ask` do Caddy pergunta ao ZAP se o host está **verificado** antes de pedir o certificado; host que o ZAP não conhece recebe `404` e o Caddy nem tenta. É a diferença entre uma borda que emite para quem a gente aprovou e uma que emite para quem bater na porta. A alternativa Traefik-só fica como experimento porque evita um componente novo; se passar no §9.3 com os riscos aceitos pelo mantenedor, vale. |
| B-2  | **Um host por domínio, vários formulários por host.** `form_domains(account_id, hostname UNIQUE)`; uma conta pode ter vários hosts; cada host tem `default_form_id` opcional (o que responde em `/`). `/<slug>` responde o formulário **daquela conta** com aquele slug; qualquer outro caminho é `404` neutro.                                                                                                                                                                                                                                                                                                                              | Ninguém quer `formularios.suaempresa.com.br/f/orcamento`; o prefixo `/f/` existe só no host do app. Restringir à conta impede que `suaempresa.com.br/<slug-de-outra-conta>` sirva formulário alheio.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B-3  | **Prova de posse por TXT, apontamento por CNAME.** TXT em `_zapcrm-verify.<host>` com valor `zapcrm-domain-verification=<token de 32 bytes base64url>`; CNAME de `<host>` para o alvo publicado em `FORM_DOMAINS_CNAME_TARGET` (padrão: o host de `NEXT_PUBLIC_SITE_URL`). O app resolve os dois com `dns.promises` apontado a resolvedores públicos (`1.1.1.1`, `8.8.8.8`), **não** o resolvedor do contêiner.                                                                                                                                                                                                                              | TXT prova posse sem exigir que o CNAME já propague; CNAME é o que faz o tráfego chegar. Resolvedor público evita cache local velho e dá resposta igual à que o Let's Encrypt verá. Apex (`suaempresa.com.br` sem subdomínio) **não é suportado** (CNAME em apex é inválido no DNS); o tutorial diz isso e sugere `formularios.` ou `form.`.                                                                                                                                                                                                                                                                                                            |
| B-4  | **Máquina de estados:** `pending` (criado, aguardando DNS) → `verified` (TXT e CNAME certos; o `ask` passa a responder `200`) → `active` (primeira resposta HTTPS bem-sucedida pelo host, conferida pelo próprio app via `fetch` ao `https://<host>/.well-known/zapcrm-domain` com `AbortSignal.timeout`) → `failed` (reverificação diária falhou 3 vezes seguidas; o `ask` volta a `404` e os links voltam ao host do app). `pending`/`failed` com > 30 dias sem sucesso é apagado pela varredura.                                                                                                                                          | O certificado só existe depois de `verified`; "ativo" é o que o owner vê como "funcionando". A reverificação diária é fase do `/api/automations/cron` (sem rota nova).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B-5  | **Roteamento no middleware por `host`**, com cache em memória (60 s) de `hostname → {account_id, default_form_id}` lido com `service_role` por `form_domain_lookup(host)`. Host igual ao do app (ou `localhost`) → fluxo normal. Host conhecido e `active`/`verified` → reescrita interna para `/f/<slug>?d=<domain_id>`; o `page.tsx` confere que o formulário pertence à conta do domínio (senão `404` neutro). Host desconhecido → `404` neutro imediato, sem `getUser()`.                                                                                                                                                                | O middleware já é o lugar que decide cedo por caminho; passa a decidir também por host. A reescrita interna mantém **uma** página pública; o `?d=` é só para a página saber a origem a usar nos links e no `Origin` esperado.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B-6  | **`Origin` aceito nas rotas públicas** = origem do app **ou** qualquer `https://<hostname>` com estado `verified`/`active` da conta do formulário (`isAllowedPublicOrigin(formId, origin)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sem isso, o envio pelo domínio próprio falharia na guarda de `Origin` da SPEC 085.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B-7  | **Links gerados pelo ZAP** usam o domínio da conta quando existe um `active` e o formulário tem `use_custom_domain = true` (padrão): `formPublicUrl` recebe `domain?: string` e produz `https://<host>/<slug>[?t=…]`. Formulário com `default_form_id` do host gera `https://<host>/[?t=…]`.                                                                                                                                                                                                                                                                                                                                                 | É o objetivo do recurso. Com mais de um host `active` na conta, o formulário escolhe qual (`forms.settings.custom_domain_id`), padrão o mais antigo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B-8  | **Cabeçalhos no domínio próprio:** mesmos cabeçalhos de segurança; `HSTS` sem `preload` para hosts que não são do app (regra extra em `next.config.ts` não consegue distinguir host; o middleware sobrescreve o cabeçalho na resposta reescrita). `frame-ancestors` por formulário continua valendo (SPEC 085 E-12).                                                                                                                                                                                                                                                                                                                         | `preload` é promessa para a lista dos navegadores; não cabe ao ZAP prometer isso pelo domínio do cliente.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B-9  | **Limite:** até 3 hosts por conta por padrão (`form_domains_max`, quota de **segurança** em `SAFETY_QUOTA_KEYS`, não aparece na barra de uso; configurável pelo proprietário por conta). `forms_enabled` continua sendo a chave que libera tudo isso.                                                                                                                                                                                                                                                                                                                                                                                        | Cada host é um certificado e uma linha na borda; não é algo que o cliente "compra em quantidade".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B-10 | **Tutorial dentro do app**, em Configurações → Formulários → Domínio próprio, com os valores reais já preenchidos (host, alvo do CNAME, nome e valor do TXT, botão copiar), estado ao vivo da verificação (último check, o que falhou: "TXT não encontrado", "CNAME aponta para X, esperado Y", "ainda propagando"), e notas por provedor (Registro.br, Cloudflare, GoDaddy, HostGator, Locaweb). Texto em `Settings.forms.domain.*` nos dois dicionários.                                                                                                                                                                                   | O pedido do PRD é "oferecer tutorial". Tutorial genérico em `docs/` ninguém acha; na tela, com os valores certos, o owner copia e cola.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 4. Comportamento

### 4.1. Jornada do owner

1. Configurações → Formulários → Domínio próprio → "Adicionar domínio" → digita `formularios.suaempresa.com.br`. Validação: hostname válido (RFC 1123, minúsculo, sem apex, não pode ser o host do app nem terminar nele, não pode ser IP, até 253 caracteres).
2. A tela mostra os dois registros a criar e o tutorial (B-10). Estado `pending`.
3. O owner cria os registros no provedor e clica "Verificar" (rate limit `formDomainVerify: 6/min` por usuário). O app resolve TXT e CNAME; cada falha vira mensagem específica. Sucesso → `verified`.
4. Em até alguns minutos (primeira requisição HTTPS ao host), a borda emite o certificado. O app, na verificação seguinte (botão ou cron), faz o `fetch` ao `/.well-known/zapcrm-domain` pelo host; sucesso → `active`. A tela mostra "Funcionando" com o link de exemplo.
5. Em cada formulário, "Compartilhar" passa a mostrar o link no domínio próprio; o owner pode escolher o formulário padrão do host (`/`).
6. Remover o domínio: confirmação; estado apagado; links voltam ao host do app na hora; o certificado na borda expira sozinho (Caddy limpa certificados não usados; Traefik mantém até vencer).

### 4.2. Jornada do visitante

`https://formularios.suaempresa.com.br/orcamento` → borda (certificado do host) → app (middleware reescreve para `/f/orcamento?d=…`) → página pública idêntica à do host do app, links e `Origin` do domínio próprio. `https://formularios.suaempresa.com.br/` → formulário padrão ou `404` neutro. Qualquer outro caminho → `404` neutro. Nenhuma rota da CRM, da área (`/area`) ou da API responde em host próprio (o middleware corta antes).

### 4.3. Endpoint `ask` da borda

`GET /api/forms/domains/ask?domain=<host>`: sem autenticação (a borda chama antes de existir TLS para aquele host), responde `200` texto `ok` se `form_domains.hostname = <host>` com estado `verified` ou `active` e a conta não bloqueada; senão `404`. Rate limit por IP `formDomainAsk: 60/min`; comparação exata, minúscula; nunca lista nada. Só revela "este host está cadastrado", que o próprio certificado emitido revelaria em seguida.

### 4.4. `/.well-known/zapcrm-domain`

Responde `200 { "host": "<host>", "account": "<8 primeiros caracteres do hash da conta>" }` **só** quando o `host` da requisição é um domínio `verified`/`active`; serve para o passo `verified → active` (B-4). No host do app responde `404`.

## 5. Banco — migração 100 `100_form_domains.sql`

```sql
CREATE TABLE form_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE CHECK (hostname = lower(hostname) AND hostname ~ '^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$'),
  verification_token TEXT NOT NULL,                       -- 32 bytes base64url; aparece na UI, não é segredo
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','active','failed')),
  default_form_id UUID NULL REFERENCES forms(id) ON DELETE SET NULL,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_form_domains_account ON form_domains(account_id);
```

- RLS: `SELECT` para `is_account_member(account_id)`; `INSERT/UPDATE/DELETE` para `is_account_member(account_id,'admin')`; **mas** a transição de `status` é só por função (`form_domain_set_status`, `SECURITY DEFINER`, só `service_role`): o cliente não pode se auto-verificar. Trigger `BEFORE UPDATE` recusa mudança de `status`, `verified_at`, `activated_at`, `last_*` vinda de `authenticated`.
- `form_domain_lookup(p_host TEXT) RETURNS TABLE(id, account_id, default_form_id, status)`: só `service_role`; é o que o middleware e o `ask` chamam.
- Trigger de quota `form_domains_max` no padrão de `enforce_contact_quota`, lendo `plan_limit(account,'form_domains_max')` (padrão de código 3 em `src/lib/limits/registry.ts`, `accountConfigurable: true`).
- `forms.settings` ganha `use_custom_domain` (padrão `true`) e `custom_domain_id` (sem migração: JSONB).
- `REVOKE … FROM PUBLIC, anon` em toda função; internas também `FROM authenticated`.

## 6. Módulo `src/lib/forms/domains/`

| Arquivo       | Faz                                                                                                                                                 | Teste                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `hostname.ts` | `normalizeHostname`, `isValidCustomHostname(host, appHost)` (sem apex, sem IP, não é o app)                                                         | casos válidos/inválidos, apex, IDN rejeitado (v1 só ASCII) |
| `records.ts`  | `expectedRecords(host, token, cnameTarget)` → `{txt: {name, value}, cname: {name, target}}`                                                         | formatação                                                 |
| `verify.ts`   | `verifyDomain(host, token, cnameTarget, resolver)` → `{txt: ok\|missing\|mismatch, cname: ok\|missing\|mismatch(actual), ok}`; resolvedor injetável | cada combinação com resolvedor falso; timeout              |
| `activate.ts` | `probeHttps(host)` → `ok \| tls_error \| http_error \| timeout` (`fetch` com timeout 8 s, sem seguir redirect)                                      | com `fetch` falso                                          |
| `lookup.ts`   | Cache em memória de `form_domain_lookup` (TTL 60 s, invalidação por host ao salvar)                                                                 | TTL, invalidação                                           |
| `origin.ts`   | `isAllowedPublicOrigin(formAccountId, origin)` (B-6) e `publicOriginFor(form)` (B-7)                                                                | app, domínio ativo, domínio de outra conta                 |
| `state.ts`    | Transições B-4 (`nextState(current, verifyResult, probeResult, failures)`)                                                                          | tabela de transições inteira                               |

Rotas: `GET/POST /api/forms/domains`, `DELETE /api/forms/domains/[id]`, `POST /api/forms/domains/[id]/verify`, `PUT /api/forms/domains/[id]/default-form` (todas `requireRole('admin')` + `requireFormsFeature`); `GET /api/forms/domains/ask` (§4.3); `GET /.well-known/zapcrm-domain` (§4.4). Fase `formDomains` do `/api/automations/cron`: reverifica `verified`/`active` uma vez por dia e tenta ativar `verified`; aplica B-4.

## 7. Borda (VPS) — o que o mantenedor configura

Esta SPEC **não** lê nem altera `docs/deploy/`. O que segue é o desenho para o mantenedor aplicar na stack, com os nomes a confirmar lá.

### 7.1. Opção recomendada — Caddy sob demanda atrás do Traefik (B-1)

1. **DNS do deployment:** nenhum registro novo é obrigatório; o CNAME do cliente aponta para o host do app (ou para `FORM_DOMAINS_CNAME_TARGET`, se o mantenedor preferir um alvo dedicado como `forms.zap.local.ia.br` → A da VPS).
2. **Traefik:** entrypoint `websecure` ganha um roteador **TCP** `forms-passthrough` com regra `HostSNI(\`*\`)`, `priority: 1`(a menor possível, para perder de todo`Host(...)`HTTP existente),`tls.passthrough: true`, serviço TCP → `caddy:443`. HTTP (`:80`) para hosts desconhecidos também precisa chegar ao Caddy para o desafio ACME HTTP-01, **ou** o Caddy usa só TLS-ALPN-01 (recomendado: só ALPN, então nada muda no `:80` do Traefik).
3. **Caddy** (imagem oficial, rede `bru`, volume para `/data`), `Caddyfile`:

```caddyfile
{
  email <e-mail ACME>
  on_demand_tls {
    ask http://<serviço-do-app>:3000/api/forms/domains/ask
    interval 2m
    burst 5
  }
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy <serviço-do-app>:3000 {
    header_up Host {host}
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-For {remote_host}
  }
}
```

4. **App:** `X-Forwarded-For` continua confiável porque a única borda que fala com o app é Traefik ou Caddy, ambos na rede interna (manter a porta do app não publicada).
5. **Conferência:** `openssl s_client -connect <ip-da-vps>:443 -servername <host-cliente>` mostra certificado do host; `-servername host-inexistente.example` **não** gera pedido (ver logs do Caddy: `ask` respondeu 404).

### 7.2. Alternativa — Traefik sozinho (experimento em staging)

Roteador HTTP `forms-catchall` com `rule: HostRegexp(\`{host:.+}\`)`, `priority: 1`, `tls.certResolver: <resolver existente>`, serviço → app. Critério para adotar: em staging, SNI de host **verificado** recebe certificado na primeira requisição **e** SNI de host **inexistente** não dispara pedido ACME (conferir logs do Traefik por `acme`). Se disparar, a alternativa fica descartada pelo motivo de B-1.

### 7.3. Variáveis novas no app

`FORM_DOMAINS_CNAME_TARGET` (opcional; padrão: host de `NEXT_PUBLIC_SITE_URL`), `FORM_DOMAINS_RESOLVERS` (opcional; padrão `1.1.1.1,8.8.8.8`). Nomes vão para `.env.local.example` e para o README § deploy; valores nunca no repo.

## 8. Tutorial (texto base para `Settings.forms.domain.tutorial.*`)

Exibido com os valores reais preenchidos. Em pt-BR (o `en.json` recebe a tradução):

1. **Escolha o endereço.** Use um subdomínio, como `formularios.suaempresa.com.br`. O domínio principal sem nada na frente (`suaempresa.com.br`) não funciona com este método.
2. **Entre no painel de DNS do seu provedor** (onde você registrou ou hospeda o domínio).
3. **Crie o registro CNAME.** Nome/host: `formularios` (só a parte antes do seu domínio). Tipo: `CNAME`. Valor/destino: `<alvo>`. TTL: o menor disponível (300 ou "automático").
4. **Crie o registro TXT.** Nome/host: `_zapcrm-verify.formularios`. Tipo: `TXT`. Valor: `zapcrm-domain-verification=<token>`.
5. **Aguarde a propagação** (em geral alguns minutos; pode levar até 24 h) e clique em **Verificar**. A tela diz exatamente o que ainda falta.
6. **Pronto.** Quando aparecer "Funcionando", os links dos seus formulários passam a usar o novo endereço. Se um dia remover os registros, os links voltam ao endereço padrão sozinhos.

Notas por provedor (uma frase cada, só o que difere): **Registro.br** — "Editar zona" → "Adicionar registro"; o nome é só o subdomínio. **Cloudflare** — deixe o registro CNAME com a nuvem **cinza** (DNS only), não laranja (proxy), senão o certificado não é emitido pelo ZAP. **GoDaddy** — em "Registros", o campo "Nome" não leva o domínio. **HostGator / Locaweb** — o TXT pode exigir aspas no valor; copie com aspas se o painel pedir. Em qualquer provedor, se o painel exigir ponto final no destino do CNAME, use `<alvo>.`.

Mensagens de erro da verificação (`Settings.forms.domain.errors.*`): `txtMissing`, `txtMismatch`, `cnameMissing`, `cnameMismatch` (com `{actual}` e `{expected}`), `apexNotSupported`, `isAppHost`, `probeFailed`, `stillPropagating`.

## 9. Segurança e riscos

1. **Emissão só para host verificado** (B-1 `ask`); o `ask` é exato e rate-limitado; o token de verificação é único por domínio.
2. **Host de outra conta nunca serve formulário alheio** (B-2, B-5: página confere `account_id`).
3. **Nenhuma rota da CRM, da área ou da API em host próprio** (B-5 corta no middleware antes de `getUser()`): a sessão da CRM nunca viaja para domínio de cliente; os cookies `sb-*` e `zap_area_session` não são emitidos lá.
4. **`Origin` por domínio verificado** (B-6), não por qualquer `https://`.
5. **Domínio que o cliente deixou de controlar:** reverificação diária; 3 falhas → `failed` → `ask` nega e links voltam ao app (B-4). Um domínio expirado e re-registrado por terceiro não continua servindo o formulário do cliente antigo.
6. **Takeover de subdomínio pendurado:** se o cliente remover o CNAME e deixar o registro no ZAP, o host passa a `failed` e sai; se remover do ZAP e deixar o CNAME, a borda nega (`ask` 404) e o app responde `404` neutro. Nos dois casos ninguém mais consegue "reivindicar" o host sem o TXT com o token da conta.
7. **Limites do Let's Encrypt:** 50 certificados por domínio registrado por semana afetam o **cliente** (não o deployment) e só se ele criar dezenas de hosts; `form_domains_max` (B-9) contém isso. Validações falhas contam por host; o `ask` impede tentativas para hosts não verificados.
8. **Riscos aceitos:** (a) o Caddy é um componente novo na VPS (imagem oficial, config de 20 linhas); (b) primeira requisição HTTPS a um host novo demora alguns segundos (emissão); (c) `HSTS` sem `preload` no domínio do cliente (B-8).

### 9.3. Critérios de aceite

1. Hostname inválido, apex, IP e o host do app são recusados com mensagem própria.
2. Com TXT certo e CNAME errado: `cnameMismatch` com o valor atual; com os dois certos: `verified`; `ask` responde `200` para esse host e `404` para qualquer outro.
3. Em staging: `openssl s_client -servername <host verificado>` recebe certificado válido do host; `-servername <inventado>` não gera pedido ACME (logs).
4. `https://<host>/<slug>` abre o formulário da conta; `<slug>` de outra conta → `404` neutro; `/dashboard`, `/area`, `/api/v1/me` no host próprio → `404` neutro sem `Set-Cookie`.
5. Envio pelo host próprio passa na guarda de `Origin`; a resposta grava `source` normal e o link de agradecimento usa o host próprio.
6. Link gerado no inbox, disparo, automação e IA para formulário da conta usa `https://<host>/<slug>?t=…`; com `use_custom_domain = false` volta ao host do app.
7. Remover o domínio: links voltam ao app na próxima geração; `ask` nega em até 60 s (cache).
8. Reverificação diária: remover o TXT no provedor → após 3 execuções, `failed`, aviso in-app ao `admin+`.
9. `get_advisors` sem achado; `anon` sem `SELECT` em `form_domains`; `authenticated` não consegue `UPDATE status` (trigger).

## 10. Plano de implementação

| Fase | Entrega                                                                                                                                                                | Gate                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| F9-a | **Decisão de borda** (B-1) pelo mantenedor, com teste em staging da §7.2 se quiser evitar o Caddy                                                                      | Registrada nesta SPEC             |
| F9-b | Migração 100, `src/lib/forms/domains/*` com testes, `registry.ts` (`form_domains_max`), rotas, `ask`, `.well-known`, middleware por host, `origin.ts`, `formPublicUrl` | `typecheck && test && lint`       |
| F9-c | UI em Configurações (tutorial, estados, erros), i18n, fase `formDomains` do cron, `status.md`, `docs/context/formularios.md`                                           | Gate completo                     |
| F9-d | Borda na VPS (mantenedor), migração no `vn` com confirmação, primeiro domínio de teste do próprio mantenedor                                                           | Critérios 3–8 com um domínio real |
| F9-e | `/security-review` do diff; piloto com uma conta                                                                                                                       | Sem HIGH/MEDIUM novo              |

## 11. Fora desta SPEC

Apex por ALIAS/ANAME (depende de provedor); IDN (punycode) na v1; domínio próprio para a **área do contato** (`/area`) ou para a CRM (outro PRD, outros cookies); e-mail no domínio do cliente; certificado wildcard do cliente trazido à mão.

## 12. Armadilhas específicas

| Sintoma                                                       | Causa provável                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Verificado" mas o navegador dá erro de certificado           | Borda não configurada (§7), ou Cloudflare com proxy laranja na frente                                    |
| Verifica no app, mas o `dig` do mantenedor mostra outra coisa | Resolvedor diferente; o app usa `1.1.1.1`/`8.8.8.8` de propósito                                         |
| Host próprio abre a tela de login da CRM                      | Middleware não cortou por host (B-5) — nunca pode acontecer; é bug de segurança, tratar como incidente   |
| Envio falha com 403 no domínio próprio                        | `Origin` não está na lista (B-6): domínio ainda `pending`, ou cache de 60 s                              |
| Certificado emitido para host inventado                       | `ask` desligado ou apontando para rota errada; ou alternativa Traefik-só adotada sem o critério 3 passar |
