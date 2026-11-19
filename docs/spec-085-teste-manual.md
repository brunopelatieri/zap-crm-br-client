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

1. [ ] **Ler o estado atual** da conta escolhida:

   ```sql
   select a.id, a.name, a.blocked_at, p.name plano, ap.limit_overrides,
          plan_feature_strict(a.id, 'forms_enabled') forms_on
     from accounts a
     join account_plans ap on ap.account_id = a.id
     join plans p on p.id = ap.plan_id
    where a.id = :'ACC';
   ```

2. [ ] **Ligar (DML — pedir confirmação).** Preferência: console `/admin` → conta → plano → overrides (fica no histórico `overrides_after` com ator e motivo). Equivalente em SQL, se o console não aceitar alguma chave:

   ```sql
   -- (DML) só a conta-piloto; preserva os overrides que já existem
   update account_plans
      set limit_overrides = limit_overrides
            || '{"forms_enabled": true, "forms": 3, "form_responses_month": 200, "form_upload_mb": 100}'::jsonb,
          note = coalesce(note || ' | ', '') || 'piloto SPEC 085 F6 (2026-11-19)'
    where account_id = :'ACC';
   ```

3. [ ] **Conferir que só ela passou:**

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

**Critério para sair do piloto** (decisão do mantenedor): todos os itens do §2 marcados, nenhum achado novo HIGH/MEDIUM, e decisão tomada sobre os riscos aceitos **M-2** e **M-3** do Status da SPEC (contato criado no `start` sem prova de posse; modo telefone agindo sobre contato conhecido). Só então pôr as três quotas nos `plans.limits` e `forms_enabled` nos planos pagos.

---

## 2. Cenários

Cada item: **Passos** → **Esperado** → **Conferir**. Anote o resultado ao lado do checkbox (`✓`, `✗` + o que viu, ou `parcial`).

### 1. Modelo "Captação de lead": criar, publicar e concluir no celular

- [ ] **Passos:** como `admin`, `/forms` → **Novo** → modelo "Captação de lead". No construtor: ligar **Turnstile** em Configurações; na aba Classificação, faixa "Quente" com uma etiqueta e um negócio (funil/etapa da conta) e "Notificar" você. Mapear nome → `contact.name` e o bloco de consentimento → `contact.opt_in`. **Publicar.** Abrir `/f/<slug>` no **celular** (rede móvel, não o Wi-Fi do escritório), responder com um telefone seu que **não** é contato.
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

- [ ] **Passos:** com `allow_multiple_responses` **desligado**, abrir o link e informar o mesmo telefone. Depois ligar `allow_multiple_responses`, responder de novo mudando o nome.
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

- [ ] **Passos:** formulário com bloco "Arquivo" (aceitar PDF). Enviar um PDF de ~1 MB. Depois tentar um `.exe` renomeado para `.pdf` e um arquivo de 20 MB.
- **Esperado:** PDF aparece na resposta (tabela, painel lateral, aba da ficha e cartão do inbox) e baixa como **anexo** (`Content-Disposition: attachment`), nunca abre inline. Arquivo de 20 MB recusado **antes** da URL assinada (`413 file_too_large`).
- **Sobre o `.exe` renomeado:** a allowlist confere o **MIME declarado** e a **extensão**; o conteúdo não é inspecionado. Um `.exe` renomeado com `type = application/pdf` passa da rota e é gravado (achado **L-3**, aceito: bucket privado, download só como anexo, `X-Content-Type-Options: nosniff`). Registre o que o navegador declarou (`type` do `File`) e se o upload passou.
- **Conferir:**

  ```sql
  select name, metadata->>'mimetype' mimetype, (metadata->>'size')::bigint size, created_at
    from storage.objects
   where bucket_id = 'form-uploads' and name like 'account-' || :'ACC' || '/%'
   order by created_at desc limit 5;
  ```

### 6. Página neutra idêntica nos quatro casos

- [ ] **Passos:** guardar o HTML de `/f/<slug>` de um slug **inexistente** (`curl -s "$BASE_URL/f/nao-existe-123" > neutra.html`). Para cada caso abaixo, salvar o HTML e comparar o corpo visível e o status:
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

- [ ] MCP `get_advisors` (security): **16 INFO e 27 WARN** (o 27º é `form_responses_delete`, esperado — §5.4 da SPEC). Qualquer número diferente: comparar com a lista da F5 antes de seguir.
- [ ] Só leitura:

  ```sql
  select has_table_privilege('anon','public.forms','SELECT'),
         has_table_privilege('anon','public.form_fields','SELECT'),
         has_table_privilege('anon','public.form_responses','SELECT'),
         has_table_privilege('authenticated','public.form_responses','INSERT');
  -- Esperado: false, false, false, false
  ```

### 11. Storage real: PUT na `signed_url`, `x-upsert` e `mimetype` (pendência da F5, desvio **as**)

- [ ] **PUT do navegador:** no item 5, DevTools → Network: `POST …/upload-url` devolve `signed_url`; em seguida um `PUT` para essa URL com `content-type: application/pdf` responde **200**. O objeto aparece na consulta do item 5 com `mimetype = application/pdf` e `size` igual ao do arquivo.
- [ ] **`x-upsert` não sobrescreve:** copiar do DevTools a `signed_url` de um upload **já feito** e repetir com outro arquivo:

  ```bash
  curl -i -X PUT "<signed_url>" -H "content-type: application/pdf" -H "x-upsert: true" --data-binary @outro.pdf
  # Esperado: 4xx ("already exists"/Duplicate); o objeto original fica (mesmo size na consulta)
  ```

  Se o Storage **aceitar** (2xx e `size` mudou), é achado: o objeto conferido no envio pode ser trocado depois. Registrar no Status e não sair do piloto sem correção.

- [ ] **`mimetype` declarado × gravado:** obter `signed_url` **ainda não usadas** pedindo a URL direto à rota com o `response_id` e o `resume_token` de uma resposta parcial (DevTools → Network → corpo do `POST …/start`):

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

---

## 3. Encerramento

- [ ] Todos os itens do §2 marcados, com resultado anotado.
- [ ] Achados novos registrados no Status da SPEC 085 (F6) com severidade.
- [ ] Contatos, respostas e formulários de teste apagados (pela UI: apagar respostas → excluir formulário fora do ar → excluir contatos).
- [ ] Decisão do mantenedor: manter o piloto, ampliar (quotas nos `plans.limits` + `forms_enabled` nos planos pagos) ou desligar (rollback do §1).
