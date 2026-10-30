# SPEC 064 — Teste manual (F11)

Checklist executável do [§12 da SPEC 064](./spec-064-multiplos-numeros-oficiais.md#12-teste-manual-f11--contra-número-real), no formato do [`docs/spec-062-teste-manual.md`](./spec-062-teste-manual.md). Não é um documento novo de decisão — é o §12 desdobrado em passo a passo, com o SQL/`curl` de conferência pronto para colar. A tabela original tem **27 linhas** (o texto da fase em §8.2 dizia "24" — a própria SPEC já registra essa divergência, ver rodapé da tabela; a lista abaixo segue as 27 linhas de verdade).

> **Ainda não executado.** F1–F10 estão implementadas com o gate automatizado 100% verde (typecheck, i18n, lint, 2361 testes/185 arquivos, format:check, build, `redocly lint` + paridade estrutural nos dois `openapi*.json`) e uma revisão `/code-review high` rodada e corrigida (10 achados, todos fixados). Mas os 27 itens abaixo envolvem **dois números oficiais de verdade**, RLS, e o comportamento observável da Meta — nada disso é verificável por teste unitário. Marque cada item ao rodar de verdade; não preencha resultado sem ter rodado.
>
> A classe de bug que esta SPEC pode causar é **silenciosa**: a mensagem sai pelo número errado, o cliente recebe, o CRM grava, e ninguém percebe até alguém estranhar o remetente (§11 da SPEC). É por isso que praticamente todo item abaixo pede para confirmar por SQL/log qual `channel_id`/`phone_number_id` foi usado de verdade — nunca só "a tela pareceu certa".

---

## 0. Preparação

Feito uma vez, antes dos 27 itens abaixo. **Nunca contra dado real de cliente** — use uma conta de teste (ou uma conta real que já tenha autorizado o teste), e reverta qualquer estado sintético ao final de cada item que criar um.

- [ ] **Dois números oficiais Meta de verdade**, de preferência um em **WABA próprio** e outro **compartilhando WABA** com o primeiro — é o caso que o D-2 decide (templates por WABA) e que nenhum teste automatizado cobre. Se só conseguir dois números em WABAs diferentes, marque os itens 13/14 como "não testável nesta rodada" em vez de forçar.
- [ ] Confirme em qual projeto Supabase você está testando (`vn` ou `rs` — regra do `AGENTS.md`) antes de rodar qualquer SQL. A migração `072_multi_cloud_channels.sql` precisa estar aplicada nesse projeto (§1 do índice de migrações) — **`rs` ainda não tinha recebido** na última verificação desta sessão; confirme antes de testar lá.
- [ ] Variáveis de ambiente:

  ```bash
  export BASE_URL="http://localhost:3000"   # ou o domínio de produção
  export CRON_SECRET="cole o valor de AUTOMATION_CRON_SECRET aqui"
  ```

- [ ] Ache os ids que você vai usar nas consultas abaixo, assim que o 2º número existir (item 1):

  ```sql
  select c.id as channel_id, c.name, c.identifier, c.status, c.is_default,
         wc.phone_number_id, wc.waba_id
    from channels c
    left join whatsapp_config wc on wc.channel_id = c.id
   where c.account_id = '<id da conta de teste>'
     and c.type = 'whatsapp_cloud'
   order by c.created_at;
  ```

- [ ] Se a conta de teste também tiver uma instância WhatsApp QRCode (para os itens 25–26), anote o `channel_id` dela na mesma consulta acima trocando `type = 'whatsapp_qr'`.

---

## 1. Conectar o 2º número

**Por quê:** é o ponto sem retorno da SPEC (§10) — depois deste item, a conta tem dois números oficiais de verdade e reverter deixa de ser trivial.

1. Configurações → WhatsApp (aba F7 — lista de números) → "Conectar outro número". Preencha `phone_number_id`, `waba_id`, token e PIN do segundo número.
2. Confirme que ele aparece na lista, com selo de status e telefone corretos (D-9).
3. Confirme por SQL que o **1º continua sendo o padrão** (o novo nasce `is_default = false`):

   ```sql
   select id, name, is_default, status from channels
    where account_id = '<id da conta>' and type = 'whatsapp_cloud'
    order by created_at;
   ```

- [ ] Passou — canal criado, aparece na lista, padrão continua no 1º

---

## 2. Contato manda mensagem para o 2º

1. De um celular real, mande uma mensagem de WhatsApp para o **2º** número.
2. No inbox, confirme que uma conversa **nova** nasceu (não caiu numa conversa existente do 1º número) com o selo do canal certo.
3. Confirme por SQL:

   ```sql
   select id, channel_id from conversations
    where account_id = '<id da conta>'
    order by created_at desc limit 1;
   -- Espera-se: channel_id = o id do 2º canal (item 1).
   ```

- [ ] Passou

---

## 3. Responder pelo inbox

1. Responda a conversa do item 2 pelo inbox normalmente.
2. Confirme que a mensagem chega **do 2º número** no celular de teste (não do 1º).
3. Confirme por SQL — o mesmo SQL de conferência que a SPEC já documenta:

   ```sql
   SELECT m.id, m.direction, c.name AS canal, wc.phone_number_id
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     LEFT JOIN whatsapp_config wc ON wc.channel_id = c.id
    WHERE m.conversation_id = '<uuid da conversa do item 2>'
    ORDER BY m.created_at DESC LIMIT 10;
   -- Espera-se: `canal` e `phone_number_id` do 2º número em toda linha outbound.
   ```

4. Se o log estruturado (F10, §11.1) estiver acessível no ambiente de teste, confirme a mesma coisa por log em vez de SQL — `grep '"event":"outbound_send"'` na saída do servidor deve mostrar `"origin":"inbox"` e o `channelId`/`phoneNumberId` do 2º número.

- [ ] Passou — `messages.channel_id` do 2º número, mensagem chegou do 2º de verdade

---

## 4. Responder conversa antiga (1º número)

**Por quê:** é a regressão mais provável de toda a SPEC — um bug de fallback faria TUDO sair pelo canal errado assim que existisse um segundo.

1. Abra uma conversa antiga, criada **antes** do 2º número existir (`conversations.channel_id` deve ser o 1º canal, ou `NULL` se anterior à migração 059).
2. Responda pelo inbox.
3. Confirme que a mensagem sai pelo **1º** número (celular de teste recebe do 1º) e que `messages.channel_id` grava o 1º canal.

- [ ] Passou — nenhuma conversa antiga mudou de número sozinha

---

## 5. Automação na conversa do 2º

1. Tenha uma automação simples (gatilho por palavra-chave, por exemplo) ativa na conta.
2. Do celular de teste, mande a palavra-chave para o **2º** número.
3. Confirme que a resposta automática sai pelo **2º** número (celular recebe do 2º).
4. Se o F10 estiver acessível: log deve mostrar `"origin":"automation"` com o `channelId` do 2º canal.

- [ ] Passou

---

## 6. Flow com botões na conversa do 2º

1. Tenha um Flow com um nó de botões interativos ativo.
2. Dispare o Flow numa conversa do **2º** número (pelo gatilho configurado, ou manualmente pelo builder se ele suportar disparo de teste numa conversa real).
3. Confirme que os botões chegam renderizados no celular (não como texto cru) e que a mensagem saiu do 2º número.
4. Se o F10 estiver acessível: log deve mostrar `"origin":"flow"`, nunca `"automation"` (achado #3 da revisão desta SPEC corrigiu exatamente essa confusão para o caso de automação delegando a botões/listas — vale conferir que o inverso também não acontece).

- [ ] Passou

---

## 7. IA responde na conversa do 2º

1. Tenha o auto-reply de IA configurado e ativo na conta.
2. Mande uma mensagem para o **2º** número que dispare o auto-reply.
3. Confirme que a resposta sai pelo 2º número.
4. Se o F10 estiver acessível: log deve mostrar `"origin":"ai"` (o auto-reply passa por `flows/meta-send.ts` com `aiGenerated: true` — confira que NÃO aparece como `"flow"`, que seria o sinal de que o parâmetro `origin` parou de ser propagado).

- [ ] Passou

---

## 8. Campanha escolhendo o 2º

1. Broadcasts → Nova campanha. No passo 4 ("Enviar por" — só aparece com mais de um canal Cloud conectado), escolha explicitamente o **2º** número.
2. Envie para 2–3 contatos de teste.
3. Confirme que as mensagens chegam do 2º número.
4. Confirme por SQL que o canal foi **gravado na criação**:

   ```sql
   select id, channel_id, status from broadcasts
    where account_id = '<id da conta>'
    order by created_at desc limit 1;
   -- Espera-se: channel_id = o id do 2º canal, não NULL.
   ```

- [ ] Passou — campanha saiu do 2º; `broadcasts.channel_id` gravado

---

## 9. Campanha agendada, trocar o padrão antes de disparar

**Por quê:** é o teste direto do D-3 — "resolver e GRAVAR na criação, nunca recalcular no disparo".

1. Agende uma campanha (Broadcasts → Nova campanha → agendar) explicitamente pelo **1º** número (ou deixe em branco se o 1º for o padrão no momento).
2. **Antes** do horário disparar, troque o padrão da conta para o 2º número (lista de números → "Definir como padrão" no 2º).
3. Deixe o agendamento disparar (ou force via cron):

   ```bash
   curl -s "$BASE_URL/api/broadcasts/cron" -H "x-cron-secret: $CRON_SECRET"
   ```

4. Confirme que a campanha saiu pelo canal **gravado no agendamento** (o 1º), não pelo novo padrão (o 2º):

   ```sql
   select id, channel_id, status from broadcasts
    where account_id = '<id da conta>'
    order by created_at desc limit 1;
   ```

- [ ] Passou — trocar o padrão no meio do caminho não desviou a campanha

---

## 10. Campanha agendada cujo canal foi desativado

1. Agende uma campanha pelo 2º número.
2. **Antes** do disparo, desative o 2º número (lista de números → "Remover", com conversas — vira `disabled`, não apaga).
3. Force o cron:

   ```bash
   curl -s "$BASE_URL/api/broadcasts/cron" -H "x-cron-secret: $CRON_SECRET"
   ```

4. Confirme que a campanha falha com o motivo legível, **sem trocar de número sozinha**:

   ```sql
   select id, channel_id, status from broadcasts
    where account_id = '<id da conta>'
    order by created_at desc limit 1;
   -- Espera-se: status = 'failed', channel_id continua sendo o do 2º (desativado)
   -- — não foi reatribuída ao 1º.
   ```

   Se o log estruturado do cron estiver acessível, confirme o código `channel_unavailable` (não `whatsapp_not_configured` — são erros diferentes: o segundo pressupõe "conta sem número nenhum", que não é o caso aqui).

5. Reconecte o 2º número (item 22) antes de continuar para os próximos itens que dependem dele.

- [ ] Passou — falhou com `channel_unavailable`, não reatribuiu

---

## 11. Cooldown 30 dias no 1º, 0 no 2º

1. Configurações → WhatsApp → detalhe do 1º número → cooldown = 30 dias. Salve.
2. Detalhe do 2º número → cooldown = 0. Salve.
3. Envie uma campanha marketing pelo **1º** número para um contato que recebeu uma campanha marketing há 3 dias — a triagem deve **excluir** esse contato (dentro da janela de 30 dias).
4. Envie a mesma campanha, agora pelo **2º** número — o mesmo contato deve **aparecer normalmente** (cooldown 0 = sem restrição).

- [ ] Passou — a triagem do 2º não herdou o cooldown do 1º

---

## 12. Cota de 24h com envios nos dois números

**Por quê:** é o C.2 do inventário da SPEC — o bug mais caro de errar, porque nenhum teste automatizado pega (o número exibido continua "plausível" mesmo somando os dois canais).

1. Envie um volume de mensagens pelo **1º** número (o suficiente para o medidor de 24h mostrar um número > 0 — não precisa esgotar o tier).
2. Envie um volume **diferente** pelo **2º** número.
3. Abra a tela de disparo (ou `GET /api/whatsapp/messaging-limit?channel_id=<id>`) para cada canal separadamente e confirme que cada um mostra **o próprio consumo**, não a soma dos dois:

   ```bash
   curl -s "$BASE_URL/api/whatsapp/messaging-limit?channel_id=<id do 1º>" -H "Cookie: <sua sessão>"
   curl -s "$BASE_URL/api/whatsapp/messaging-limit?channel_id=<id do 2º>" -H "Cookie: <sua sessão>"
   ```

4. Confirme por SQL também, chamando a RPC diretamente com cada `p_channel_id`:

   ```sql
   select broadcast_quota_usage('<id da conta>'::uuid, 24, '<id do 1º canal>'::uuid) as uso_1;
   select broadcast_quota_usage('<id da conta>'::uuid, 24, '<id do 2º canal>'::uuid) as uso_2;
   ```

- [ ] Passou — os dois números mostram consumos diferentes e corretos, nenhum contaminado pelo outro

---

## 13. Templates: mesmo nome em dois WABAs

**Requer** os dois números em WABAs diferentes (preparação, item 0).

1. Crie (ou sincronize) um template com o **mesmo nome + idioma** nos dois WABAs — ex. `promo_mensal` em `pt_BR` nos dois.
2. Configurações → Templates → confirme que o seletor "Conta do WhatsApp Business" aparece (só aparece com >1 WABA distinto) e que **as duas linhas existem** na lista, sem uma sobrescrever a outra.
3. Selecione cada WABA no seletor e confirme que o template do **outro** WABA aparece esmaecido (com tooltip), nunca escondido silenciosamente.
4. Confirme por SQL que são duas linhas distintas:

   ```sql
   select id, waba_id, name, language, status from message_templates
    where account_id = '<id da conta>' and name = 'promo_mensal' and language = 'pt_BR';
   -- Espera-se: 2 linhas, uma por waba_id.
   ```

- [ ] Passou (ou "não testável nesta rodada" se só havia um WABA disponível)

---

## 14. Template legado sem `waba_id`

1. Se houver algum template com `waba_id IS NULL` na base de teste (linha anterior à migração 072), abra-o em Configurações → Templates.
2. Confirme que aparece com o selo "sem conta do WhatsApp Business — sincronize" (D-2), mas continua **visível e utilizável** — nunca escondido.
3. Envie uma campanha usando esse template sem escolher canal explícito — confirme que ele sai pelo canal Cloud **padrão** da conta (D-2: legado adota o WABA do padrão).
4. Depois de "Sincronizar da Meta", confirme por SQL que o `waba_id` foi preenchido:

   ```sql
   select id, name, waba_id from message_templates
    where account_id = '<id da conta>' and waba_id is null;
   -- Espera-se: nenhuma linha, ou só as que ainda não foram sincronizadas.
   ```

- [ ] Passou (ou "não aplicável" se a base de teste não tinha nenhum template legado)

---

## 15. Tier de mensagens

1. Abra o detalhe do 1º número — confirme o tier exibido (`TIER_250`/`TIER_1K`/etc.).
2. Abra o detalhe do 2º número — confirme que mostra o **próprio** tier, possivelmente diferente do 1º (números aquecem separadamente na Meta).
3. Alterne entre as abas várias vezes e confirme que o valor exibido **não muda** de um número para o outro por engano (o achado 2 da revisão de F2+F3 corrigiu exatamente essa classe: "escrever o tier de um número em todas as linhas da conta").

- [ ] Passou

---

## 16. Mídia recebida no 2º

1. Mande uma imagem/documento de um celular real para o **2º** número.
2. No inbox, abra a mídia recebida — confirme que ela carrega normalmente (o proxy de mídia resolve a credencial pelo `messages.channel_id` da mensagem dona, não pelo padrão da conta).
3. Confirme por SQL qual canal está gravado na mensagem:

   ```sql
   select id, channel_id, content_type from messages
    where conversation_id = '<id da conversa do 2º número>'
      and content_type in ('image','document','video','audio')
    order by created_at desc limit 1;
   -- Espera-se: channel_id = o id do 2º canal.
   ```

- [ ] Passou — mídia abriu com o token do 2º número

---

## 17. Plano com `channels_whatsapp_cloud: 1`

1. Confirme (ou ajuste temporariamente, só em conta de teste) que o plano da conta tem `channels_whatsapp_cloud: 1` e `quotas_enforced = TRUE`.
2. Tente "Conectar outro número" — o botão deve aparecer **desabilitado**, com a razão visível (via `title`/tooltip), usando `useAccountPlan()` para saber que a quota está no teto.
3. Confirme que a rota também recusa mesmo contornando o botão (chamando `POST /api/whatsapp/config` direto com um `phone_number_id` novo) — mensagem legível, não um erro genérico:

   ```bash
   curl -i -X POST "$BASE_URL/api/whatsapp/config" \
     -H "Cookie: <sua sessão>" -H "Content-Type: application/json" \
     -d '{"phone_number_id":"<id de um 3º número de teste>","access_token":"<token>"}'
   # Espera-se 403, code: "quota_exceeded", mensagem citando channels_whatsapp_cloud.
   ```

- [ ] Passou — recusado nos dois caminhos, com mensagem legível (F8)

---

## 18. Definir o 2º como padrão

1. Lista de números → "Definir como padrão" no 2º número.
2. Confirme que a troca é **atômica**: o 1º deixa de ser padrão exatamente quando o 2º passa a ser (nunca os dois, nunca nenhum).
3. Confirme por SQL:

   ```sql
   select id, name, type, is_default from channels
    where account_id = '<id da conta>' and type = 'whatsapp_cloud';
   -- Espera-se: só o 2º com is_default = true.
   ```

4. Se a conta também tiver uma instância QRCode (preparação), confirme que o padrão dela **continua marcado** — o item 25 abaixo aprofunda isso.

- [ ] Passou

---

## 19. Desativar o 2º (com conversas)

1. Confirme que o 2º número tem conversas (histórico de itens anteriores).
2. Lista de números → "Remover" no 2º número. Confirme o aviso.
3. Confirme por SQL que os segredos foram zerados, o canal virou `disabled`, e o **histórico continua intacto**:

   ```sql
   select c.status, wc.access_token, wc.verify_token, wc.broadcast_cooldown_days, wc.messaging_limit_tier
     from channels c join whatsapp_config wc on wc.channel_id = c.id
    where c.id = '<id do 2º canal>';
   -- Espera-se: status = 'disabled', access_token = '' (string vazia, não NULL),
   -- verify_token = NULL, cooldown e tier PRESERVADOS (não resetados).

   select count(*) from messages m join conversations c on c.id = m.conversation_id
    where c.channel_id = '<id do 2º canal>';
   -- Espera-se: a mesma contagem de antes — nada foi apagado.
   ```

4. Confirme que o número **some** da lista de números, do seletor "Enviar por" e do diálogo de transferência.
5. Confirme que a vaga de quota foi **liberada** (o botão "Conectar outro número" volta a ficar habilitado, se estava no teto):

   ```sql
   select count(*) from channels
    where account_id = '<id da conta>' and type = 'whatsapp_cloud' and status <> 'disabled';
   ```

- [ ] Passou

---

## 20. Definir cooldown 30 dias no 2º, desativar e reconectar

1. Antes de desativar (ou reconectando o item 19), defina cooldown = 30 no 2º número e confirme que ficou salvo.
2. Desative o 2º (item 19).
3. Reconecte o **mesmo** `phone_number_id` (Configurações → "Conectar outro número", mesmas credenciais).
4. Confirme por SQL que o cooldown **continua 30**, não voltou ao padrão 7:

   ```sql
   select broadcast_cooldown_days, messaging_limit_tier, messaging_limit_checked_at
     from whatsapp_config
    where channel_id = '<id do 2º canal, o mesmo de antes>';
   -- Espera-se: broadcast_cooldown_days = 30 (preservado), e messaging_limit_tier
   -- NÃO deve ter voltado a NULL/"nunca consultado" se já tinha sido lido antes.
   ```

- [ ] Passou — reconexão preservou configuração, não regrediu para os padrões

---

## 21. Contato manda mensagem para o número desativado

1. Com o 2º número ainda `disabled` (repita o item 19 se já reconectou no item 20 — ou use uma janela onde ele esteja desativado), mande uma mensagem de um celular real para ele.
2. Confirme que **nenhuma conversa nova** nasce e nenhuma mensagem é gravada:

   ```sql
   select count(*) from conversations where channel_id = '<id do 2º canal>' and created_at > now() - interval '5 minutes';
   -- Espera-se 0.
   ```

3. Confirme no log do servidor (webhook) que a mensagem foi **ignorada com log nomeando o canal** — não silenciosamente, e não com o genérico "No config found" de antes desta SPEC.

- [ ] Passou

---

## 22. Reconectar o mesmo número desativado

1. Com o 2º número `disabled`, reconecte usando o **mesmo** `phone_number_id`.
2. Confirme que ele **readota** o canal existente — não cria um terceiro:

   ```sql
   select count(*) from channels
    where account_id = '<id da conta>' and identifier = '<identifier/phone do 2º número>';
   -- Espera-se 1, não 2.
   ```

3. Confirme que o histórico de conversas do 2º número continua associado ao mesmo `channel_id` de antes.

- [ ] Passou

---

## 23. Remover canal sem conversas

1. Conecte um 3º número de teste (ou use um que nunca recebeu/enviou mensagem nenhuma).
2. Lista de números → "Remover".
3. Confirme que desta vez o canal é **apagado de verdade** (não `disabled`):

   ```sql
   select count(*) from channels where id = '<id do 3º canal>';
   -- Espera-se 0.
   ```

4. Confirme que o `phone_number_id` **volta a poder ser conectado** (em outra conta, ou na mesma):

   ```bash
   curl -i -X POST "$BASE_URL/api/whatsapp/config" \
     -H "Cookie: <sua sessão>" -H "Content-Type: application/json" \
     -d '{"phone_number_id":"<o mesmo do 3º número>","access_token":"<token>"}'
   # Espera-se sucesso, não 409 "already linked".
   ```

- [ ] Passou

---

## 24. "Reset Configuration" no 1º número

**Por quê:** é o caminho de recuperação de um token cifrado com `ENCRYPTION_KEY` trocada — não pode quebrar com múltiplos números na conta.

1. Detalhe do 1º número → "Reset Configuration". Confirme o aviso (histórico e cooldown preservados).
2. Confirme por SQL que o comportamento é idêntico ao D-12 (mesma operação de "remover com conversas"): segredo zerado, canal `disabled`, histórico intacto.
3. Reconecte com as mesmas credenciais do 1º número e confirme que ele volta a funcionar normalmente, inclusive como **padrão** (se era o padrão antes) — ou promova-o de volta via "Definir como padrão" se a promoção automática não se aplicar.

- [ ] Passou — "Reset Configuration" continua funcionando com dois números na conta

---

## 25. Definir o 2º oficial como padrão numa conta que também tem QRCode

**Requer** uma instância WhatsApp QRCode conectada na mesma conta (preparação, item 0).

1. Confirme o padrão atual do tipo `whatsapp_qr` (deve haver um, se existe pelo menos uma instância conectada):

   ```sql
   select id, name, is_default from channels
    where account_id = '<id da conta>' and type = 'whatsapp_qr';
   ```

2. Defina o 2º número oficial como padrão (item 18).
3. Confirme que o padrão do QRCode **continua marcado** — a RPC `set_default_channel` só desmarca canais do MESMO tipo (`AND type = v_type`, §6.1):

   ```sql
   select id, name, type, is_default from channels
    where account_id = '<id da conta>' and is_default = true
    order by type;
   -- Espera-se: 2 linhas, uma whatsapp_cloud (o 2º) e uma whatsapp_qr (inalterada).
   ```

- [ ] Passou — promover um número oficial não derrubou o padrão do QRCode

---

## 26. Transferir conversa do QRCode para o 2º oficial

**Requer** o mesmo setup do item 25.

1. Numa conversa aberta pelo canal QRCode, abra o diálogo de transferência entre canais (SPEC 056).
2. Confirme que a lista de destino mostra **os dois números oficiais** (1º e 2º), cada um com o **telefone legível** (D-9) — nunca um `phone_number_id` cru formatado como telefone.
3. Transfira para o 2º número oficial e confirme que a próxima resposta sai por ele.

- [ ] Passou

---

## 27. Conta com um único número (regressão)

**Por quê:** é a garantia de compatibilidade da SPEC inteira — quem nunca vai ter um segundo número não pode notar diferença nenhuma.

1. Em uma conta de teste **separada**, com um único número oficial conectado, abra Configurações → WhatsApp.
2. Confirme que a tela abre **direto no detalhe** do número — nenhuma lista de um item aparece onde antes havia um formulário (F7, §6.1).
3. Confirme que o botão "Conectar outro número" aparece no cabeçalho (mesmo com um número só) — é a entrada para conectar o segundo, mas nada mais muda perceptivelmente.
4. Abra Configurações → Templates — confirme que o seletor "Conta do WhatsApp Business" **não aparece** (só um WABA).
5. Envie uma campanha normalmente — confirme que o passo "Enviar por" **não aparece** no wizard (só um canal capaz de broadcast) e que a campanha sai pelo único número, com `broadcasts.channel_id` gravado mesmo assim.

- [ ] Passou — nenhuma tela mudou de forma perceptível para uma conta de número único

---

## Definição de pronto (SPEC 064 §12)

Depois dos 27 itens acima, confira:

- [ ] Item 3 confirmou por SQL **e** (se disponível) por log estruturado (F10) que a resposta saiu do canal certo — é a distinção entre "a tela pareceu certa" e "o número que realmente saiu está certo", que é o ponto central de risco da SPEC inteira (§11).
- [ ] Item 9 provou que D-3 se sustenta sob pressão real: trocar o padrão NO MEIO do caminho de um agendamento não desviou a campanha.
- [ ] Item 10 confirmou o código `channel_unavailable` — não `whatsapp_not_configured` nem um 500 genérico — quando o canal gravado foi desativado depois da criação.
- [ ] Item 12 confirmou que a cota de 24h é por número, não por conta — é o C.2 do inventário, o bug mais caro de deixar passar porque "o número parece plausível" mesmo errado.
- [ ] Item 19 provou D-12 de ponta a ponta: desativar preserva `whatsapp_config` inteira (cooldown, tier, `waba_id`), zera só o segredo.
- [ ] Item 25 confirmou que `set_default_channel` respeita `AND type = v_type` — sem isso, o `fallback_channel` das automações (SPEC 049 §5.1) quebraria em silêncio para toda conta com QRCode + oficial.
- [ ] Item 27 confirmou compatibilidade total para o caso mais comum (conta com um número só) — se qualquer coisa mudou perceptivelmente aqui, é regressão, não feature.
- [ ] Todo estado de teste criado nesta sessão foi revertido ou está claramente marcado como teste: números de teste desconectados/removidos, cooldowns voltados ao valor original, `channels_whatsapp_cloud` do plano de teste restaurado (item 17), qualquer campanha/template de teste identificável como tal.
- [ ] `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — verde, na ordem (já validado nas sessões de F1–F10; rode de novo se algo mudou desde então).

Marcando os 27 itens + esta seção, a SPEC 064 está com todo o roteiro de F11 fechado — e a implementação completa (F1–F11).
