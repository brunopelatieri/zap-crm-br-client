# ZAP CRM BR — CRM para WhatsApp feito para o mercado brasileiro

> CRM para WhatsApp **100% em português do Brasil**, auto-hospedável e
> pensado para times brasileiros — caixa de entrada compartilhada,
> contatos, funis de vendas, disparos em massa e automações no-code.
> Interface traduzida, moeda BRL nativa e fluxos alinhados ao WhatsApp
> Business no Brasil. Faça o fork, personalize, hospede.

---

[![Licença: MIT](https://img.shields.io/badge/Licen%C3%A7a-MIT-violet.svg)](./LICENSE)
[![Idioma: pt-BR](https://img.shields.io/badge/Idioma-pt--BR-009c3b)](./docs/i18n-implementation-report.md)
[![i18n: next-intl](https://img.shields.io/badge/i18n-next--intl-7c3aed)](./docs/i18n-implementation-report.md)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Stars](https://img.shields.io/github/stars/brunopelatieri/zap-crm-br?style=social)](https://github.com/brunopelatieri/zap-crm-br/stargazers)

Este repositório é o produto — clone ou faça o fork para rodar o seu
próprio CRM **em português**, com suporte opcional a inglês para times
internacionais. A interface, os rótulos de negócio e a experiência de
configuração foram localizadas para o **mercado brasileiro**.

---

## Feito para o Brasil — interface em português (pt-BR)

O **ZAP CRM BR** não é só um fork traduzido: a internacionalização
(i18n) é parte central do produto. Toda a experiência do painel —
login, caixa de entrada, contatos, funis, disparos, automações,
configurações e assistente de IA — está disponível em **português do
Brasil (**`pt-BR`**)**, com mais de **1.600 chaves** de tradução
mantidas em paridade via `npm run i18n:check`.

|                             |                                                                            |
| --------------------------- | -------------------------------------------------------------------------- |
| **Idioma recomendado**      | Português do Brasil (`pt-BR`)                                              |
| **Onde trocar no app**      | **Configurações → Aparência → Idioma**                                     |
| **Idioma padrão no deploy** | `NEXT_PUBLIC_APP_LOCALE=pt-BR` no `.env`                                   |
| **Persistência**            | Cookie por dispositivo (sem mudar a URL)                                   |
| **Idioma alternativo**      | Inglês (`en`) — útil para times multilíngues                               |
| **Especificação técnica**   | [docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md) |

**Por que isso importa para o mercado brasileiro**

- Onboarding e operação diária **sem barreira de idioma** para
  atendentes, vendedores e gestores.
- Terminologia alinhada ao dia a dia de CRM no Brasil: _funil_,
  _disparo_, _negócio_, _etiqueta_, _caixa de entrada_.
- **Real (BRL)** como moeda padrão em negócios e painéis.
- Fluxos de convite, cadastro e recuperação de senha em português —
  primeira impressão profissional para clientes e equipe.

Para colocar o CRM **já em português na primeira visita**, configure:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

O usuário ainda pode alternar para inglês em **Configurações →
Aparência → Idioma**; a escolha fica salva no navegador.

---

## Créditos

> Este projeto é um fork/derivado do repositório original
> [wacrm](https://github.com/ArnasDon/wacrm) desenvolvido por
> [ArnasDon](https://github.com/ArnasDon). Todos os créditos pelo core
> original da aplicação pertencem ao autor original. As modificações,
> **localização para o mercado brasileiro**, internacionalização
> (i18n) e evolução deste projeto sob o nome **ZAP CRM BR** são
> mantidas por [Bruno Pelatieri](https://github.com/brunopelatieri) no
> repositório [zap-crm-br](https://github.com/brunopelatieri/zap-crm-br).

---

## O que você recebe — tudo pensado para operar em português

- **Caixa de entrada compartilhada** na API oficial do WhatsApp
  Business — vários atendentes no mesmo número, atribuição por
  conversa, status (aberta / pendente / encerrada) e anotações internas.
- **Contatos + etiquetas + campos personalizados** — importação via
  CSV, deduplicação e busca por nome, telefone ou e-mail.
- **Gestão de etiquetas direto no Inbox** — 🆕 _recurso exclusivo do
  ZAP CRM BR, ausente no [wacrm](https://github.com/ArnasDon/wacrm)
  original. Crie, atribua e remova etiquetas de um lead sem sair da
  conversa: um único modal acionável tanto na lista de conversas
  quanto na barra lateral de contato, com atualização otimista,
  catálogo sem duplicatas por conta (nome único, case-insensitive) e
  criação restrita a administradores/proprietários por papel de
  conta.
- **Funis de vendas (Kanban)** — negócios vinculados às conversas,
  etapas personalizáveis e totais em **Real (BRL)**.
- **Disparos em massa** — templates aprovados pela Meta, funil de
  entrega e leitura, personalização de variáveis por destinatário.
- **Teste A/B de templates** — 🆕 _recurso exclusivo do ZAP CRM BR,
  ausente no [wacrm](https://github.com/ArnasDon/wacrm) original._ A
  mesma audiência é dividida por sorteio entre dois templates aprovados
  e os dois funis aparecem lado a lado, com teste de significância
  estatística — sem declarar vencedor em amostra pequena, que é como a
  maioria das ferramentas induz à decisão errada. Veja
  [docs/teste-ab-disparos.md](./docs/teste-ab-disparos.md).
- **Automações no-code** — gatilhos por mensagem recebida, novo
  contato, palavra-chave ou horário; ramificações, esperas, etiquetas
  e webhooks. Construtor visual com rótulos em português. O gatilho por
  horário tem um construtor visual próprio — pílulas para "todo dia",
  "toda segunda e quarta", "a cada 2 horas" etc., sem exigir saber o
  que é uma expressão cron — e roda contra um segmento por etiqueta.
  Detalhes técnicos em
  [docs/spec-046-agendamento-visual.md](./docs/spec-046-agendamento-visual.md).
- **Reengajamento automático antes da janela de 24h fechar** — 🆕
  _recurso exclusivo do ZAP CRM BR, ausente no
  [wacrm](https://github.com/ArnasDon/wacrm) original._ O WhatsApp só
  deixa mandar mensagem de texto livre até 24h depois da última
  mensagem do cliente — depois disso, só template pago e aprovado pela
  Meta. Um novo gatilho de automação ("Janela de 24h fechando") detecta
  sozinho as conversas paradas a poucas horas de cair fora da janela e
  manda um lembrete automaticamente, sem ninguém precisar lembrar. Vem
  com guarda-corpo: nunca fala por cima de um atendente humano ou de um
  menu de automação em andamento, respeita quem pediu para não receber
  mensagem e nunca dispara fora do horário comercial. Um painel mostra
  quantas conversas voltaram a responder e avisa se a taxa de
  descadastro subir — o sinal mais cedo de que o texto precisa mudar.
  Detalhes técnicos em
  [docs/spec-045-reengajamento-janela-24h.md](./docs/spec-045-reengajamento-janela-24h.md).
- **Assistente de respostas com IA** — traga sua chave OpenAI ou
  Anthropic (criptografada; sem taxa por assento). Gere rascunhos na
  caixa de entrada, resposta automática opcional com limite por
  conversa e handoff limpo para humano. **Base de conhecimento** em
  português (FAQs, políticas, catálogo).
- **Painel em tempo real** — tempo de resposta, volume diário, valor
  do funil e feed de atividades entre módulos.
- **Contas de equipe** — convite por link, papéis (proprietário /
  admin / atendente / visualizador) e caixa compartilhada para todo o
  time.
- **Gestão de conta** — perfil, e-mail, senha, avatar e logout em
  todos os dispositivos.
- **API REST pública** (`/api/v1`) — chaves escopadas para integrar
  com Zapier, n8n ou sistemas próprios. Veja
  [docs/public-api.md](./docs/public-api.md).
- **Automação n8n de ingestão de contatos** — um webhook pronto que
  cria/atualiza contatos, tags, campos personalizados e notas a partir
  de qualquer origem externa (formulário, e-commerce, planilha, outro
  CRM). Template documentado e reutilizável para novas integrações. O
  JSON exportado é versionado sem credencial (placeholder `<REDACTED>`
  no lugar da service_role key) — configure a sua antes de reimportar.
  Veja [n8n_automation/](./n8n_automation/README.md).
- **Servidor MCP** — controle o CRM pelo Claude, Cursor e outros
  assistentes via [Model Context Protocol](https://modelcontextprotocol.io).
  Veja [docs/mcp.md](./docs/mcp.md).

---

## Por que fazer fork disso?

Isto é um **template**, não um SaaS fechado. Fazer o fork significa:

- **Propriedade total** — seu código, seu Supabase, seu domínio, seus
  dados. Sem lock-in, sem cobrança por assento.
- **CRM em português de fábrica** — não é adaptação superficial: dicionário
  `pt-BR` completo, seletor de idioma e checagem de paridade com
  `npm run i18n:check`. Ideal para agências, SaaS B2B e operações de atendimento no
  Brasil.
- **Customização total** — adicione campos, remova módulos, estenda
  traduções. Stack previsível: Next.js + Supabase + Tailwind.
- **Deploy rápido** — [Hostinger](https://www.hostinger.com/web-apps-hosting)
  publica um fork em poucos cliques
  ([veja abaixo ↓](#-deploy-na-hostinger-recomendado)).
- **Segurança de produção** — AES-256-GCM nos tokens, RLS, webhooks
  HMAC, CSP, rate limiting e scripts locais de validação (`typecheck`,
  `i18n:check`, testes).

Não é um framework. É um CRM concreto que você coloca no ar em uma
tarde — **em português** — e adapta ao seu negócio.

---

## Início rápido (com interface em português)

```bash
# Fork: https://github.com/brunopelatieri/zap-crm-br → Fork
git clone https://github.com/<seu-usuario>/zap-crm-br.git
cd zap-crm-br
npm install
cp .env.local.example .env.local
```

No `.env.local`, além das credenciais Supabase + Meta, defina:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

```bash
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000). Você será redirecionado para `/login`
(ou `/dashboard` se já estiver autenticado) — **em português do
Brasil**.

> **Próximo passo:** antes do primeiro deploy, rode a
> [sequência de validação local](#-validação-local--obrigatória-sem-ci-no-github).

---

## 🚀 Deploy na Hostinger (recomendado)

O **ZAP CRM BR** roda na
[Hostinger](https://www.hostinger.com/web-apps-hosting) — caminho
testado para colocar um CRM **em português** em produção sem VPS.

**No hPanel**, inclua entre as variáveis de ambiente:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

### Por que Hostinger?

|                         |                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Deploy via Git**      | Conecte o fork, push na `main`, build automático.                                                   |
| **Node.js gerenciado**  | Next.js 16 roda nos planos [Premium, Business e Cloud](https://www.hostinger.com/web-apps-hosting). |
| **SSL + domínio**       | HTTPS obrigatório para webhook do WhatsApp Business.                                                |
| **Variáveis no painel** | `SUPABASE_`*, `WHATSAPP_*`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_LOCALE`.                             |
| **Custo acessível**     | Alternativa simples a VPS + banco separado (Supabase).                                              |

### Em 60 segundos

1. **Fork** deste repositório.
2. **hPanel → Websites → Create → Node.js** e conecte o fork.
3. Cole credenciais Supabase + Meta + `NEXT_PUBLIC_APP_LOCALE=pt-BR`.
4. Push na `main`. Pronto — CRM em produção **em português**.

> **Antes do passo 4:** execute a
> [sequência completa de validação](#sequência-completa--rode-antes-de-git-push-na-branch-de-deploy)
> localmente. Deploy na Hostinger dispara `npm run build` no servidor —
> erros que passaram no `dev` podem derrubar o build remoto.

### ⚠️ Configure a Site URL do Supabase antes de ir ao ar

Por padrão, o Supabase usa a **Site URL** do projeto (**Authentication
→ URL Configuration**) como destino do link de confirmação de e-mail e
de redefinição de senha sempre que o código não passa um `redirectTo`
explícito — é o caso do cadastro sem convite
([src/app/(auth)/signup/page.tsx](<./src/app/(auth)/signup/page.tsx>)).
Projetos novos do Supabase vêm com essa URL em `http://localhost:3000`;
se você não trocar antes do deploy, o e-mail de confirmação em
produção vai linkar para `localhost`, mesmo com o app publicado.

No painel do Supabase, em **Authentication → URL Configuration**:

- **Site URL** — troque para a URL de produção (ex.:
  `https://crm.seudominio.com`).
- **Redirect URLs** — adicione as rotas de callback do app (ex.:
  `https://crm.seudominio.com/auth/callback`,
  `https://crm.seudominio.com/join/*`).

Isso é independente da variável `NEXT_PUBLIC_SITE_URL` do `.env` —
aquela controla só links gerados pelo próprio app (convites, sitemap);
a Site URL do Supabase é o que define o redirect padrão dos e-mails de
autenticação.

Guia com capturas (documentação original em inglês):
**[wacrm.tech/docs/deployment-hostinger](https://wacrm.tech/docs/deployment-hostinger)**.

> O ZAP CRM BR é MIT e roda em qualquer host Node.js (Vercel, Railway,
> VPS). A Hostinger é recomendada, não obrigatória.

---

## Agendador cron

**Necessário para tudo que roda sozinho:** disparos agendados, esperas
em automações e limpeza de execuções de fluxo.

Três funcionalidades do CRM **não têm quem as acorde**: elas esperam
alguém bater numa rota de tempos em tempos. Sem esse agendador, nada
quebra visivelmente — o recurso simplesmente nunca acontece, em
silêncio. É a pegadinha operacional mais comum de quem sobe o projeto.

| Rota                    | O que faz                                                                                                              | Sem o cron                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/broadcasts/cron`  | Dispara campanhas **agendadas** que venceram                                                                           | O disparo fica em "Agendado" para sempre e ninguém é avisado                                       |
| `/api/automations/cron` | Retoma automações paradas em **espera**, dispara o gatilho **"Baseado em horário"** e o reengajamento de janela de 24h | A automação trava no "Wait"; agendamentos e reengajamento de janela nunca disparam, sem erro algum |
| `/api/flows/cron`       | Encerra execuções de fluxo abandonadas                                                                                 | Execuções velhas ficam penduradas                                                                  |

**Disparo imediato, inbox, contatos e funis não dependem do cron.** Se
você ainda não usa agendamento nem passos de espera, isso pode esperar —
mas configure antes de alguém clicar em "Agendar" pela primeira vez.

### Como configurar

Primeiro, gere um segredo e coloque-o nas variáveis de ambiente do seu
deploy (hPanel, Vercel, `.env` do VPS — onde for):

```bash
openssl rand -hex 32
```

```env
AUTOMATION_CRON_SECRET=o-valor-gerado-acima
```

Um segredo só protege as três rotas, que o esperam no cabeçalho
`x-cron-secret`. **Sem essa variável no servidor, as três respondem
`503`** — é uma trava proposital, para não existir cron "meio
configurado" rodando em produção.

Depois, escolha **um** agendador:

**Opção A — Supabase Cron (recomendado).** Você já depende do Supabase;
não precisa de mais um serviço no ar. Roda dentro do próprio banco, com
`pg_cron` + `pg_net`, e guarda o segredo cifrado no
[Vault](https://supabase.com/docs/guides/database/vault) em vez de
deixá-lo legível no comando do job.

Script pronto, comentado e idempotente:
**[supabase/setup/cron-jobs.sql](./supabase/setup/cron-jobs.sql)** —
cole no SQL Editor do painel, edite duas linhas (URL do app e segredo),
rode. O arquivo traz também as consultas de conferência e o desfazer.

> ⚠️ **Não é uma migração.** Ele não fica em `supabase/migrations/` de
> propósito: migrações descrevem o schema e valem igual em todo fork,
> enquanto um cron job carrega a URL do _seu_ deploy e o _seu_ segredo.
> Rodado como migração, o fork de qualquer pessoa agendaria chamadas
> para o seu domínio.

**Opção B — serviço externo** (ex.: [cron-job.org](https://cron-job.org),
gratuito). Crie três tarefas a cada 5 minutos, uma por rota, cada uma
com o header `x-cron-secret`.

**Opção C — `crontab` do seu VPS**, se você hospeda em servidor próprio:

```
*/5 * * * * curl -sS -H "x-cron-secret: SEU_SEGREDO" https://seu-dominio.com/api/broadcasts/cron
*/5 * * * * curl -sS -H "x-cron-secret: SEU_SEGREDO" https://seu-dominio.com/api/automations/cron
*/5 * * * * curl -sS -H "x-cron-secret: SEU_SEGREDO" https://seu-dominio.com/api/flows/cron
```

Cinco minutos é suficiente nas três: a granularidade do agendamento na
interface é de minuto, e alguns minutos de atraso num disparo em massa
não mudam nada.

### Conferir que está funcionando

```bash
curl -i -H "x-cron-secret: SEU_SEGREDO" https://seu-dominio.com/api/broadcasts/cron
```

| Resposta                                       | Significa                                             |
| ---------------------------------------------- | ----------------------------------------------------- |
| `200` com `{"dispatched":0,"postponed":0,...}` | Funcionando (zero é normal se nada venceu agora)      |
| `401`                                          | O segredo enviado não bate com o do servidor          |
| `503`                                          | `AUTOMATION_CRON_SECRET` não está configurado no host |

---

## Retenção de mensagens

**Opcional e desligada por padrão.** Sem nenhuma variável a mais no
`.env`, o CRM se comporta exatamente como antes: histórico completo,
para sempre, em toda conta. Ligar a retenção é uma decisão explícita
do operador do deploy, não algo que "vem ligado" num `git pull`.

Quando ligada, uma varredura periódica pode remover mensagens antigas
de `messages`, por conta e por tipo de canal (WhatsApp Oficial /
WhatsApp QRCode) — nunca a conversa em si, e nunca uma mensagem
marcada como favorita (estrela na barra de ações da bolha). Cada conta
pode ajustar os próprios limites em **Configurações → Retenção**
(só o Proprietário vê essa aba).

```env
# Interruptor. Ausente = nada é apagado, em nenhuma conta.
MESSAGE_RETENTION_ENABLED=true

# Padrões por tipo de canal — usados quando uma conta não configurou
# um limite próprio naquela dimensão. Ausente = sem limite ali.
MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES=5000
MESSAGE_RETENTION_WHATSAPP_QR_DAYS=30
MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES=200

MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES=50000
MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS=365
MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES=2000

# Trilhos de segurança e ritmo.
MESSAGE_RETENTION_MIN_AGE_HOURS=72      # nada mais novo que isto é apagado
MESSAGE_RETENTION_INTERVAL_HOURS=6      # intervalo mínimo entre varreduras
MESSAGE_RETENTION_BATCH_LIMIT=5000      # teto por fase, por conta × canal
```

Um valor `0` numa das dimensões acima (ou no painel de Configurações)
significa **sem limite** naquela dimensão, não "apagar tudo" — e um
`.env` com o nome de uma variável digitado errado também vira "sem
limite" ali, com um aviso no log, nunca uma exclusão em massa por
acidente.

**A varredura roda de graça** dentro do agendador cron que você já
configurou acima (`/api/automations/cron`), respeitando
`MESSAGE_RETENTION_INTERVAL_HOURS` por dentro — nenhuma rota nova a
agendar. Quem quiser a limpeza num horário próprio (ex.: 03h, fora do
pico) tem o bloco opcional em
[supabase/setup/cron-jobs.sql](./supabase/setup/cron-jobs.sql)
(`GET /api/messages/retention/cron`, mesmo `AUTOMATION_CRON_SECRET`).

A limpeza apaga a **linha** da mensagem, nunca o arquivo de mídia no
Storage — o bucket `chat-media` só cresce com o tempo. Para liberar
espaço de vez em quando, rode
[supabase/setup/orphan-media-cleanup.sql](./supabase/setup/orphan-media-cleanup.sql)
manualmente (SELECT de conferência primeiro, DELETE comentado).

Especificação completa: [docs/spec-060-retencao-e-limpeza-de-mensagens.md](./docs/spec-060-retencao-e-limpeza-de-mensagens.md).

## Retenção do registro de atividade

**Opcional e desligada por padrão**, com **regra própria** — não é a
mesma chave da retenção de mensagens acima, e o corte não é por canal:
`account_activity_log` (SPEC 075) é o "quem fez o quê" da conta inteira,
não das conversas de um canal.

```env
# Interruptor + prazo, na mesma variável. Ausente/vazio = nada é
# apagado (a retenção nem chega a rodar). "0" = a retenção está LIGADA,
# mas configurada para nunca apagar nada — diferente de ausente, e
# aparece assim nos logs do cron.
ACTIVITY_LOG_RETENTION_DAYS=180
```

**A varredura roda de graça** nas mesmas duas portas da retenção de
mensagens (`/api/automations/cron` e, opcionalmente,
`GET /api/messages/retention/cron`) — nenhuma rota nova, nenhum
agendamento novo. Ela é independente do `MESSAGE_RETENTION_ENABLED` de
cima: dá para ligar uma sem a outra.

Antes de ligar pela primeira vez em produção, confira quantas linhas
**seriam** apagadas, sem apagar nenhuma:

```bash
curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  "https://seu-dominio/api/messages/retention/cron?dry_run=1"
```

A resposta traz `activity_log.candidates` (quantas linhas passariam do
prazo) sem tocar `activity_log.deleted` (sempre `0` em modo prévia).

---

## Notificações do sistema (SMTP + webhook)

**Opcional.** Sem nenhuma variável a mais, o console (`/admin`) continua
funcionando normalmente — as trocas de plano, bloqueios e vencimentos só
deixam de avisar o mantenedor por e-mail/webhook. Nenhum recurso do
cliente depende disto.

Quando um evento relevante acontece (troca de plano, bloqueio, conta
nova, vencimento, quota estourada), ele entra numa outbox
(`system_notifications`) e é entregue por até dois canais independentes,
cada um desligável sozinho:

```env
# E-mail do sistema. Sem SMTP_HOST ou SYSTEM_NOTIFICATION_EMAIL, o canal
# de e-mail é um no-op silencioso — nunca quebra a ação que originou o
# aviso.
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587                    # 465 -> TLS implícito; 587/25 -> STARTTLS
SMTP_USER=avisos@zapcrmbr.com
SMTP_PASSWORD=
SMTP_SECURE=false                # true força TLS implícito (independe da porta)
SMTP_FROM="ZAP CRM BR <avisos@zapcrmbr.com>"
SYSTEM_NOTIFICATION_EMAIL=bruno@zapcrmbr.com   # destinatário dos avisos (você, não o cliente)

# Webhook. PLAN_REQUEST_WEBHOOK_URL continua valendo (era usada só para
# solicitações de plano); SYSTEM_EVENT_WEBHOOK_URL é o alias novo que
# recebe TODOS os eventos — se as duas existirem, a nova vence.
PLAN_REQUEST_WEBHOOK_URL=https://n8n.exemplo.com/webhook/zapcrm
SYSTEM_EVENT_WEBHOOK_URL=
SYSTEM_EVENT_WEBHOOK_SECRET=      # opcional — assina o corpo (HMAC)
```

**Nunca use este SMTP para autenticação** (confirmação de cadastro,
recuperação de senha) — isso é do Supabase Auth, configurado à parte.
Este canal é só para os avisos comerciais/operacionais do console.

Acompanhe o que foi entregue, o que falhou e reenvie manualmente em
**`/admin` → Notificações** (`/admin/notifications`, só o Proprietário
vê). A entrega roda de graça dentro do mesmo agendador cron já
configurado acima (fase 6 de `/api/automations/cron`) — nenhuma rota
nova a agendar; a maior parte sai antes disso, na própria requisição que
originou o evento.

Especificação completa: [docs/spec-063-notificacoes-do-sistema-smtp.md](./docs/spec-063-notificacoes-do-sistema-smtp.md) · guia de uso do console: [docs/guia-console-do-proprietario.md](./docs/guia-console-do-proprietario.md).

---

## Internacionalização (i18n) — detalhes para desenvolvedores

Arquitetura com `[next-intl](https://next-intl.dev)`: **sem prefixo na
URL** (não existe `/pt-br/dashboard`). O locale é resolvido por cookie

- variável de ambiente.

|                           |                                                             |
| ------------------------- | ----------------------------------------------------------- |
| **Locale principal (BR)** | `pt-BR` — recomendado em todo deploy nacional               |
| **Locale alternativo**    | `en` — mantido para compatibilidade e times globais         |
| **Trocar no app**         | Configurações → Aparência → Idioma                          |
| **Cookie**                | `NEXT_LOCALE` (por dispositivo)                             |
| **Dicionários**           | `messages/pt-BR.json` e `messages/en.json`                  |
| **Paridade de chaves**    | `npm run i18n:check`                                        |
| **API REST**              | Mensagens de `/api/`** em inglês (integrações); a UI traduz |
| erros quando necessário   |                                                             |

**Especificação completa (arquitetura, auditoria, fases):**
[docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md)

### Adicionar outro idioma (ex.: espanhol)

1. Inclua o tag em `[src/lib/i18n/locales.ts](./src/lib/i18n/locales.ts)`
   (`SUPPORTED_LOCALES` + `LOCALE_LABELS`).
2. Copie `messages/en.json` → `messages/<locale>.json` e traduza os
   valores (mantenha as chaves e placeholders `{count}`, `{name}`, etc.).
3. Execute `npm run i18n:check` até passar.
4. O seletor em Configurações → Aparência lista o idioma automaticamente.

---

## Documentação

> **Desenvolvedores:** comece pela seção
> [⚠️ Validação local](#-validação-local--obrigatória-sem-ci-no-github)
> e pelo guia
> [Comandos de desenvolvimento](./docs/comandos-desenvolvimento.md).

**Neste repositório (português / ZAP CRM BR):**

- [Comandos de desenvolvimento](./docs/comandos-desenvolvimento.md)
- [Teste A/B de templates nos disparos](./docs/teste-ab-disparos.md) —
  como dividir a audiência entre dois textos e ler o resultado sem se
  enganar com amostra pequena.
- [Construtor visual de agendamento (gatilho "Baseado em horário")](./docs/spec-046-agendamento-visual.md) —
  como o cron por trás do agendamento visual é montado, validado e
  executado, e por que o piso é de 15 minutos.
- [Reengajamento automático na janela de 24h](./docs/spec-045-reengajamento-janela-24h.md) —
  o gatilho "Janela de 24h fechando" e os guarda-corpos por trás dele.
- [Agendador cron via Supabase](./supabase/setup/cron-jobs.sql) —
  script pronto para o SQL Editor que agenda as três rotas de cron com o
  segredo no Vault. Contexto e alternativas na seção
  [Agendador cron](#agendador-cron).
- [Console do proprietário (`/admin`)](./docs/guia-console-do-proprietario.md) —
  contas, bloqueio, planos, retenção e notificações do sistema.
- [Notificações do sistema (SMTP + webhook)](./docs/spec-063-notificacoes-do-sistema-smtp.md) —
  outbox, dedupe, recuo exponencial e o formato do e-mail/webhook.
- [Relatório de implementação i18n](./docs/i18n-implementation-report.md)
- [API pública (`/api/v1`)](./docs/public-api.md)
- [Servidor MCP](./docs/mcp.md)
- [Automações n8n (ingestão de contatos e integrações externas)](./n8n_automation/README.md) —
  como conectar formulários, e-commerce, planilhas e outros sistemas ao CRM sem tocar no código do app.

**Projeto original wacrm (inglês — mesma base técnica):**

- [wacrm.tech/docs](https://wacrm.tech/docs)
- [Primeiros passos](https://wacrm.tech/docs/getting-started)
- [Supabase](https://wacrm.tech/docs/supabase-setup) ·
  [WhatsApp](https://wacrm.tech/docs/whatsapp-setup) ·
  [Variáveis de ambiente](https://wacrm.tech/docs/environment-variables) ·
  [Deploy Hostinger](https://wacrm.tech/docs/deployment-hostinger)

---

## Stack

- **App** — Next.js 16, React 19, TypeScript, Tailwind v4,
  **next-intl** (pt-BR + en).
- **Dados** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (WhatsApp Business oficial).

---

## ⚠️ Validação local — obrigatória (sem CI no GitHub)

> ### **IMPORTANTE — leia antes de commitar ou fazer deploy**
>
> Este repositório **não inclui** a pasta `.github/`. Não há GitHub
> Actions, Dependabot nem templates de issue/PR rodando no remoto.
> **A qualidade do código depende de você** executar os comandos abaixo
> na sua máquina nos momentos certos.
>
> 📖 **Guia completo (quando, por quê, fluxos por tipo de mudança):**
> **[docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md)**

### Quando executar cada comando

| Momento                               | Comando(s)                                   | Por quê                                                           |
| ------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| **Primeira vez / deps novas**         | `npm install`                                | Instala dependências do `package-lock.json`                       |
| **Desenvolvimento diário**            | `npm run dev`                                | Servidor local com hot reload (`localhost:3000`)                  |
| **Editou `messages/*.json` ou `t()`** | `npm run i18n:check`                         | Garante paridade EN ↔ PT (~1.600 chaves); evita `MISSING_MESSAGE` |
| **Antes de todo commit**              | `typecheck` → `i18n:check` → `lint` → `test` | Substitui o CI que existia em `.github/workflows/ci.yml`          |
| **Antes de push / deploy**            | Sequência completa ↓ + `build`               | O host (Hostinger, Vercel…) roda build — falhe local primeiro     |

### Sequência completa — rode antes de `git push` na branch de deploy

Copie e execute **na ordem**. Se qualquer passo falhar, **não faça deploy**.

```bash
npm run typecheck      # TypeScript — erros de tipo e imports
npm run i18n:check     # Paridade messages/en.json ↔ pt-BR.json
npm run lint           # ESLint — padrões e anti-patterns
npm run test           # Vitest — libs críticas (webhook, crypto, flows…)
npm run format:check   # Prettier — formatação consistente
npm run build          # Build de produção — mesmo passo do servidor
```

| Comando      | O que valida se você pular                 |
| ------------ | ------------------------------------------ |
| `typecheck`  | Build quebra tarde; props/APIs erradas     |
| `i18n:check` | Tela quebrada só em pt-BR ou en            |
| `lint`       | Débito técnico; bugs que ESLint detectaria |
| `test`       | Regressão em regras de negócio sem browser |
| `build`      | Deploy falha no Hostinger/Vercel           |

**Quer CI automático de novo?** Recrie `.github/workflows/` no **seu
fork** — exemplo e detalhes em
[docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md#recriar-ci-no-seu-fork-opcional).

---

## Contribuindo

Template para fork → personalizar → publicar. Bugs e segurança são
bem-vindos; features costumam ficar no seu fork. Veja
[CONTRIBUTING.md](./CONTRIBUTING.md).

**Validação:** siga a seção
[⚠️ Validação local — obrigatória](#-validação-local--obrigatória-sem-ci-no-github)
e o guia [docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md).

Vulnerabilidades: [Security Advisories](https://github.com/brunopelatieri/zap-crm-br/security/advisories/new) (privado).

---

## Licença

[MIT](./LICENSE). Faça o fork, personalize, hospede **no Brasil, em
português**.

---

**ZAP CRM BR** é mantido por [Bruno Pelatieri](https://github.com/brunopelatieri)
sobre o core de [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm).
Veja [Créditos](#créditos).
