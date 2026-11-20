# SPEC 085 — Teste manual e piloto (F6)

Checklist executável do [§12.3 da SPEC 085](./spec-085-formularios-nucleo.md#123-roteiro-manual-resumo-o-detalhado-nasce-na-f6-como-spec-085-teste-manualmd), no formato do [`spec-078-teste-manual.md`](./spec-078-teste-manual.md), mais o procedimento do **piloto por `limit_overrides`** (§11, linha F6) e as conferências de Storage que a F5 deixou pendentes (desvio **as** do Status). Não é documento de decisão: é o §12.3 desdobrado em passos, com SQL e `curl` prontos para colar.

> **Ainda não executado.** O código da SPEC 085 tem suíte automatizada verde (rotas, página, sessão do navegador, middleware, projeção pública) e as migrações 097/098 estão no `vn` desde 2026-11-19, mas **nenhum formulário real foi criado, publicado ou respondido**: `forms_enabled` está `false` nos 6 planos e nenhuma conta tem a chave ligada. **Marque cada item ao rodar de verdade; não preencha resultado sem ter rodado.**
>
> O que o teste automatizado já prova e este roteiro NÃO repete: projeção pública fechada (contrato), pontuação só no servidor, `resume_token`, `Origin` e limite por IP com dublês, validação de upload antes de assinar, Turnstile fail-closed, `neutralizeFormula`, guarda de papel e de plano nas rotas da conta. O que só aqui se prova: o **efeito de ponta a ponta** contra o `vn` real — Storage (PUT direto, `x-upsert`, `mimetype`), RLS, triggers de quota, cron, cabeçalhos de frame no navegador e a tela no celular.

**Regras deste roteiro**

- O `vn` é **produção e não tem backup**. Todo `SELECT` daqui é livre; todo `UPDATE`/`INSERT`/`DELETE` está marcado **(DML)** e só roda com "pode rodar" explícito do mantenedor.
- Antes de qualquer SQL: MCP `get_project_url` → `https://awylbfsywsrnkztvovud.supabase.co` (o `vn`). Nunca outro projeto.
- Use só a **conta-piloto** (§1) e contatos de teste com telefones seus. Nada contra contato real de cliente.

---

## 0. Preparação

- [ ] **Código da F6 no ar.** O deploy de produção (`zap.local.ia.br`) tem o commit da F6 (mídia assinada só da própria conta e teto `formUploadAccount`). Sem ele, os itens 12 e 13 não valem.
- [ ] **Variáveis na stack do Portainer** (só presença; nunca cole valor aqui):
  - `FORM_LINK_SECRET` com **≥ 32 bytes** (ex.: `openssl rand -base64 48`). Sem ela o link com token não existe (item 4 testa a ausência só no ambiente local).
  - `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` (as duas; com uma só o interruptor fica desligado).
  - `NEXT_PUBLIC_SITE_URL` = origem pública do app (a regra de `Origin` das rotas públicas aceita essa origem ou o host da requisição).
  - `AUTOMATION_CRON_SECRET` e o pinger de `/api/automations/cron` ativo no cron-job.org (fase 7 = varredura dos formulários).
- [ ] **Configurações → Formulários** (como `admin` da conta-piloto, depois do §1): "Segredo do link" e "Turnstile" aparecem como **configurados** (a tela mostra só presença).
- [ ] **Variáveis de shell** para os `curl`:

  ```bash
  export BASE_URL="https://zap.local.ia.br"     # ou http://localhost:3000 no item 4
  export SLUG="<slug do formulário de teste>"
  export ACC="<id da conta-piloto>"
  ```

- [ ] **Consulta-base** (colar depois de cada item). `:'ACC'` e `:'SLUG'` são variáveis do `psql`; no SQL Editor do Supabase troque pelo valor entre aspas simples:

  ```sql
  select f.slug, f.status, f.version,
         (select count(*) from form_responses r where r.form_id = f.id and r.status = 'completed') concluidas,
         (select count(*) from form_responses r where r.form_id = f.id and r.status = 'partial')   parciais,
         (select count(*) from form_responses r where r.form_id = f.id and r.status = 'abandoned') abandonadas
    from forms f where f.account_id = :'ACC' order by f.created_at desc;

  select metric, value from account_usage_counters
   where account_id = :'ACC' and (metric like 'form%' or metric = 'contacts') order by metric;

  select * from form_public_availability(:'SLUG');
  ```

---

## 1. Piloto por `limit_overrides` (ligar `forms_enabled` numa conta só)

> **Nada foi ligado na F6.** Esta seção descreve o procedimento; executar exige "pode ligar na conta X" explícito do mantenedor, com o id da conta.

**Fato medido em 2026-11-19 (só leitura no `vn`):** nenhum dos 6 planos tem as chaves `forms`, `form_responses_month` nem `form_upload_mb` em `plans.limits`, e **chave ausente = sem limite** (`plan_limit()` devolve `NULL`; `uploadQuotaHasRoom` trata `NULL` como ilimitado). Ligar só `forms_enabled` daria à conta-piloto formulários, respostas e **bytes de upload sem teto**. Por isso o piloto liga a chave **junto com as três quotas**.

**Critérios para escolher a conta:** conta interna do mantenedor (não de cliente pagante), com plano que não seja o Grátis (o teto de contatos do Grátis é 150 e o item 6 precisa de folga), `blocked_at` nulo, pelo menos dois membros (`admin` e `viewer`) para os itens de papel.

1. [x] **Ler o estado atual** da conta escolhida (✓ 2026-11-19: conta `941045d6-4d94-4184-b7a0-5f5ef41fee23`, plano Valen Ranch Personal, `limit_overrides` vazio, `forms_on = false`, 83 de 85 contatos):

   ```sql
   select a.id, a.name, a.blocked_at, p.name plano, ap.limit_overrides,
          plan_feature_strict(a.id, 'forms_enabled') forms_on
     from accounts a
     join account_plans ap on ap.account_id = a.id
     join plans p on p.id = ap.plan_id
    where a.id = :'ACC';
   ```

2. [x] **Ligar (DML — pedir confirmação)** (✓ 2026-11-19 por SQL, com "pode ligar" do mantenedor; `limit_overrides` = `forms_enabled: true, forms: 3, form_responses_month: 200, form_upload_mb: 100`). Preferência: console `/admin` → conta → plano → overrides (fica no histórico `overrides_after` com ator e motivo). Equivalente em SQL, se o console não aceitar alguma chave:

   ```sql
   -- (DML) só a conta-piloto; preserva os overrides que já existem
   update account_plans
      set limit_overrides = limit_overrides
            || '{"forms_enabled": true, "forms": 3, "form_responses_month": 200, "form_upload_mb": 100}'::jsonb,
          note = coalesce(note || ' | ', '') || 'piloto SPEC 085 F6 (2026-11-19)'
    where account_id = :'ACC';
   ```

3. [x] **Conferir que só ela passou** (✓ 2026-11-19: `forms_on = true` só na conta-piloto, com 3 / 200 / 100; as outras 4 contas `false` e sem limites):

   ```sql
   select a.name, plan_feature_strict(a.id, 'forms_enabled') forms_on,
          plan_limit(a.id, 'forms') forms, plan_limit(a.id, 'form_responses_month') resp_mes,
          plan_limit(a.id, 'form_upload_mb') upload_mb
     from accounts a order by forms_on desc, a.name;
   -- Esperado: forms_on = true SÓ na conta-piloto, com 3 / 200 / 100; as outras false
   ```

4. [ ] **Na tela:** como `admin` da conta-piloto, `/forms` lista sem o aviso de plano; como membro de **outra** conta, `/forms` mostra o aviso e `POST /api/forms` responde `403 FEATURE_NOT_IN_PLAN`.

**Desligar (rollback, DML — pedir confirmação).** Perder o item não apaga nada (PRD 084 critério 6): a página pública vira a neutra e as respostas continuam consultáveis no banco.

```sql
update account_plans
   set limit_overrides = limit_overrides - 'forms_enabled' - 'forms' - 'form_responses_month' - 'form_upload_mb'
 where account_id = :'ACC';
```

**Critério para sair do piloto** (decisão do mantenedor): todos os itens do §2 marcados, nenhum achado novo HIGH/MEDIUM, e os riscos **M-2** e **M-3** do Status da SPEC tratados: o formulário público do piloto usa a **confirmação do telefone pelo WhatsApp** (F7, cenário 14) — sem ela os dois riscos continuam valendo. Só então pôr as três quotas nos `plans.limits` e `forms_enabled` nos planos pagos.

---

## 2. Cenários

Cada item: **Passos** → **Esperado** → **Conferir**. Anote o resultado ao lado do checkbox (`✓`, `✗` + o que viu, ou `parcial`).

### 1. Modelo "Captação de lead": criar, publicar e concluir no celular

- [~] **Parcial (2026-11-20, `parcial`):** rodado pelo navegador do app em emulação de celular (375x812), na conta-piloto, formulário `TESTE SPEC 085 - captacao` (id `d5bf2b9b-a30d-4dcc-90e5-cf507c659a13`), com o telefone de teste do mantenedor, que **já era contato** (`created_via = inbound`), então o "contato criado pelo formulário" **não foi coberto**. ✓ no banco: resposta `completed`, `score = 100`, `band_key = hot`, `identity_mode = phone`, `source = link`, `resume_token_hash` descartado, `ip_hash` gravado; negócio criado em "Novo Lead" (título `<contato> — <formulário>`); notificação `form_response_received` para o admin; evento de consentimento `opted_in` com `source = 'form'`; `form_responses:2026-11` = 1, `contacts` continuou em 83 (nome do contato não mudou: mapeamento "preenche se vazio"). ✗ **Não cobertos:** Turnstile (`TURNSTILE_*` ausente no servidor; o widget exige humano), etiqueta da faixa (a conta não tem etiquetas), celular real em rede móvel e contato novo. Observação de UX: na pergunta 4 apareceu "Este campo é obrigatório" ao chegar, antes de responder. **Passos originais:** como `admin`, `/forms` → **Novo** → modelo "Captação de lead". No construtor: ligar **Turnstile** em Configurações; na aba Classificação, faixa "Quente" com uma etiqueta e um negócio (funil/etapa da conta) e "Notificar" você. Mapear nome → `contact.name` e o bloco de consentimento → `contact.opt_in`. **Publicar.** Abrir `/f/<slug>` no **celular** (rede móvel, não o Wi-Fi do escritório), responder com um telefone seu que **não** é contato.
- **Esperado:** um bloco por tela, Enter/OK avança, barra de progresso, widget do Turnstile antes de enviar, tela de agradecimento.
- **Conferir:**

  ```sql
  select id, name, phone, created_via from contacts where account_id = :'ACC' order by created_at desc limit 1;
  -- created_via = 'form', name preenchido pelo mapeamento
  select status, score, band_key, identity_mode, source, deal_id, upload_bytes,
         resume_token_hash is null token_descartado, ip_hash is not null tem_ip_hash
    from form_responses where account_id = :'ACC' order by started_at desc limit 1;
  -- completed, faixa esperada, token_descartado = true, deal_id preenchido se a faixa cria negócio
  ```

  Etiqueta da faixa no contato; negócio na etapa configurada; notificação "Nova resposta" no sino abrindo a resposta (`/forms/<id>/respostas?response=<id>`); evento de consentimento com `source = 'form'`; contador `form_responses:YYYY-MM` = 1.

### 2. Mesmo telefone de novo

- [x] **✓ 2026-11-20** (celular emulado, mesmo formulário e telefone do item 1): com `allow_multiple_responses` desligado, o mesmo telefone mostrou "Você já respondeu a este formulário. Obrigado!" e o banco ficou com **1** resposta (nenhuma linha nova). Com o interruptor ligado e salvo (versão 4, ainda publicado), a segunda resposta entrou no **mesmo** `contact_id` (`e59b5c01…`): 2 respostas `completed` (100/`hot` com negócio e 5/`cold` sem negócio), 1 contato para o número, total de contatos em 83 e nome do contato **inalterado** ("Bruno Pelatieri Goulart"; digitei "Nome Alterado Item2"). **Passos originais:** com `allow_multiple_responses` **desligado**, abrir o link e informar o mesmo telefone. Depois ligar `allow_multiple_responses`, responder de novo mudando o nome.
- **Esperado:** desligado → tela "já respondeu" e **nenhuma** linha nova. Ligado → segunda resposta no **mesmo** contato; o nome **não** muda (mapeamento "preenche se vazio" por padrão).
- **Conferir:** `select count(*) from contacts where account_id = :'ACC' and phone_normalized = '<seu número>'` = 1; duas respostas `completed` para o `contact_id`.

### 3. Link com token pula o telefone

- [ ] **Passos:** no formulário publicado, **Compartilhar** → link para um contato de teste (ou `POST /api/forms/<id>/link` com `{contact_id, source:'inbox'}` pela sessão). Abrir o link numa janela anônima.
- **Esperado:** o bloco Telefone **não** aparece (salvo `confirm_phone_with_token`); a página tem `noindex`.
- **Conferir:** resposta com `identity_mode = 'token'`, `source = 'inbox'` e o `contact_id` do contato do link. No DevTools, o JSON da página **não** traz `contact_id`.

### 4. Token adulterado e ausência de `FORM_LINK_SECRET`

- [ ] **Token adulterado:** trocar o último caractere de `?t=` → a página pede o telefone (nunca erro). Token de **outro** formulário no `?t=` deste → pede o telefone.
- [ ] **Sem segredo (ambiente local, `npm run dev`, sem `FORM_LINK_SECRET` no `.env.local`):** Compartilhar → "link pessoal indisponível" e `POST …/link` → `503 FORM_LINK_SECRET_MISSING`; o link genérico segue funcionando; Configurações → Formulários mostra o segredo como **ausente**.
  > Atenção: o `npm run dev` local também aponta para o `vn`; use a conta-piloto e apague o que criar.

### 5. Upload: PDF aceito, `.exe` disfarçado recusado

- [x] **✓ 2026-11-20 (parcial no que depende do navegador real).** Bloco "Envio de arquivo" (só PDF, opcional) adicionado ao formulário de teste (versão 5). O envio foi feito **por HTTP direto nas rotas públicas** (`start` → `upload-url` → `PUT` na `signed_url` → `submit`), o mesmo caminho do cliente, e não pelo seletor de arquivos do navegador. Resultados: PDF de ~1 MB aceito e resposta `completed` com `upload_bytes = 1048623` (= tamanho real; contador `form_upload_bytes` = 1048623); arquivo de 20 MB recusado **antes** de assinar com `413 file_too_large` (`max_bytes` = 16777216, ou seja, o teto é 16 MB); `.exe` de verdade com MIME de executável → `400 file_type_not_allowed`; `.exe` renomeado como `fake.pdf` com `type = application/pdf` → `upload-url` **200 e PUT 200** (**L-3 confirmado**, objeto gravado, nunca inspecionado). Painel da resposta mostra "ok.pdf — Baixar"; o link `/files/0` devolve 302 para URL assinada com `download=ok.pdf` e `token` (a leitura direta de `Content-Disposition` não é visível por `fetch` entre origens, então o cabeçalho final ficou **indireto**). Não conferidos: tabela de respostas, aba da ficha e cartão do inbox mostrando o arquivo. **Achado novo (LOW, ✓ resolvido em 2026-11-20 — a varredura passou a remover objeto sem referência em resposta `completed` com mais de 24 h; ver o Status da SPEC):** os dois objetos extras gravados na pasta da resposta (o `.exe` disfarçado e o de `image/png`) **não estão referenciados** em `answers`; como a resposta é `completed`, o `sweep.ts` nunca remove arquivo dela (linha 17), então objetos sem referência numa resposta concluída ficam para sempre e não contam na quota `form_upload_mb` (só o referenciado conta). O teto por conta (`formUploadAccount`, 600 URLs/h) limita o ritmo, mas não o acúmulo. **Passos originais:** formulário com bloco "Arquivo" (aceitar PDF). Enviar um PDF de ~1 MB. Depois tentar um `.exe` renomeado para `.pdf` e um arquivo de 20 MB.
- **Esperado:** PDF aparece na resposta (tabela, painel lateral, aba da ficha e cartão do inbox) e baixa como **anexo** (`Content-Disposition: attachment`), nunca abre inline. Arquivo de 20 MB recusado **antes** da URL assinada (`413 file_too_large`).
- **Sobre o `.exe` renomeado:** a allowlist confere o **MIME declarado** e a **extensão**; o conteúdo não é inspecionado. Um `.exe` renomeado com `type = application/pdf` passa da rota e é gravado (achado **L-3**, aceito: bucket privado, download só como anexo, `X-Content-Type-Options: nosniff`). Registre o que o navegador declarou (`type` do `File`) e se o upload passou.
- **Primeira semana em produção — dry-run (o `vn` não tem backup):** com `FORMS_SWEEP_PRUNE_DRY_RUN=1` na stack, depois de 24 h + uma varredura do cron os objetos extras NÃO somem: o log `[automations-cron] forms sweep dry-run would remove: <caminho>` lista cada caminho e o resultado traz `wouldRemoveUnreferenced > 0` e `removedUnreferenced = 0`. Confira os caminhos listados à mão (nenhum pode ser o PDF referenciado nem de resposta que não é a do teste) e rode o pré-check abaixo; só então tire a variável da stack.
- **Depois de 24 h + uma varredura do cron (sem dry-run):** os objetos extras (sem referência em `answers`) somem; o PDF referenciado fica; log `[automations-cron] forms sweep` com `removedUnreferenced > 0`. **Conferência pós-deploy no log:** `skippedNoDate > 0` e `removedUnreferenced` sempre 0 = o `list` do Storage não devolveu `created_at`/`updated_at` (a poda está inerte por segurança: reporte, não force); `truncatedLists > 0` = pasta ou lista com mais de 20.000 entradas (cobertura parcial); `errors > 0` = leia as linhas anteriores do log.
- **Pré-check só de leitura (conferir `get_project_url` = `vn`), antes do deploy ou do dry-run:** lista o que a poda removeria hoje (mesmo critério do código: padrão de caminho da própria pasta, `<objectId>` ausente do texto de `answers`, idade > 24 h). Todo item é candidato à remoção; se parecer legítimo, pare.

  ```sql
  select o.name, o.created_at, o.updated_at
    from storage.objects o
    join form_responses r on r.id::text = split_part(o.name, '/', 3)
   where o.bucket_id = 'form-uploads'
     and r.status = 'completed'
     and o.name ~ '^account-[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z0-9]{1,8}$'
     and split_part(o.name, '/', 1) = 'account-' || r.account_id::text
     and split_part(o.name, '/', 2) = r.form_id::text
     and greatest(o.created_at, o.updated_at) < now() - interval '24 hours'
     and position(lower(split_part(split_part(o.name, '/', 4), '.', 1)) in lower(r.answers::text)) = 0;
  ```

- **Conferir:**

  ```sql
  select name, metadata->>'mimetype' mimetype, (metadata->>'size')::bigint size, created_at
    from storage.objects
   where bucket_id = 'form-uploads' and name like 'account-' || :'ACC' || '/%'
   order by created_at desc limit 5;
  ```

### 6. Página neutra idêntica nos quatro casos

- [x] **✓ 2026-11-20, os 4 casos passaram.** **Caso 3 (conta desligada, rollback do §1):** 200, mesmo hash, API `404 unavailable`; `form_public_availability` = `feature_not_in_plan`; conta religada com 3 / 200 / 100. **Caso 4 (`form_responses_month = 0`):** 200, mesmo hash, API `404 unavailable`; `responses_quota`; valor voltou a 200. DML com "pode rodar" do mantenedor; estado final conferido (`forms_on` só na conta-piloto, 3 / 200 / 100, formulário de teste publicado e disponível). Detalhes dos casos 1 e 2 abaixo. Método: texto visível da página (sem `script`/`style`/`title`/`meta`) comparado por hash com o de um slug inexistente (`nao-existe-123`) e `POST /api/forms/public/<slug>/start` com `elapsed_ms` alto, só nos estados indisponíveis. Linha de base: HTTP 200, hash `b34bb389…`, texto "Este formulário não está disponível…", API `404 {"code":"unavailable"}`. **Caso 1 (despublicado):** 200, mesmo hash, API `404 unavailable`; `form_public_availability` = `not_published`. **Caso 2 (republicado e arquivado):** 200, mesmo hash, API `404 unavailable`; `form_public_availability` = `not_published`. O HTML bruto difere em 18 bytes do da linha de base (o slug aparece no payload da página), sem efeito no que o visitante vê. Observação: "Arquivar" no construtor usa `window.confirm`, que o painel descarta sem mostrar; precisei responder `true` por script. **Passos originais:** guardar o HTML de `/f/<slug>` de um slug **inexistente** (`curl -s "$BASE_URL/f/nao-existe-123" > neutra.html`). Para cada caso abaixo, salvar o HTML e comparar o corpo visível e o status:
  1. Despublicar o formulário.
  2. Republicar e **arquivar**.
  3. Restaurar/publicar e **desligar a conta** (rollback do §1) — religar depois.
  4. Override `form_responses_month = 0` (DML) — voltar para 200 depois.
- **Esperado:** HTTP **200** nos quatro, o mesmo texto "indisponível", nenhum indício do motivo. As rotas públicas respondem o mesmo `404 {"code":"unavailable"}`.
- **Conferir:** `form_public_availability(:'SLUG')` mostra o motivo no banco (`not_published`, `feature_not_in_plan`, `responses_quota`…); a página não.

### 7. Embed: origem cadastrada abre, sem origem o navegador bloqueia

- [ ] **Passos:** em Compartilhar → Embed, cadastrar `https://example.com` e salvar. Esperar 30 s (cache do middleware). Abrir `https://example.com`, DevTools → Console:

  ```js
  document.body.innerHTML =
    '<iframe src="https://zap.local.ia.br/f/<slug>" style="width:100%;height:700px;border:0"></iframe>';
  ```

- **Esperado:** o formulário abre no iframe e se redimensiona. Remover a origem, esperar 30 s, repetir: o navegador **recusa** (console: `frame-ancestors`).
- **Conferir:**

  ```bash
  curl -sI "$BASE_URL/f/$SLUG" | grep -iE 'x-frame-options|content-security-policy'
  # com origem: content-security-policy: frame-ancestors https://example.com (sem X-Frame-Options)
  # sem origem: x-frame-options: DENY + frame-ancestors 'none'
  ```

### 8. Exportar e apagar respostas

- [ ] **Exportar** (como `admin`) CSV e XLSX. Responder antes um formulário com nome `=HYPERLINK("http://x","clique")` num campo de texto.
- **Esperado:** a célula sai com apóstrofo (`'=HYPERLINK…`) e o Excel/Sheets **não** executa; como `agent`/`viewer` o botão não aparece e `POST …/responses/export` → 403.
- **Conferir:** `select source, format, scope, row_count, filter->>'form_id' from contact_exports where account_id = :'ACC' order by created_at desc limit 2;` → `source = 'form_responses'`.
- [ ] **Apagar** uma resposta com arquivo: o diálogo exige o nome do formulário digitado; errado → recusado. Depois de apagar: os objetos da pasta da resposta somem de `storage.objects` (consulta do item 5) e `form_upload_bytes` cai pelo tamanho do arquivo. Feed de atividade mostra `form.responses_deleted`.

### 9. Excluir o contato leva as respostas; a varredura recolhe os arquivos

- [ ] **Passos:** responder com arquivo usando um contato de teste; excluir o contato pela ficha.
- **Esperado:** respostas do contato somem (`ON DELETE CASCADE`). Os objetos ficam órfãos no bucket até a fase 7 do cron (varredura de Storage no máximo 1×/h por processo, 10 contas por vez).
- **Conferir:** em até ~1 h (ou mais, se houver muitas contas), a consulta do item 5 não lista mais a pasta da resposta; log `[automations-cron] forms sweep` com `removedObjects > 0`.
- [ ] **Parcial vira abandonada:** deixar uma resposta no meio (só o telefone). Em **24 h** (o gatilho `update_updated_at_column` regrava `updated_at` em todo `UPDATE`, então não dá para "envelhecer" a linha por SQL), conferir `status = 'abandoned'` e que **nada** disparou (sem etiqueta, negócio ou notificação).

### 10. Banco: advisors e privilégios

- [x] MCP `get_advisors` (security): **16 INFO e 27 WARN** (o 27º é `form_responses_delete`, esperado — §5.4 da SPEC). Qualquer número diferente: comparar com a lista da F5 antes de seguir. ✓ 2026-11-20 (depois da migração 100): **17 INFO** (16 + `form_phone_proofs`, RLS sem policy por desenho) e **26 WARN** somados (1 `function_search_path_mutable`, 2 `extension_in_public`, 1 `anon_security_definer_function_executable`, 21 `authenticated_security_definer_function_executable` — o item de `form_responses_delete` entra nos 21, igual ao `status.md` — e 1 `auth_leaked_password_protection`). Nada novo além do esperado; o "27" original era contagem errada.
- [x] Só leitura (✓ 2026-11-20: as 4 colunas `false`; `form_phone_proofs` sem `SELECT` para `anon` nem `authenticated`, com RLS ligada):

  ```sql
  select has_table_privilege('anon','public.forms','SELECT'),
         has_table_privilege('anon','public.form_fields','SELECT'),
         has_table_privilege('anon','public.form_responses','SELECT'),
         has_table_privilege('authenticated','public.form_responses','INSERT');
  -- Esperado: false, false, false, false
  ```

### 11. Storage real: PUT na `signed_url`, `x-upsert` e `mimetype` (pendência da F5, desvio **as**)

- [x] **PUT (✓ 2026-11-20, por HTTP e não pelo navegador):** `PUT` na `signed_url` com `content-type: application/pdf` → **200**; objeto com `mimetype = application/pdf` e `size = 1048623`, igual ao arquivo. **Passos originais:** no item 5, DevTools → Network: `POST …/upload-url` devolve `signed_url`; em seguida um `PUT` para essa URL com `content-type: application/pdf` responde **200**. O objeto aparece na consulta do item 5 com `mimetype = application/pdf` e `size` igual ao do arquivo.
- [x] **`x-upsert` não sobrescreve (✓ 2026-11-20):** repetir o `PUT` na mesma `signed_url` com `x-upsert: true` e outro arquivo → **400 `409 Duplicate` / `KeyAlreadyExists`**; o objeto original ficou com o mesmo tamanho (1048623). **Passos originais:** copiar do DevTools a `signed_url` de um upload **já feito** e repetir com outro arquivo:

  ```bash
  curl -i -X PUT "<signed_url>" -H "content-type: application/pdf" -H "x-upsert: true" --data-binary @outro.pdf
  # Esperado: 4xx ("already exists"/Duplicate); o objeto original fica (mesmo size na consulta)
  ```

  Se o Storage **aceitar** (2xx e `size` mudou), é achado: o objeto conferido no envio pode ser trocado depois. Registrar no Status e não sair do piloto sem correção.

- [x] **`mimetype` declarado × gravado (✓ 2026-11-20):** `PUT` com `text/html` → **415 `invalid_mime_type`** (fora da allowlist do bucket). `PUT` com `image/png` numa URL pedida como `application/pdf` → **200 e `mimetype = image/png` gravado** num objeto cujo nome e resposta dizem PDF (`size = 204832`): é o risco **baixo** esperado (o envio só confere existência e tamanho; download só como anexo). Registrar no Status da SPEC. **Passos originais:** obter `signed_url` **ainda não usadas** pedindo a URL direto à rota com o `response_id` e o `resume_token` de uma resposta parcial (DevTools → Network → corpo do `POST …/start`):

  ```bash
  curl -s -X POST "$BASE_URL/api/forms/public/$SLUG/upload-url" \
    -H "origin: $BASE_URL" -H "content-type: application/json" \
    -d '{"response_id":"<id>","resume_token":"<token>","field_key":"<bloco de arquivo>","name":"a.pdf","mime":"application/pdf","size":<bytes exatos do arquivo que vai subir>}'
  ```

  e fazer o PUT com outro tipo:

  ```bash
  curl -i -X PUT "<signed_url nova>" -H "content-type: text/html" --data-binary @pagina.html
  # Esperado: 4xx (text/html fora do allowed_mime_types do bucket)
  curl -i -X PUT "<outra signed_url nova>" -H "content-type: image/png" --data-binary @foto.png
  # Registrar: aceito? mimetype gravado = image/png enquanto a resposta diz PDF?
  ```

  O envio confere só existência e tamanho (`verifyUploadedObject`); um `mimetype` diferente do declarado, dentro da allowlist do bucket, é risco **baixo** (download só como anexo). Registrar o resultado no Status.

- [ ] **Validade da URL de upload:** a `signed_url` de upload do Supabase vale **2 h** (fixo da plataforma, não configurável); a de **leitura** (download da resposta) vale **10 min**. Conferir: o link de download (item 5) devolve 400/expirado 10 min depois.

### 12. Mídia de outra conta não é assinada (correção F6, L-1)

- [ ] **Contexto:** a RLS deixa o `admin` gravar `forms.theme` direto pelo PostgREST (sem passar pela validação das rotas), e a página pública assina mídia com `service_role`. A F6 passou a assinar só caminhos `account-<conta do formulário>/…`.
- [ ] **Passos (DML — pedir confirmação, só no formulário de teste):** simular a escrita direta pelo SQL Editor, guardando o `theme` antes:

  ```sql
  select theme from forms where slug = :'SLUG';   -- guardar para reverter
  update forms
     set theme = theme || '{"logo_path":"account-00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000.png"}'::jsonb
   where slug = :'SLUG';
  ```

- **Esperado:** `/f/<slug>` abre **sem** logo e o HTML não traz URL assinada desse caminho. Reverter o `theme` com o valor guardado.

### 13. Teto de URLs de upload por conta (correção F6, M-1)

- [ ] Só leitura de comportamento: não é prático gerar 600 uploads à mão. Conferir no log do servidor que nenhum `rate_limited` aparece no uso normal do piloto; o teste automatizado (`routes.test.ts`, "teto por conta") prova o 601º → 429.

### 14. F7 — confirmação do telefone pelo WhatsApp (fecha M-2 e M-3)

> **Pré-requisitos:** a migração `100_form_phone_proofs.sql` (aplicada no `vn` em 2026-11-19; conferir `to_regclass('public.form_phone_proofs')` e `has_table_privilege('anon'|'authenticated', 'public.form_phone_proofs', 'SELECT')` = `false`) e a conta-piloto com um **canal WhatsApp conectado** (Cloud ou QRCode). Use um segundo telefone seu, que **não** seja contato, para ser o visitante.

- [ ] **Ligar:** no construtor → Configurações → **Confirmar o telefone pelo WhatsApp** (aparece só com o link genérico aceito) → salvar. Abrir `/f/<slug>` no celular, informar o telefone do visitante.
- **Esperado:** depois do telefone aparece a tela "Confirme seu telefone" com um código `XXXX-XXXX` e o botão **Abrir o WhatsApp e enviar**. **Nenhuma** linha nova em `contacts` e nenhuma em `form_responses` ainda.
- **Conferir (antes de enviar a mensagem):**

  ```sql
  select count(*) from contacts where account_id = :'ACC' and phone_normalized = '<telefone do visitante>';  -- 0
  select count(*) from form_responses where account_id = :'ACC' and started_at > now() - interval '10 minutes';  -- 0 (do visitante)
  select status, expires_at, left(code,2) || '******' code from form_phone_proofs where account_id = :'ACC' order by created_at desc limit 1;  -- pending, ~10 min
  ```

- [ ] **Enviar do telefone certo:** tocar no botão, enviar a mensagem pré-escrita **sem editar**. **Esperado:** em poucos segundos (polling de 3 s) a página avança sozinha para a pergunta seguinte; no inbox a mensagem do código aparece na conversa (contato criado pelo recebimento normal) e **nenhuma** automação/flow/IA respondeu a ela.
- **Conferir:** a prova virou `consumed`; a resposta `partial` tem o `contact_id` do contato do telefone; `select status from form_phone_proofs …` → `consumed`.
- [ ] **Código de outro telefone (M-3):** num novo ciclo, informar o telefone **A** (de um contato existente, que não é o seu) e enviar o código do WhatsApp do telefone **B**. **Esperado:** a página fica em "Aguardando…"; a prova segue `pending`; nada muda no contato de A; ao vencer (10 min) oferece "Gerar um novo código".
- [ ] **Uso único e vencimento:** depois de concluir um ciclo, repetir o `start` com o mesmo `proof_id` (DevTools → reenviar o `POST …/start`) → `400 phone_proof_required`. Deixar uma prova `pending` vencer e mandar o código depois: a página não avança e a prova não vira `confirmed`.
- [ ] **Limites:** pedir "Gerar um novo código" duas vezes em menos de 30 s → mensagem de espera (429, `Retry-After`); 6 pedidos para o mesmo telefone na hora → recusado.
- [ ] **Sem canal conectado:** com o formulário no modo confirmação, desconectar/desabilitar o canal da conta-piloto (reconectar depois). **Esperado:** `/f/<slug>` mostra a **mesma página neutra** (HTTP 200) e `POST …/phone-proof` → `409 proof_unavailable`; nada é criado.
- [ ] **Link pessoal não muda:** com a confirmação ligada, o link com token (item 3) continua pulando o telefone e abre direto.
- [ ] **Desligar:** voltar a chave para desligada: o link genérico volta ao modo antigo (telefone digitado cria o contato, item 1). Registre que **este** modo mantém M-2/M-3.
- [ ] **Limpeza:** a varredura (cron, fase 7) apaga as provas vencidas há mais de 1 dia; conferir `select count(*) from form_phone_proofs where expires_at < now() - interval '1 day'` = 0 depois de um tick.

---

## 3. Encerramento

- [ ] Todos os itens do §2 marcados, com resultado anotado.
- [ ] Achados novos registrados no Status da SPEC 085 (F6) com severidade.
- [ ] Contatos, respostas e formulários de teste apagados (pela UI: apagar respostas → excluir formulário fora do ar → excluir contatos).
- [ ] Decisão do mantenedor: manter o piloto, ampliar (quotas nos `plans.limits` + `forms_enabled` nos planos pagos) ou desligar (rollback do §1).
