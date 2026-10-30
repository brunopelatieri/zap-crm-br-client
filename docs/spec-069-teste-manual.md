# SPEC 069 — Teste manual (F10)

Checklist executável do [§11.5 da SPEC 069](./spec-069-checagem-captacao-e-cascata-de-limites.md#115-manual-f10-contra-número-real), no formato do [`docs/spec-062-teste-manual.md`](./spec-062-teste-manual.md). Não é um documento novo de decisão — é o §11.5 desdobrado em passo a passo, com SQL/`curl` de conferência.

> **Ainda não executado.** F1–F10 estão implementadas e com suíte automatizada 100% verde (ver a memória do projeto e a tabela de fases da SPEC 069 §12), mas os itens abaixo dependem de uma instância WhatsApp QRCode real, pareada, e de um servidor Evolution ao vivo — nenhum é verificável por teste unitário. A F3 já mediu boa parte do comportamento contra `go.local.ia.br` (D-14, ver a SPEC), mas aquelas medições foram feitas com `curl` direto contra a Evolution — **não** exercitaram o CRM ponta a ponta (fila → cron → veredito → UI). É isso que este checklist cobre.
>
> **Item 8 fecha o D-14 #6**, a única pendência que a F3 deixou explicitamente aberta por não se derrubar uma sessão real em uso sem necessidade — aqui, com uma instância de teste dedicada, é seguro.

---

## 0. Preparação

- [ ] Uma instância WhatsApp QRCode **de teste**, pareada com um número que você pode se dar ao luxo de arriscar (nunca o número principal da empresa — PRD 068 §6 é claro sobre o risco de banimento). Se ainda não existe, crie pela aba Configurações → WhatsApp QRCode.

- [ ] Ligue os dois switches desta instância (R1) — via `PATCH`, já que a UI de switches é a F9 (`Settings.whatsappQrcode.enrichment`, já implementada):

  ```bash
  export BASE_URL="http://localhost:3000"
  # channelId da instância de teste — veja em Configurações ou:
  #   select id, channel_id, connected_phone, check_enabled, harvest_enabled
  #     from evolution_instances where account_id = '<sua conta>';
  ```

  Ou direto pela UI: Configurações → WhatsApp QRCode → cartão da instância → os dois switches. O de checagem só liga se a instância já estiver **conectada** (§6.1) — confirme o QR pareado antes.

- [ ] Confirme os dois crons rodando (5 em 5 min o de checagem, de hora em hora 00–05h o de captação — `AGENTS.md`/memória do projeto: `pg_cron` **não está instalado no `vn`**; se for testar contra `vn`, rode as rotas manualmente com `curl` em vez de esperar o agendamento):

  ```bash
  export CRON_SECRET="cole o valor de AUTOMATION_CRON_SECRET"
  curl -s -H "x-cron-secret: $CRON_SECRET" "$BASE_URL/api/contacts/check/cron" | jq
  curl -s -H "x-cron-secret: $CRON_SECRET" "$BASE_URL/api/contacts/harvest/cron" | jq
  ```

- [ ] Separe **20 números de teste**, dos quais **3 você já sabe que não existem no WhatsApp** (números inventados/desativados) — é o cenário do §11.5.

---

## 1. Checagem avulsa (R2/R3) — importação

- [ ] Importe os 20 números via Contatos → Importar, marcando **"Verificar estes números no WhatsApp"** (o checkbox só aparece habilitado se o passo 0 já ligou `check_enabled` numa instância conectada — confirme que ele aparece **desabilitado com o motivo** antes disso, depois habilitado depois).
- [ ] Confirme a estimativa de horas mostrada bate com `queued / evolution_check_per_day * 24` (o padrão é 300/dia).
- [ ] Aguarde o cron rodar (ou dispare manualmente, acima). Confira a fila:

  ```sql
  select status, count(*) from contact_check_queue
   where account_id = '<sua conta>'
   group by status;
  ```

- [ ] Depois de todos processados, confira os 3 números inexistentes:

  ```sql
  select phone, whatsapp_status, whatsapp_status_reason,
         whatsapp_checked_at, whatsapp_checked_channel_id
    from contacts
   where account_id = '<sua conta>' and phone in ('<num1>','<num2>','<num3>');
  ```

  Esperado: `whatsapp_status = 'invalid'`, `whatsapp_status_reason = 'qr_check'`, `whatsapp_checked_at` preenchido.

- [ ] Os 17 restantes: `whatsapp_status = 'valid'`, `whatsapp_checked_at` preenchido, `whatsapp_status_reason` **inalterado** (a checagem não escreve motivo quando concorda).

- [ ] Na tela do contato (gerenciador), confirme o selo **"Verificado em \<data\> via \<instância\>"** aparece para os 20.

## 2. Avatar (R4) — inbox e gerenciador

- [ ] Entre os 17 válidos, escolha um que você sabe ter foto de perfil no WhatsApp. Confirme `avatar_path`/`avatar_fetched_at` preenchidos:

  ```sql
  select phone, avatar_path, avatar_source, avatar_fetched_at
    from contacts where id = '<contact id>';
  ```

- [ ] Abra a conversa desse contato no **inbox** — a foto deve aparecer na lista de conversas, na sidebar do contato e no card do quadro de atribuição (os 3 lugares que já renderizavam `avatar_url` e passaram a preferir `avatar_path` assinado — F6).
- [ ] Abra o mesmo contato no **gerenciador** (Contatos → detalhe) — a foto deve aparecer ali também (a metade que faltava do R4).
- [ ] Um contato **sem** foto de perfil no WhatsApp continua mostrando exatamente as iniciais de hoje — nenhuma imagem quebrada, nenhum espaço em branco.

## 3. Discordância entre fontes (D-2, regra 3)

- [ ] Marque manualmente um contato como `invalid` pela tela (motivo `manual`), depois inclua o MESMO número num novo lote de checagem. Confirme que, mesmo a Evolution respondendo `IsInWhatsapp: true`, o status **continua** `invalid`:

  ```sql
  select whatsapp_status, whatsapp_status_reason, whatsapp_check_note
    from contacts where id = '<contact id>';
  ```

  Esperado: `whatsapp_status = 'invalid'` (inalterado), `whatsapp_check_note = 'qr_check_conflict'`.

## 4. Disparo parcial (R6) — campanha em `awaiting_check`

- [ ] Crie uma campanha nova com uma audiência de ~30 contatos (misture alguns dos 20 já checados com novos). No passo de audiência, marque **"Verificar estes números no WhatsApp"** e envie.
- [ ] Confirme que a campanha **não dispara imediatamente** — vai para `awaiting_check`:

  ```sql
  select status, check_before_send, check_channel_id, checked_count, total_recipients
    from broadcasts where id = '<broadcast id>';
  ```

- [ ] Na lista de campanhas e na tela de detalhe, confirme o badge **"Em espera — disparo parcial"** com o progresso `checked_count / total`.
- [ ] Rode o cron de checagem (ou aguarde) até a fila desta campanha ter itens `done`. Rode o cron de campanhas (`/api/broadcasts/cron`) — confirme que uma **fatia** sai (linhas em `broadcast_recipients` aparecem para os contatos já checados) e a campanha volta a `awaiting_check` se ainda sobrar fila, ou vai a `sent` se a fila esvaziou.
- [ ] Repita até a campanha concluir. Confirme `total_recipients` bate com o total de contatos validados (excluindo os `invalid`), e que **ninguém recebeu duas vezes**:

  ```sql
  select contact_id, count(*) from broadcast_recipients
   where broadcast_id = '<broadcast id>' group by contact_id having count(*) > 1;
  -- esperado: 0 linhas
  ```

## 5. Janela de envio (D-11)

- [ ] Force uma campanha com checagem pronta para disparar **fora** da janela de horário permitida (ajuste `send-window` ou rode fora do expediente configurado). Confirme que ela **não dispara**, continua em `awaiting_check`, e a trilha (`broadcast_audit_log`) registra `blocked_window` com `partial_send: true`:

  ```sql
  select event, details from broadcast_audit_log
   where broadcast_id = '<broadcast id>' order by created_at desc limit 5;
  ```

## 6. Captação de contatos (R5) — triagem

- [ ] Com `harvest_enabled = true` na instância de teste, rode o cron de captação manualmente (fora da janela 00–05h ele deve devolver `outside_window` sem tocar a Evolution — confirme isso primeiro rodando **fora** do horário):

  ```bash
  curl -s -H "x-cron-secret: $CRON_SECRET" "$BASE_URL/api/contacts/harvest/cron" | jq
  # esperado fora da janela: {"skipped":"outside_window", ...}
  ```

- [ ] Ajuste `EVOLUTION_HARVEST_WINDOW_START_HOUR`/`_END_HOUR` temporariamente (ou rode dentro da janela real) e rode de novo. Confirme linhas novas em `evolution_harvested_contacts` com `status = 'new'`.
- [ ] Abra Contatos → aba **"Importados do telefone"**. Confirme o aviso de LGPD fixo no topo, a lista dos captados, e que **nada** foi criado em `contacts` ainda:

  ```sql
  select count(*) from evolution_harvested_contacts
   where account_id = '<sua conta>' and status = 'new';
  ```

- [ ] Selecione alguns e clique **"Adicionar como contato"**. Confirme que viram `contacts` de verdade com `created_via = 'harvest'` e `opt_in_status = 'unknown'`:

  ```sql
  select id, name, created_via, opt_in_status from contacts
   where created_via = 'harvest' and account_id = '<sua conta>';
  ```

- [ ] Ignore os restantes — confirme que saem da lista (`status = 'ignored'`) sem virar contato.
- [ ] Repita a captação até o teto (`harvest_max_contacts`, se configurado) — confirme o aviso **"Teto atingido"** aparece no cartão da instância (Configurações) quando `harvested_count >= harvest_max_contacts`.

## 7. Cascata de limites (F2/F10) — herança e teto duro

- [ ] No cartão da instância (Configurações), confirme o bloco **"Limites em vigor"** mostra os 4 eixos com o nível de origem correto (`padrão do sistema` sem nada configurado).
- [ ] Como proprietário, em `/admin/accounts/[accountId]`, no painel **"Limites de segurança do WhatsApp QRCode"**, mude `evolution_cold_send_per_day` da conta para um valor próprio (ex.: 100). Confirme:
  - O cartão da instância em Configurações passa a mostrar `100 (herdando da conta)`.
  - Tentar salvar um valor acima do teto duro (`> 250`) é recusado com a mensagem do teto, e **nada é gravado**.
- [ ] Agora dê um valor PRÓPRIO à instância (não à conta) para o mesmo eixo — via `PATCH` na instância ou diretamente pelo endpoint de instância, já que este editor específico de override por instância fica no painel do proprietário apenas em modo leitura nesta fase (a escrita por instância é `evolution_instances.limit_overrides`, editável hoje via a rota `/api/admin/.../channel-limits` com `instances: {...}`). Confirme:
  - O painel do proprietário mostra o aviso **"N instância(s) com valor próprio"** ao lado do eixo da conta.
  - O cartão da instância em Configurações mostra `(valor próprio)`, não mais herdando.

## 8. Instância desconectada no meio de um lote (D-14 #6 — fecha a pendência)

Esta é a única verificação da D-14 que a F3 deixou aberta de propósito, por não se justificar derrubar uma sessão real em uso só para medir. Com a instância de TESTE (não uma em produção), agora é seguro.

- [ ] Enfileire uns 10 números para checagem nesta instância de teste. Antes do cron rodar, **desconecte a instância** (Configurações → Desconectar, ou derrube a sessão do WhatsApp no celular).
- [ ] Rode o cron de checagem manualmente. Confirme:
  - Os itens da fila **continuam `pending`** (não viraram `failed`, não tiveram `attempts` incrementado):
    ```sql
    select status, attempts from contact_check_queue
     where account_id = '<sua conta>' and check_channel_id = '<channel id>';
    ```
  - Nenhuma linha nova em `channel_cold_sends` com `kind = 'check'` para esta instância neste intervalo — confirma que nenhuma tentativa foi CONSUMIDA.
  - A resposta do cron reporta o grupo como `skipped` com `reason: instance_unavailable` (ou similar, conforme a implementação).
- [ ] Reconecte a instância e rode o cron de novo. Confirme que os itens voltam a ser processados normalmente.

## 9. Rotas de cron — contrato de auth

- [ ] `503` sem `AUTOMATION_CRON_SECRET` configurado (remova temporariamente, reinicie, teste, restaure):
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/contacts/check/cron"
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/contacts/harvest/cron"
  ```
- [ ] `401` com segredo errado:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -H "x-cron-secret: errado" "$BASE_URL/api/contacts/check/cron"
  ```
- [ ] `200` com o segredo certo (já exercitado nos itens acima).

---

## Ao terminar

- [ ] Desligue os switches da instância de teste (`check_enabled`/`harvest_enabled`) se ela não for continuar em uso real — os dois nascem `FALSE` por padrão, e é bom devolver o ambiente a esse estado depois do teste.
- [ ] Marque neste arquivo (ou na memória do projeto) que o teste rodou, com a data e quais dos 9 itens passaram/falharam. Um item que falhou vira um achado — registre na SPEC 069 (`§14 Armadilhas conhecidas` ou uma nova entrada), não só num commit avulso.
