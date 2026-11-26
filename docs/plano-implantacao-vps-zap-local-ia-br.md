# Plano de implantação — ZAP CRM BR na VPS (`zap.local.ia.br`) e entrada do `rs`

**Data:** 2026-10-02.
**Arquivos entregues com este plano:** [`Dockerfile`](../Dockerfile) · [`.dockerignore`](../.dockerignore) · [`docs/deploy/stack-zapcrm.yml`](./deploy/stack-zapcrm.yml) (pasta com barreira própria no git — não sobe para o GitHub)

## Objetivo

1. O app do `vn` sai da hospedagem compartilhada da Hostinger e passa a rodar numa **VPS própria** (Docker Swarm + Portainer + Traefik, rede `bru`), em **`zap.local.ia.br`**.
2. Depois, o `rs` é **consolidado no Supabase `vn`** e o cliente `rs` passa a usar o mesmo `zap.local.ia.br`.
3. Resultado: um app, um Supabase (`vn`), dois clientes.

**O banco continua no supabase.com.** A VPS roda só o app e o agendador — a stack não tem Postgres.

---

## Respostas ratificadas (2026-10-06)

| Pergunta | Resposta do Bruno | Efeito no plano |
| -------- | ----------------- | --------------- |
| Quem chama os crons hoje | O serviço externo **cron-job.org** (escrito "cronjob.orb" na resposta) | Os jobs apontam para as URLs da Hostinger. Na F3 eles são **desligados** (e os do `rs` **apagados**: depois da consolidação o `rs` não tem app próprio) e o agendador passa a ser o `zapcrm_cron` da stack. Alternativa mais barata: manter cron-job.org e só trocar a URL — nesse caso apague o serviço `zapcrm_cron`. **Um só dos dois.** |
| Região | Supabase `vn` em **us-east-2 (Ohio)**; VPS Contabo em **US-east**; Evolution Go na mesma VPS | A latência app↔banco cai de ~120 ms (Hostinger/Brasil → Ohio) para dezenas de ms. O navegador do usuário continua falando direto com o Supabase (Ohio), então a tela não fica mais rápida na mesma proporção — as rotas de servidor, webhooks e crons ficam. |
| Onde roda tudo hoje | `vn` e `rs` na Hostinger (Brasil) | Os **dois** deploys antigos precisam de DNS, webhook Meta e webhook Evolution repontados. |
| **D-3** (e-mail dono nos dois bancos) | No `rs` o dono passa a ser `dono-rs@exemplo.com`; no `vn` continua `dono@exemplo.com` | Resolve o bloqueio: depois da troca são dois usuários distintos, sem colisão com a associação única. Conferido por leitura: o e-mail hotmail **não existe** em nenhum dos dois bancos e `auth.identities` do `rs` tem só o provedor `email`. **A troca ainda não foi feita** — ver F5. |

### Respostas da 2ª rodada (2026-10-06) e o que a leitura dos bancos mostrou

| Tema | Resposta do Bruno | Conferido no banco (só leitura) | Efeito |
| ---- | ----------------- | ------------------------------- | ------ |
| **D-5** `ENCRYPTION_KEY` | **Diferentes** entre `vn` e `rs` | No `rs` há poucos valores cifrados em formato GCM: `whatsapp_config.access_token` (2), `verify_token` (1), `app_secret` (1) e o token da instância QRCode (1, do canal 1175, que será removido). `ai_configs`, `api_keys` e `webhook_endpoints` não têm valor cifrado. | A cópia **decifra com a chave do `rs` e cifra com a do `vn`**. Ver a lista na F6. A VPS usa a `ENCRYPTION_KEY` **do `vn`**; a do `rs` só é necessária durante a cópia e depois pode ser descartada. |
| Meta App Secret | Cada um tem o seu app; "acredito que já esteja gravado no banco" | **Só em parte.** `vn`: os 2 números têm `app_secret` gravado. `rs`: só o **"WhatsApp Oficial 3"** (<NUMERO_OFICIAL_3>) tem; o **"WhatsApp Oficial"** (<NUMERO_OFICIAL_1>, conectado) **não tem** — hoje ele só valida pelo `META_APP_SECRET` global do deploy do `rs`; o "Oficial 2" está desativado. | Antes do corte, gravar o App Secret do `rs` no canal <NUMERO_OFICIAL_1> (pelo próprio app: Configurações → WhatsApp). Sem isso, na VPS o webhook desse número é rejeitado (assinatura inválida), porque o global da VPS será o do `vn`. Com os dois gravados por canal, o `META_APP_SECRET` global vira só reserva. |
| Evolution Go | `rs` e `vn` usam o mesmo servidor; **nenhum tem instância real**; o canal "1175" do `rs` é falso | `rs`: canal `whatsapp_qr` "1175" (<NUMERO_QRCODE_1175>), `disconnected`, padrão do QRCode, instância `zapcrm_93220045_1175_27fc`. `vn`: 2 canais QRCode, ambos `disabled` ("Instância excluída pelo operador"). O prefixo `zapcrm` bate com o nome. | O prefixo `EVOLUTION_INSTANCE_PREFIX=zapcrm` está certo. Não há instância viva para repontar webhook (some a armadilha 5 para o `vn`; para o `rs` não há nada a repontar). **Não consegui confirmar na própria Evolution** que a instância não existe (não uso a chave dela) — confira em `go.local.ia.br` antes de apagar o canal. |

**Sobre apagar o canal "1175" do `rs`:** o canal não está vazio. Ele é referenciado por **75 conversas** e **223 envios frios** (`channel_cold_sends`); nenhuma mensagem, automação, disparo ou fluxo. Um `DELETE` direto na linha depende de a chave estrangeira apagar em cascata, anular ou barrar — **eu não verifiquei a regra** de cada FK. O caminho que o `vn` já usou nos canais dele é o do próprio app (excluir a instância): o canal fica `disabled` com o histórico preservado. É o que recomendo, e antes da cópia (F6), para o `vn` receber o canal já desativado. Se você quiser mesmo eliminar o canal **e** as 75 conversas, é decisão separada — me diga e eu confiro as FKs antes.

**Atualização — número <NUMERO_OFICIAL_1> removido (Meta bloqueou):** conferido no `rs`, o canal está `disabled` ("credenciais apagadas, histórico preservado") com **219 conversas** mantidas. Situação dos canais do `rs` agora:

| Canal | Estado | Conversas | Na cópia (F6) |
| ----- | ------ | --------- | ------------- |
| Oficial 3 (<NUMERO_OFICIAL_3>) | conectado, com `app_secret` | 116 | recifrar `access_token`, `verify_token`, `app_secret` |
| Oficial (<NUMERO_OFICIAL_1>) | desativado, bloqueado pela Meta | 219 | copiar o histórico; **não recifrar** o token — a linha ainda tem `access_token` não nulo apesar do "credenciais apagadas"; se não decifrar com a chave do `rs`, zerar na cópia em vez de abortar |
| Oficial 2 (<NUMERO_OFICIAL_2>) | desativado | 40 | idem |
| QRCode "1175" | `disconnected`, falso | 75 | excluir pelo app antes da cópia (fica `disabled`) |

Com isso o `rs` fica com **um único número oficial ativo**. É também o que explica o que a varredura mostrou: dos 3 `access_token`, só 2 apareceram em formato GCM — a hipótese é que o terceiro seja resíduo de uma remoção, **não verificado**.

### Situação dos dois bancos (conferida em 2026-10-06, só leitura)

`vn` e `rs` têm o **mesmo schema**: 67 tabelas, 196 funções, 2 triggers em `auth.users`. A migração 088 (reatribuição ao dono ao excluir usuário, do incidente de hoje) está nos dois. Observação: `list_migrations` mostra os dois só até a **085** — as 086, 087 e 088 foram aplicadas, mas não aparecem no histórico do MCP. Não bloqueia nada; só não confie nessa lista para "o que falta aplicar" (a conferência é por objeto no catálogo).

---

## ⚠️ Segurança — antes de qualquer coisa

As duas stacks que você colou no chat contêm credenciais reais (chave global da Evolution, senha do Postgres do Evolution, senha de app do Gmail, `JOBS_SECRET`, `BETTER_AUTH_SECRET`, `SECRETS_ENCRYPTION_KEY` do NexWei). Elas agora estão no histórico desta conversa. **Trate como expostas e rode a rotação**, em especial:

- `GLOBAL_API_KEY` da Evolution Go (dá controle de todas as instâncias; troca exige atualizar `EVOLUTION_GLOBAL_API_KEY` no ZAP CRM e no NexWei);
- senha do Postgres do Evolution (`postgres:5432`);
- senha de app do Gmail (revogar em myaccount.google.com → Segurança).

A stack entregue aqui usa só `TROCAR_*` — os valores reais ficam no Portainer. Nunca cole stack preenchida em chat.

---

## Armadilhas que moldam o plano

| # | Armadilha | Consequência se ignorada |
| - | --------- | ------------------------ |
| 1 | `NEXT_PUBLIC_*` são **embutidas no build**. | A imagem precisa ser construída com os `--build-arg`; editar a stack não muda a URL do Supabase no navegador. |
| 2 | `ENCRYPTION_KEY` da VPS tem de ser **a mesma** do deploy atual do `vn`. | Todo token da Meta e toda chave de IA gravados ficam ilegíveis; cada cliente reconecta. |
| 3 | **Cron em dois lugares ao mesmo tempo.** | Chamadas duplicadas. Só um agendador por vez (§F3). |
| 4 | `EVOLUTION_INSTANCE_PREFIX` tem de ser o das instâncias que já existem na `go.local.ia.br`. | O app não reconhece (ou tenta reconciliar) instâncias existentes. |
| 5 | Instâncias Evolution já criadas guardam o **webhook antigo** (domínio da Hostinger). | Elas continuam entregando mensagens no endereço velho depois da virada. **Não verifiquei** se o app re-registra o webhook em instância existente — conferir na F3 (e, se não re-registra, repontar via API da Evolution). |
| 6 | Cookie de sessão é por domínio. | Todos os usuários caem e entram de novo em `zap.local.ia.br`. Avisar. |
| 7 | **Meta App Secret:** o `rs` pode usar outro App da Meta que o `vn`. | O app já suporta segredo **por conta** (`webhook-signature.ts`), então não bloqueia, mas é preciso confirmar na F6 se a config do canal do `rs` guarda o App Secret próprio; senão o webhook do `rs` é rejeitado. |
| 8 | Site URL e Redirect URLs do Supabase Auth. | Link de convite e redefinição de senha apontam para o domínio velho (ou `localhost`). |
| 9 | Latência VPS ↔ Supabase (região do projeto `vn`). | Cada request do app faz várias idas ao banco. Conferir a região do `vn` e a da VPS antes de decidir. |

---

## Fases

Modelo sugerido por fase (decisão sua — é só recomendação): **Sonnet** para tudo de infraestrutura e checklist (F0–F5, F8); **Opus** para o script de cópia do `rs` (F6), por causa da ordem de chaves estrangeiras, triggers de quota/atividade, hash de senha e recriptografia.

### F0 — Decisões e inventário *(manual, 30 min)*

- [ ] Confirmar a região do Supabase `vn` e a da VPS (armadilha 9).
- [ ] Anotar do deploy atual (Hostinger): `ENCRYPTION_KEY`, `META_APP_SECRET`, `PLATFORM_OWNER_EMAILS`, `PLATFORM_ADMIN_SECRET`, `AUTOMATION_CRON_SECRET`, prefixo Evolution (`EVOLUTION_INSTANCE_PREFIX`) e **como os crons rodam hoje** (crontab? pg_cron? serviço externo?). Memória do projeto diz que **pg_cron nunca foi instalado no `vn`**: descobrir quem chama os crons hoje é a primeira pergunta.
- [ ] Criar o registro DNS **A** `zap.local.ia.br` → IP da VPS (precisa propagar antes do Traefik pedir o certificado Let's Encrypt).
- [ ] Rotacionar as credenciais da seção de segurança.

### F1 — Construir a imagem na VPS *(Sonnet)*

```bash
# Na VPS, a partir do código (zap-crm-br-client) copiado/clonado
docker build -t zapcrm:20261002-1 \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref-do-projeto-vn>.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key do vn> \
  --build-arg NEXT_PUBLIC_SITE_URL=https://zap.local.ia.br \
  --build-arg NEXT_PUBLIC_APP_LOCALE=pt-BR .
```

- Antes: `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` (o gate do `AGENTS.md`) **na máquina de dev**.
- **Não executei o `docker build` aqui.** O Dockerfile é uma proposta; o primeiro build real é o teste. Pontos a observar: `npm ci` (Node ≥ 20, usei 22), `next build --webpack` (script do `package.json`), fontes do PDF em `src/lib/inbox/export/fonts` (copiadas explicitamente, pois o file-tracing só vale com `standalone`).
- Imagem local: o Swarm de nó único usa a tag local. Se preferir registry privado, troque a `image:` na stack.

### F2 — Subir só o app, sem cron *(Sonnet)*

- No Portainer: nova stack `zapcrm` com `docs/deploy/stack-zapcrm.yml`, preenchendo os `TROCAR_*`, **com o serviço `zapcrm_cron` comentado** e a `image:` na tag construída.
- Ambos os apps (Hostinger e VPS) falam com o **mesmo** Supabase, então podem conviver — com a ressalva do cron (armadilha 3).
- Verificar: `https://zap.local.ia.br/login` abre com certificado válido; `docker service logs zapcrm_zapcrm_app`; login com um usuário real; abrir o inbox (realtime) e uma mídia.
- **Parar aqui se algo falhar**: o domínio antigo segue 100% funcional, nada foi cortado.

### F3 — Virada do domínio *(Sonnet guia, você executa; janela curta)*

Ordem, e o motivo de cada uma:

1. **Supabase Auth → URL Configuration:** *Site URL* = `https://zap.local.ia.br`; manter o domínio antigo em *Redirect URLs* durante a transição. Também confira os templates de e-mail (SPEC 053).
2. **Meta for Developers → WhatsApp → Configuration → Callback URL:** trocar para `https://zap.local.ia.br/api/whatsapp/webhook` (o *Verify Token* continua o mesmo). Para cada App Meta em uso.
3. **Instâncias Evolution:** conferir/repontar o webhook de cada instância para `https://zap.local.ia.br/api/channels/evolution/webhook/<segredo>` (armadilha 5; o segredo está no path e no registro do canal no banco).
4. **Cron:** no **cron-job.org**, pausar (não apagar ainda) todos os jobs do `vn` **e do `rs`**; só então descomentar `zapcrm_cron` e atualizar a stack. Conferir `docker service logs zapcrm_zapcrm_cron` mostrando `ok`. Os jobs do `rs` ficam pausados para sempre: o `rs` passa a ser atendido pelo mesmo app (F7). Apagar os jobs pausados só depois da F4.
5. **Redirecionar** o domínio antigo → `zap.local.ia.br` (301), mantendo `/api/whatsapp/webhook` e `/api/channels/evolution/webhook/*` respondendo no domínio velho por alguns dias, caso algum webhook tenha ficado para trás.
6. Avisar os usuários: serão deslogados uma vez (armadilha 6).

**Verificação:** mensagem recebida e enviada pelos dois tipos de canal; disparo agendado de teste dispara; e-mail de redefinição de senha chegando com link para o domínio novo; `/admin` abre para o proprietário.

**Reversão:** DNS/Meta/Supabase de volta ao domínio antigo (guardar os valores antigos antes de trocar). O app antigo não é apagado nesta fase.

### F4 — Estabilização *(1–2 semanas)*

- `docker stats` (memória do app vs limite de 1 GB; subir se houver OOM, principalmente na exportação de conversa PDF/ZIP).
- Só então desligar/cancelar a hospedagem da Hostinger.
- Agenda de backup: o Supabase (plano em uso) cobre o banco; Storage e `ENCRYPTION_KEY` guardados em cofre.

### F5 — Pré-requisitos da consolidação do `rs` *(manual + Sonnet)*

Decisões que bloqueiam a F6: ~~**D-3**~~ (**ratificada**: dono do `rs` → `dono-rs@exemplo.com`), **D-5** (`ENCRYPTION_KEY` do `rs` igual à do `vn`?), **D-6** (janela de corte e prazo do backup).

**Troca do e-mail do dono do `rs` — fazer na véspera da F6, não antes:**
- Mexer em `auth.users` + `auth.identities` (e-mail e `identity_data`) do `rs` e **a senha continua a mesma**. Preferir o painel (Authentication → Users) a SQL manual; se for SQL, atualizar as duas tabelas na mesma transação.
- Efeito colateral: se o deploy do `rs` na Hostinger usa `PLATFORM_OWNER_EMAILS=dono@exemplo.com`, o `/admin` dele **deixa de abrir para o novo e-mail** até a F7 (já que, depois da consolidação, o `/admin` é o da VPS). Por isso a troca fica perto do corte.
- O login do dono do `rs` vira o hotmail; avisar quem o usa.
- O e-mail antigo do dono do `rs` (gmail) fica **livre dentro do `rs`**; no `vn` ele já existe — a cópia de `auth.users` do `rs` para o `vn` só tem colisão se alguém do `rs` ainda tiver o gmail. Conferir na F6 (`SELECT` por e-mail nos dois lados).
- **Incidente de hoje (cascata ao excluir usuário):** a cópia traz `user_id → auth.users` em 19 tabelas. Copiar **`auth.users` primeiro**, e **nunca** apagar usuário do `rs` ou do `vn` durante o corte. A migração 088 cobre a exclusão por reatribuição, mas o `vn` é plano **Free, sem backup/PITR**: antes da F6 faça um dump do `vn` (`pg_dump` pela connection string) — não há como restaurar pelo MCP se a cópia errar.

Perguntas adicionais deste plano — **todas respondidas** (ver "Respostas ratificadas"). O que sobra da F5:
- ~~Gravar o App Secret do `rs` no canal <NUMERO_OFICIAL_1>~~ — **dispensado (2026-10-06):** o Bruno removeu esse número (bloqueado pela Meta). O canal ficou `disabled`, com as 219 conversas preservadas. O único número oficial ativo do `rs` é o "Oficial 3" (<NUMERO_OFICIAL_3>), que já tem `app_secret` gravado — nenhum canal ativo depende mais do `META_APP_SECRET` global.
- [x] ~~Excluir o canal QRCode "1175" do `rs`~~ — **feito em 2026-10-06 via MCP**, replicando `deleteEvolutionInstance()` (`src/lib/evolution/instances.ts`): apagou `evolution_instances` (o segredo saiu por cascata) e marcou o canal `disabled` / "Instância excluída pelo operador". A linha do canal **não** foi apagada: `conversations.channel_id` é `NO ACTION` (um `DELETE` falharia) e apagar levaria as 75 conversas / 671 mensagens junto, o que o PRD 047 §9.1 proíbe. Bruno confirmou que a instância já fora removida do painel da Evolution Go.
- [x] ~~Trocar o e-mail do dono do `rs`~~ — **feito em 2026-10-06 via MCP**: usuário `<id-do-usuario-dono-rs>` agora é `dono-rs@exemplo.com` em `auth.users`, `auth.identities` (`identity_data`), `raw_user_meta_data` e `public.profiles`. Papel `owner`, e-mail confirmado e senha **inalterados**. Efeito: o `/admin` do deploy atual do `rs` só abre para esse e-mail se o `PLATFORM_OWNER_EMAILS` dele incluir o hotmail; o login passa a ser o hotmail. **Não testei o login** (precisa da senha). Reversão: o mesmo `UPDATE` com os e-mails trocados.
- [ ] `pg_dump` do `vn` (plano Free, sem backup).
- [ ] Obter a `ENCRYPTION_KEY` do `rs` (Hostinger) e a do `vn`, para a recriptografia da F6.

### F6 — Copiar `rs` → `vn` *(Opus; roteiro em SPEC 078, ainda não escrita)*

Resumo: congelar o `rs`; exportar/importar a conta preservando UUIDs, **com triggers de quota e de atividade desligados na sessão**; copiar `auth.users`/`auth.identities` com o hash de senha; copiar o Storage e reescrever as 7 URLs absolutas em `messages.media_url`; **recifrar os segredos** (as chaves **são** diferentes: decifrar com a do `rs`, cifrar com a do `vn` — `whatsapp_config.access_token`, `verify_token`, `app_secret`, `evolution_instance_secrets.instance_token_encrypted` e qualquer coluna do mesmo formato que apareça numa nova varredura; tratar também o formato CBC legado `iv:cipher`, que `decrypt()` aceita e a varredura da leitura não pegou — um dos 3 `access_token` do `rs` não apareceu como GCM e precisa ser conferido); ensaiar tudo antes num projeto descartável. **Teste de aceite da recriptografia:** depois da cópia, decifrar cada valor com a chave do `vn` e conferir que o resultado tem o formato esperado (token da Meta começa com `EA`).

### F7 — Corte do `rs` *(manual)*

Webhooks Meta e Evolution do `rs` → `zap.local.ia.br`; os 3 usuários entram em `zap.local.ia.br`; conferência de contagens origem × destino; app do `rs` desligado; projeto Supabase `rs` **pausado** (não excluído) pelo prazo da D-6.

### F8 — Fechamento *(Sonnet)*

Atualizar `AGENTS.md`/README (domínio, stack, deploy) e registrar a memória do projeto.

---

## O que **não** verifiquei

- O `docker build` nunca rodou — o Dockerfile e a stack são propostas até o primeiro build real.
- A resolução de nome interno `evolution_go` na rede `bru` (por isso `EVOLUTION_API_URL` usa a URL pública).
- Se o app re-registra o webhook em instâncias Evolution existentes (armadilha 5).
- Como os crons rodam hoje no `vn`.
- A região do Supabase `vn` e da VPS.
