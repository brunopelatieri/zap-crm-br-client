# SPEC 079 — Otimização do contexto de agentes de IA (padrão ECC): rules por path, skills sob demanda e roteamento por índice

> **Status:** **Em execução** — GO dado e D-1…D-28 **ratificadas como recomendado** (§12) em 2026-10-30; `/context` de sessão nova antes da F0 (app desktop): **72,2k / 1M tokens (7%)**. Cada fase roda em sessão própria (modelo do §10) e termina com `/code-review high` nos arquivos que criou.
> **Data:** 2026-10-30
> **Contexto:** o conjunto que entra em **toda** sessão do Claude Code neste repositório é `CLAUDE.md` + `AGENTS.md` inteiro (via `@AGENTS.md`): **27.868 B / 241 linhas**, dos quais **52,6%** são um catálogo de documentos (não instrução) e vários fatos já foram desmentidos pelo disco (3 rotas de cron × 7 reais; migrações `001 → 054` × 089; `~1.600` chaves × 3.550). Inspirado no repositório [`affaan-m/ECC`](https://github.com/affaan-m/ECC) (rules segmentadas, skills, separação regra curta × conhecimento longo).
> **Migração:** nenhuma. **Código de produto:** nenhum (`src/`, `supabase/`, `public/`, `messages/`, `docker/` intocáveis).
> **Depende de:** commit `c4269ce` (passou a versionar `docs/**/*.md`) · [`plano-implantacao-spec-065.md`](./plano-implantacao-spec-065.md) (modelo do §10) · [`supabase/migrations/README.md`](../supabase/migrations/README.md) (numeração).

---

## 0. Metadados e status

| Campo                    | Valor                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entrega desta sessão     | **Só este arquivo.** Snapshot de abertura e simulações ficaram em `C:\Users\BRUNOP~1\AppData\Local\Temp\spec-079` (fora do repo)                                                                                   |
| Ferramentas              | Claude Code CLI no Git Bash: `2.1.211` (`claude --version`). O app desktop pode trazer outra versão — registrar a de cada sessão de execução                                                                       |
| Escopo de escrita futura | `CLAUDE.md`, `AGENTS.md`, `docs/context/**`, `.claude/rules/**`, `.claude/skills/**`, `.claude/settings.json` (só `deny`, se D-17), `.ignore` (se D-7), `.gitignore` (se D-5 = b)                                  |
| Fora de escopo           | `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, `~/.claude/CLAUDE.md`, memória automática, tudo em `src/`, `supabase/`, `public/`, `messages/`, `docker/`, `mcp-server/`, `n8n_automation/`, `scripts/` |
| Próximo passo            | Mantenedor cola a saída de `/context` (sessão nova) e de `claude mcp list`, ratifica §12 e dá o GO da F0                                                                                                           |

---

## 1. Objetivo, não-objetivos, escopo

**Objetivo.** Reduzir o contexto fixo do repositório de **27.868 B → ≤ 9.000 B** (≥ 67%) **sem perder nenhum dos 10 invariantes** (§6), trocando "tudo sempre carregado" por três camadas:

1. **Sempre carregado** (`CLAUDE.md` → `AGENTS.md`): só os inegociáveis, créditos, armadilhas citadas pelo código e ponteiros.
2. **Carregado por path** (`.claude/rules/*.md` com `paths:`): decisões curtas do domínio + caminho do arquivo longo.
3. **Carregado sob demanda** (`docs/context/*.md`, `.claude/skills/*/SKILL.md`): conhecimento longo, lido quando a tarefa pede.

**Não-objetivos.**

- Não instalar o ECC (plugin, marketplace, hooks, agents, commands) — §3.
- Não reescrever SPECs/PRDs existentes, nem mover `docs/context/phone-number-format-standard.md` ou `docs/references/**`.
- Não corrigir as 49 falhas de Prettier pré-existentes em `docs/` (D-13) nem os finais de linha CRLF (D-14).
- Não mexer no peso dos MCPs nem na memória automática (são achados, §2.1; ficam para outra SPEC).
- Não decidir nada sobre o template público `zap-crm-br` além de registrar (D-22).

**Intocáveis** (prova na F6, §7): `src/`, `supabase/`, `public/`, `messages/`, `docker/`, `mcp-server/`, `n8n_automation/`, `scripts/`, `package*.json`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`.

---

## 2. Baseline medido (Fase 0)

Todos os números abaixo foram medidos em 2026-10-30 nesta sessão, no Git Bash, a partir da raiz do repo. Tokens são **estimativa** (bytes/3,5 e bytes/4); pt-BR acentuado infla bytes em UTF-8, então a taxa real tende ao lado de /3,5. O número que vale é o do `/context` (§2.1, item pendente).

### 2.1 (a) Conjunto sempre carregado

| Arquivo                                                             |  Linhas |      Bytes | Tok (/3,5) |  Tok (/4) | Comando                                                                         | Escopo              |
| ------------------------------------------------------------------- | ------: | ---------: | ---------: | --------: | ------------------------------------------------------------------------------- | ------------------- |
| `CLAUDE.md`                                                         |       7 |        713 |        204 |       178 | `wc -l -c CLAUDE.md`                                                            | repo                |
| `AGENTS.md` (via `` `@AGENTS.md` ``, 1 hop)                         |     234 |     27.155 |      7.759 |     6.789 | `wc -l -c AGENTS.md`                                                            | repo                |
| **Subtotal do repo**                                                | **241** | **27.868** |  **7.962** | **6.967** |                                                                                 | **alvo desta SPEC** |
| Marcadores HTML do bloco `nextjs-agent-rules`                       |       2 |        −64 |        −18 |       −16 | doc §4 item 7 (removidos antes de entrar)                                       | repo                |
| `.claude/rules/*.md` sem `paths:`                                   |       0 |          0 |          — |         — | `ls .claude/rules` → não existe                                                 | repo                |
| `.claude/CLAUDE.md`, `CLAUDE.local.md`                              |       0 |          0 |          — |         — | `test -f` → não existem                                                         | repo                |
| `.cursor/rules/*.mdc` (`alwaysApply: true`)                         |       0 |          0 |          — |         — | `test -d .cursor` → não existe                                                  | repo                |
| `CLAUDE.md`/`AGENTS.md` aninhados                                   |       0 |          0 |          — |         — | `find . -name CLAUDE.md -o -name AGENTS.md` (sem `node_modules`/`.git`/`.next`) | repo                |
| `~/.claude/CLAUDE.md` do usuário                                    |       4 |        822 |        235 |       206 | `wc -l -c "$USERPROFILE/.claude/CLAUDE.md"`                                     | **fora**            |
| Memória automática (`MEMORY.md` do projeto)                         |      45 |      9.832 |      2.809 |     2.458 | `wc -l -c .../memory/MEMORY.md`                                                 | **fora** — achado   |
| Descrições de skills do usuário/plugins                             |       ? |          ? |          ? |         ? | só no `/context`                                                                | **fora**            |
| Ferramentas MCP (`vn`, `rs`, conectores claude.ai, github, chrome…) |       ? |          ? |          ? |         ? | só no `/context`                                                                | **fora** — achado   |

**Achados de (a):**

1. **A memória automática pesa 35% do `AGENTS.md`** e carrega sempre (doc: "first 200 lines or 25KB"). Fora do escopo; candidata a `/consolidate-memory` (D-28).
2. **MCPs:** nesta sessão (app desktop), as ferramentas MCP aparecem **adiadas** (`ToolSearch`): só os **nomes** ficam no contexto até serem carregadas. Contados na lista desta sessão: `vn` 21, `rs` 21, dois conectores Supabase do claude.ai **identificados só por UUID** (`391de7ed-d08c-41cc-a9b3-6ca153b060aa`, 23 ferramentas, com `*_storage_*`; `f1845579-3515-4fcf-ab27-984a6d31d5eb`, 21), `github-mcp` 26, `claude-in-chrome` 22, além de `ccd_*`. O peso real só o `/context` mostra. **Consequência para o invariante 1:** no app desktop o `ranch` **não aparece pelo nome** — é um dos dois UUIDs, e esta sessão não pode descobrir qual sem chamá-lo (proibido). Ver D-16/D-18.
3. **Pendente (mantenedor):** colar na ratificação a saída de `/context` de uma sessão **nova** neste repo, e de `claude mcp list`.

### 2.2 (b) Raio-X do `AGENTS.md` por seção

Comando: `LC_ALL=C awk` por cabeçalho `## ` (bytes = `length($0)+1`), soma conferida = 27.155 B.

| Seção (linhas)                                        |  Linhas |      Bytes |     % | Classificação                                                                                                                                    |
| ----------------------------------------------------- | ------: | ---------: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cabeçalho (L1–9)                                      |       9 |        634 |  2,3% | INEGOCIÁVEL (identidade, links do repo) — condensar                                                                                              |
| Créditos (L10–15)                                     |       6 |        522 |  1,9% | INEGOCIÁVEL (invariante 8) — **intacto**                                                                                                         |
| Stack (L16–30)                                        |      15 |      1.010 |  3,7% | ENVELHECE (versões → `status.md`) + **INCORRETO** parcial: "Turbopack" vale só para `dev`; `build` = `next build --webpack` (`package.json` L32) |
| Mapa do repositório (L31–57)                          |      27 |      1.497 |  5,5% | ROTEÁVEL (→ `INDEX.md`) + **INCORRETO**: L50 `001 → 054` (disco: 089); L55 `scripts/` lista 1 de 5; omite `(platform)/admin`, `blocked`, `auth/` |
| Onde mexer (L58–74)                                   |      17 |      1.630 |  6,0% | ROTEÁVEL (→ `INDEX.md`) — omite 15 módulos de `src/lib/` (§2.4)                                                                                  |
| Rotas de cron (L75–88)                                |      14 |        828 |  3,0% | ROTEÁVEL (→ `automacoes-cron.md`) + **INCORRETO**: "Três rotas" (disco: 7)                                                                       |
| Convenções — clientes Supabase (L91–97)               |       7 |       ~990 |  3,6% | INEGOCIÁVEL (invariante 4) — condensar; detalhe → `supabase-rls-mcp.md`                                                                          |
| Convenções — i18n (L99–104)                           |       6 |       ~760 |  2,8% | INEGOCIÁVEL (invariante 5) — L102 "~1.600 chaves" **INCORRETO** (3.550) → `status.md`                                                            |
| Convenções — API pública (L106–111)                   |       6 |     ~1.330 |  4,9% | ROTEÁVEL (→ rule + `api-publica-webhooks.md` + skill); fica 1 linha no root (caso "arquivo novo")                                                |
| Convenções — lógica em `src/lib` (L113)               |       1 |       ~230 |  0,8% | INEGOCIÁVEL (invariante 6)                                                                                                                       |
| Convenções — migrações (L115)                         |       1 |        415 |  1,5% | INEGOCIÁVEL curto (invariante 10) + ROTEÁVEL (→ `supabase-rls-mcp.md` + skill)                                                                   |
| Convenções — projetos Supabase (L117)                 |       1 |       ~190 |  0,7% | INEGOCIÁVEL (regra) + ENVELHECE/**INCORRETO** (lista `vn`/`rs`/`jh` × `.mcp.json` só com `vn`/`rs`)                                              |
| Convenções — Git (L119)                               |       1 |       ~140 |  0,5% | INEGOCIÁVEL (invariante 2)                                                                                                                       |
| Armadilhas conhecidas (L123–136)                      |      14 |      1.324 |  4,9% | INEGOCIÁVEL **por dependência**: 23 arquivos de `src/` citam "armadilha … do AGENTS.md" (§2.6)                                                   |
| Validação local (L137–158)                            |      22 |      1.226 |  4,5% | INEGOCIÁVEL (1 linha, invariante 7) + DUPLICADO (tabela já está em `docs/comandos-desenvolvimento.md` e no README)                               |
| Índice da documentação (L159–226)                     |      68 |     14.272 | 52,6% | CATÁLOGO (→ `catalogo-specs.md`)                                                                                                                 |
| Diretrizes técnicas / `nextjs-agent-rules` (L227–234) |       8 |        353 |  1,3% | INEGOCIÁVEL (invariante 3) — **byte a byte**                                                                                                     |
| **Total**                                             | **234** | **27.155** |  100% |                                                                                                                                                  |

**10 linhas mais longas** (`LC_ALL=C awk '{print length($0)"\tL"NR}' AGENTS.md | sort -rn | head -10`): L110 520 B (openapi pt-BR) · L12 501 B (créditos) · L115 415 B (migrações) · L111 350 B (paridade openapi) · L214 346 B · L208 333 B · L212 326 B · L165 312 B · L211 297 B · L206 293 B (as seis últimas são linhas do Índice).

Formato: `AGENTS.md` e `CLAUDE.md` são UTF-8, LF, 0 `\r` (`tr -cd '\r' < f | wc -c`).

### 2.3 (c) Inventário de `docs/`

| Medida                                                 | Valor                                                                                   | Comando                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Arquivos em `docs/` (sem `docs/deploy/`)               | 131 (118 `.md`)                                                                         | `find docs -type f ! -path 'docs/deploy/*' \| wc -l`             |
| Bytes                                                  | ~3,08 MB                                                                                | `du -sb docs`                                                    |
| Arquivos `spec-0NN-*` / `prd-0NN-*` na raiz de `docs/` | 40 / 6                                                                                  | `ls docs \| grep -cE '^spec-[0-9]'`                              |
| Numeração 040–078 (`spec-` ∪ `prd-`)                   | **contígua, sem lacuna**                                                                | `ls docs \| grep -E '^(spec\|prd)-[0-9]{3}' \| sed … \| sort -u` |
| PRDs                                                   | 047, 058, 061, 068, 072, 077                                                            | idem                                                             |
| `docs/references/`                                     | 6 arquivos, 177.555 B                                                                   | `wc -c docs/references/*`                                        |
| `docs/otimizacao-de-contexto-ia/`                      | 46 arquivos, 170.679 B — **já versionada** (commits `fb317ab`, `e1eb16d`)               | `find … \| wc -l`, `du -sb`                                      |
| Arquivos rastreados pelo git (repo todo)               | **1.144** (pista dizia 1.098 — mudou com os 2 commits de hoje)                          | `git ls-files \| wc -l`                                          |
| `.md` de `docs/` rastreados                            | **118** (pista: 85)                                                                     | `git ls-files 'docs/**/*.md' \| wc -l`                           |
| Não-`.md` de `docs/` rastreados                        | sim (`.sql`, `.csv`, `.xlsx`, `.sh`, `.mdc`, `.json`) — a regra `*.md` nunca os ignorou | `git ls-files docs \| grep -v '\.md$'`                           |

Maiores (bytes): spec-045 147.953 · spec-044 141.960 · spec-076 106.131 · spec-069 103.935 · prd-047 95.242 · spec-066 80.331 · spec-064 70.067 · spec-043 68.635 · guia-console 65.347 · spec-049 64.458.

**Índice × disco** (63 links únicos de `AGENTS.md`/`CLAUDE.md`, extraídos com `grep -oE '\]\(\./[^)]+\)'`):

- **Quebrados: 0** (`test -e` em cada um).
- **No disco e fora do índice:** `spec-076-monitor-cobranca-whatsapp-cloud-api.md` (106 KB — 076 **não** é lacuna), `spec-060-teste-manual.md`, `spec-064-teste-manual.md`, `spec-078-teste-manual.md`, `plano-implantacao-vps-zap-local-ia-br.md`, `prompt-sessao-spec-062-f1.md`, `prompt-sessao-spec-062-f7.md`, `prompt-sessao-spec-069-f1-f2.md`, `prompt-spec-076-f3.md`, `prompt-spec-079-otimizacao-de-contexto-ecc.md`; pastas `docs/prompt/` (3), `docs/spec-052-teste-manual/` (6), `docs/otimizacao-de-contexto-ia/` (46), `docs/deploy/` (segredo — nunca listar conteúdo).

### 2.4 (d) Mapa real do código para os globs

`ls` das pastas (resumo do que **existe**):

- `src/lib/`: account, activity, ai, api, api-keys, audience, auth, automations, broadcasts, channels, contacts, dashboard, emoji, evolution, flows, http, i18n, inbox, ingest, limits, mailer, messages, notifications, phone, pipelines, plans, platform, retention, spreadsheet, storage, supabase, webhooks, whatsapp + arquivos soltos (`presence.ts`, `meta-errors.ts`, `rate-limit.ts`, `tags.ts`, …).
- `src/app/`: `(auth)`, `(dashboard)`, `(platform)/admin`, `api`, `auth`, `blocked`, `join`. **Middleware:** `src/middleware.ts` (não há `proxy.ts`).
- `src/app/api/`: account, admin, ai, automations, broadcasts, channels, contacts, evolution, flows, import, inbox, invitations, messages, plans, platform, quick-replies, v1, whatsapp.
- `supabase/migrations/`: 89 `.sql` + `README.md` (última: `089_console_billing_and_identity.sql`; há `084b_*`; não há `043_*` — documentado no README da pasta). `supabase/setup/`: `cron-jobs.sql`, `orphan-media-cleanup.sql`, `plans-seed.sql`, `plans-seed-vn.sql`, `plans-seed-rs.sql`.
- `scripts/`: `check-i18n-parity.mjs`, `evolution-probe.mjs`, `sync-emojibase.mjs`, `verify-039-rls.sql`, `verify-040-media.sql`.
- `n8n_automation/`: 4 arquivos (1 ocorrência de `REDACTED` no workflow). `docker/`: `runtime-env.mjs`. `mcp-server/src/`: 8 rastreados.

**Cada glob proposto no §5.4 casa ≥ 1 arquivo** — medido com `git ls-files -- '<glob>' | wc -l` para pastas rastreadas e `ls` para as ignoradas (`supabase/migrations/*.sql` 89, `supabase/setup/*.sql` 5, `scripts/*` 5, `n8n_automation/*` 4). O menor casamento é 1 (`src/components/channels/**`, `src/app/api/import/**`, `src/app/blocked/**`, `src/components/email-spam-notice.tsx`, `src/middleware.ts`).

**Rotas de cron** (`git ls-files 'src/app/api/**/cron/route.ts'`): **7** — `automations`, `broadcasts`, `contacts/check`, `contacts/harvest`, `flows`, `messages/retention`, `plans/lifecycle`. Todas leem `x-cron-secret` e todas têm o ramo `503` (`grep -c`); exemplo lido: `src/app/api/flows/cron/route.ts:34` responde `{ error: 'cron not configured' }, { status: 503 }`. As 7 aparecem em `supabase/setup/cron-jobs.sql` (4 delas em blocos comentados, opcionais).

**i18n:** `messages/en.json` e `pt-BR.json` têm **3.550 folhas** cada (`node -e` contando folhas). **Versões** (`package.json`): next 16.2.6, react 19.2.4, typescript ^6, next-intl ^4.13.1, vitest ^4.1.9, node `>=20.0.0` — batem com a tabela Stack.

**Convenção de privilégios de função** (derivada só de trechos — `grep -n -B2 -A10 'DEFAULT PRIVILEGES' supabase/migrations/044_*.sql`):

- 044 L131–142: "`REVOKE ... FROM PUBLIC` sozinho NÃO basta neste banco: o Supabase mantém ALTER DEFAULT PRIVILEGES concedendo EXECUTE a `anon` e `authenticated`… concessão nominal, não herdada de PUBLIC"; seguido de `REVOKE ALL … FROM PUBLIC;` **e** `REVOKE ALL … FROM anon;`, mantendo `authenticated` quando "a rota chama como o usuário". O mesmo comentário aparece em 044, 045, 047, 048, 053, 072.
- Contagens (`grep -ho … | wc -l`, por linha): `REVOKE … FROM PUBLIC` 71 em 35 arquivos; `FROM anon` 47; `FROM authenticated` 14; `FROM anon, authenticated` 6; `SECURITY DEFINER` 146. Função interna (trigger) revoga os três: `084b` L35–37 (`PUBLIC`, `anon`, `authenticated`).
- **Achado que muda uma regra pedida:** `is_account_member` (017 L167, 069 L143) e `can_access_conversation`/`can_write_conversation`/`can_access_contact_notes` (039 L167/193/237) têm **só** `GRANT EXECUTE … TO authenticated, service_role` — **nenhum `REVOKE` de `PUBLIC` nem de `anon`** nas migrações. Pela própria nota da 044, `anon` provavelmente mantém `EXECUTE` neles pelos default privileges. Logo "policy com esses predicados vai em `TO authenticated`" **não** decorre de ACL; é defesa em profundidade (a guarda depende de `auth.uid()`, nulo para `anon`). Confirmar a ACL real no GO, no projeto escolhido, com `has_function_privilege('anon', 'public.is_account_member(uuid, account_role_enum)', 'EXECUTE')` (D-20).
- `supabase/migrations/README.md` (1,3 KB) documenta **só numeração e a ausência da 043** — não privilégios. O domínio aponta para ele na numeração e documenta privilégios por conta própria.

### 2.5 (e) Estado atual de rules/skills

`ls -la .claude` (sem ler `settings.local.json`): `launch.json` (203 B), `settings.json` (9.240 B), `settings.local.json` (20.350 B — não lido), `worktrees/docker-optimize-gitignore-3becc9/` (worktree de outra sessão — a pista dizia "sem `worktrees/`"). **Sem** `rules/`, `skills/`, `CLAUDE.md`. `.cursor/` não existe.

`settings.json` (lido, não é segredo): só `permissions.allow` (53 entradas `Bash(…)` + PowerShell/WebFetch) e `additionalDirectories`; **sem `deny`**. Duas entradas pedem atenção: um `awk` que lê `.env.local` (imprime só nomes e comprimentos, não valores) e caminhos absolutos de **outro** checkout (`e:\Documentos\0004_GitHub\zap-crm-br`) — motivo de D-6.

### 2.6 (f) Integridade de links e quem cita o `AGENTS.md`

- Links relativos de `AGENTS.md`/`CLAUDE.md` quebrados: **0**.
- `grep -rln "AGENTS.md" docs README.md CONTRIBUTING.md CHANGELOG.md mcp-server n8n_automation scripts src --exclude-dir=node_modules`: **101 arquivos** (a pista dizia 44 sem `src/`). Classificação:

| Grupo                                      | Qtde | Tipo de citação                                                                                                                                                             | Ação                                                                                                                                                   |
| ------------------------------------------ | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/otimizacao-de-contexto-ia/**`        |   33 | genérica (tutorial)                                                                                                                                                         | nenhuma                                                                                                                                                |
| Prompts (`docs/prompt*`)                   |    8 | histórica                                                                                                                                                                   | nenhuma                                                                                                                                                |
| SPECs/PRDs/guias/`public-api.md`/`context` |   37 | histórica; 4 nomeiam seção (065-plano, 057, 063, 066)                                                                                                                       | nenhuma — as seções citadas mantêm título (D-25)                                                                                                       |
| **`src/**`**                               |   23 | **"armadilha … do AGENTS.md"** (12), "service_role não roda no browser" (2), "`/api/**` fala inglês" (3), "lógica em `src/lib/`"/"adicione o teste" (5), "falha silenciosa" | **não podem quebrar** — `src/` é intocável → as seções **Armadilhas conhecidas** e **Convenções obrigatórias** ficam no `AGENTS.md` com o mesmo título |

### 2.7 (g) Crédito e licença

`LICENSE` = MIT, "Copyright (c) 2026 Arnas Donauskas" (lido o cabeçalho). O `CLAUDE.md` diz "consulte a seção de créditos em `AGENTS.md`" → a seção `## Créditos` (L10–12, 501 B na linha do blockquote) fica **intacta e com o mesmo título** (D-3). `LICENSE` não é tocado.

### 2.8 (h) Versionamento, ignore e Docker

`git check-ignore -v --no-index <caminho>` (estado atual):

| Caminho-alvo                                                                                              | Resultado                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `CLAUDE.md`, `AGENTS.md`                                                                                  | ignorado — `.gitignore:6:*.md`                  |
| `docs/context/x.md`, `docs/context/INDEX.md`, `docs/spec-079-x.md`                                        | **rastreável** — `.gitignore:10:!/docs/**/*.md` |
| `.claude/rules/x.md`, `.claude/skills/x/SKILL.md`, `.claude/settings.json`, `.claude/settings.local.json` | ignorado — `.gitignore:61:/.claude`             |
| `.cursor/rules/x.mdc`                                                                                     | **rastreável** (nenhuma regra)                  |
| `scripts/x.mjs`                                                                                           | ignorado — `.gitignore:66:/scripts`             |
| `docs/deploy/x.yml`                                                                                       | ignorado — `.gitignore:15:/docs/deploy/`        |
| `supabase/…`, `n8n_automation/…`                                                                          | ignorado — `.gitignore:5` / `:4`                |
| `.mcp.json`, `.env.local`                                                                                 | ignorado — `:63` / `:48`                        |

**Incoerência central:** `docs/context/**` vai para o git; o roteador (`CLAUDE.md`/`AGENTS.md`) e as rules/skills (`.claude/`) que apontam para ele **não**. Num clone novo existem os destinos e não existe quem aponte para eles.

**Rollback:** `git revert` serve para F1/F2 (`docs/context/`); **não** alcança F3/F4/F5 enquanto `.claude/`, `CLAUDE.md` e `AGENTS.md` forem ignorados → backup datado fora do repo + manifesto `sha256sum` (F0).

**Opção (b) — diff proposto do `.gitignore` (não aplicado):**

```diff
 *.md
 # docs/ é versionada (SPECs, PRDs, guias) — a exceção abaixo libera os .md
 # dela, que a regra `*.md` acima esconderia. A imagem Docker não leva docs/:
 # o .dockerignore é uma allowlist que nunca a inclui.
 !/docs/**/*.md
+!/CLAUDE.md
+!/AGENTS.md
 # Stack de produção com segredos reais (…) — NUNCA versionar. Fica por último
 /docs/deploy/
 …
 # Claude Code local — credenciais e configurações locais
-/.claude
+/.claude/*
+!/.claude/rules/
+!/.claude/skills/
+!/.claude/rules/**/*.md
+!/.claude/skills/**/*.md
 .claude/mcp.json
 .mcp.json
```

**Prova regra a regra** — simulação num repositório descartável em `$SCR/sim-b` (fora do repo: `git init` + o `.gitignore` proposto + arquivos vazios + `git check-ignore -v`):

| Caminho                                                                       | Resultado na (b)                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CLAUDE.md` / `AGENTS.md` (raiz)                                              | rastreável — `:11:!/CLAUDE.md` / `:12:!/AGENTS.md`                     |
| `README.md`, `CHANGELOG.md`, `src/x.md`                                       | **continua ignorado** — `:6:*.md` (só a raiz exata é reaberta)         |
| `.claude/rules/x.md`, `.claude/rules/sub/y.md`                                | rastreável — `:66:!/.claude/rules/**/*.md`                             |
| `.claude/skills/x/SKILL.md`, `…/references/r.md`                              | rastreável — `:67:!/.claude/skills/**/*.md`                            |
| `.claude/settings.json`, `settings.local.json`, `launch.json`, `worktrees/**` | **ignorado** — `:63:/.claude/*`                                        |
| `.claude/mcp.json`, `.mcp.json`                                               | ignorado — `:68`, `:69`                                                |
| `.env.local`                                                                  | ignorado — `:50:.env*`                                                 |
| `docs/deploy/stack-zapcrm.yml`, `docs/deploy/x.md`                            | ignorado — `:17:/docs/deploy/` (vence `!/docs/**/*.md` por vir depois) |
| `supabase/…`, `scripts/…`, `n8n_automation/…`                                 | ignorado                                                               |

Por que funciona: `/.claude/*` ignora os **filhos** (não o diretório), então `!/.claude/rules/` consegue reincluir a pasta (o git não reinclui arquivo cujo diretório-pai foi excluído); as reaberturas `!…/**/*.md` vêm **depois** de `*.md` (a última que casa vence). `.claude/settings.json` **não** é reaberto (D-6). Opção (a) = `.gitignore` inalterado.

**Busca do Claude Code (`.ignore`) — achado que corrige a pista:**

| Ferramenta              | Comportamento medido nesta sessão                                                                                                                                         | Doc                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Grep (raiz)             | `cron-jobs` → 20 arquivos, **nenhum** em `supabase/`, e nem `AGENTS.md`/`README.md` (ignorados por `*.md`); `ALTER DEFAULT PRIVILEGES` → 3 arquivos, **nenhuma** migração | "Grep respects `.gitignore`, so gitignored files are skipped. To search a gitignored file, Claude passes its path directly." |
| Grep (`path: supabase`) | `x-cron-secret` → `supabase/setup/cron-jobs.sql`                                                                                                                          | idem                                                                                                                         |
| Glob                    | `supabase/migrations/*.sql` → 89; `scripts/*.mjs` → 3; `*.md` → inclui `node_modules/**`                                                                                  | "Glob doesn't respect `.gitignore` by default" (`CLAUDE_CODE_GLOB_NO_IGNORE=false` muda)                                     |

Logo o risco real é o **Grep na raiz** (não o Glob): um agente procurando `REVOKE` ou `cron-jobs` não encontra `supabase/`, `scripts/`, `n8n_automation/` nem os `.md` da raiz. Diff proposto do `.ignore` (D-7; não afeta git nem Docker):

```diff
 !/docs
 !/docs/**
+!/supabase
+!/supabase/**
+!/scripts
+!/scripts/**
+!/n8n_automation
+!/n8n_automation/**
+!/AGENTS.md
+!/CLAUDE.md
```

(As duas últimas só são necessárias na opção (a); na (b) o `.gitignore` já as reabre. `docs/deploy/` continua fora? **Não** — `!/docs/**` do `.ignore` atual já reabre `docs/deploy/` para o Grep. Ver risco R-9 e o `deny` de D-17, que bloqueia a leitura.)

**Docker:** `.dockerignore` é allowlist (`*` + `!package.json !package-lock.json !next.config.ts !tsconfig.json !postcss.config.mjs !src !public !messages !docker`, com `**/*.md` e `**/.env*` no fim). `docs/`, `.claude/`, `.cursor/`, `*.md` **não entram** na imagem pública → risco de vazamento por esta SPEC = **baixo**. Arquivo novo na raiz não entra sozinho (regra do próprio arquivo).

**Finais de linha:** `git config --show-origin core.autocrlf` → `file:C:/Program Files/Git/etc/gitconfig true` (**definido no nível do sistema**, não no repo). Não há `.gitattributes` na raiz (só em `docs/otimizacao-de-contexto-ia/`). `git ls-files --eol 'docs/**'`: 116 `w/lf`, **13 `w/crlf`**, 2 `-text`. Ver D-14.

### 2.9 (i) Formatação (Prettier)

| Medida                                                                     |                                                                                Valor | Comando                                        |
| -------------------------------------------------------------------------- | -----------------------------------------------------------------------------------: | ---------------------------------------------- |
| `npx prettier --list-different .` (respeita `.gitignore`)                  |                                                                               **50** | gravado em `$SCR/prettier-base.txt`            |
| … dos quais em `docs/`                                                     |                                                                                   49 | `grep -c '^docs/'`                             |
| … fora de `docs/`                                                          |                                   1 (`docker/runtime-env.mjs`, `w/lf` — estilo real) |                                                |
| … das 49 em `docs/`, com working tree CRLF (`autocrlf=true`)               |                                                                                   10 | `git ls-files --eol` ∩ lista                   |
| `.md` da raiz checados de verdade (`--ignore-path .prettierignore '*.md'`) |                                                                      1 (`AGENTS.md`) | README, CHANGELOG, CONTRIBUTING, CLAUDE passam |
| `npx prettier --check AGENTS.md` (sem a opção)                             | "All matched files use Prettier code style!" — **falso negativo** (arquivo ignorado) |                                                |
| `npx prettier --check --ignore-path .prettierignore AGENTS.md`             |                                                                   `[warn] AGENTS.md` |                                                |

Consequência para F3–F6: todo `--check`/`--write` de `CLAUDE.md`, `AGENTS.md` e `.claude/**` usa `--ignore-path .prettierignore` (em `docs/` é inofensivo; usar sempre, por uniformidade). `.prettierignore` exclui `supabase/migrations` — irrelevante aqui.

---

## 3. ECC: o que adotar e o que não adotar

Fonte: README do [`affaan-m/ECC`](https://github.com/affaan-m/ECC) (lido em 2026-10-30; a listagem de arquivos do GitHub é parcial).

| Ideia do ECC                                                                | Adotar?             | Como entra aqui                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules segmentadas por tópico (`rules/common/` + pacotes por linguagem)      | **Sim, como ideia** | Lá, "Rules are always-loaded context". Aqui fazemos o oposto: **toda** rule tem `paths:` (§5.3) — o ganho é o escopo, não o tópico                  |
| Skills como pasta com `SKILL.md`                                            | **Sim**             | 5 skills de procedimento (§5.5), corpo com "Quando usar / Como funciona / Exemplos" (estrutura **nossa**; o README do ECC não mostra esses títulos) |
| Separar regra curta de conhecimento longo                                   | **Sim**             | rule (≤ 25 L) → `docs/context/<domínio>.md` (≤ 120 L) → SPEC/`references/`                                                                          |
| Plugin / marketplace (`/plugin install ecc@ecc`, `npx ecc-universal setup`) | Não                 | dependência externa; e "Claude Code plugins cannot distribute `rules`"                                                                              |
| `agents/` (71 subagentes), `commands/`, `hooks/`                            | Não                 | custo de contexto (descrições sempre carregadas) sem ganho para um mantenedor só                                                                    |
| Cópias multi-harness                                                        | Não                 | `AGENTS.md` em texto puro já é o canal cross-tool                                                                                                   |
| `INDEX.md` de roteamento tarefa → arquivo                                   | —                   | **Adaptação nossa.** Não encontrado no ECC (os mais próximos: `COMMANDS-QUICK-REF.md`, `rules/README.md`, o catálogo do README)                     |

---

## 4. Premissas técnicas verificadas

| #   | Premissa                                                                                           | Veredito                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fonte (lida em 2026-10-30)                                                             |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | Rule com `paths:` carrega só ao trabalhar com arquivo casante; sem `paths:` carrega na abertura    | **Confirmada.** "Rules without a `paths` field are loaded unconditionally"; "loaded at launch with the same priority as `.claude/CLAUDE.md`"                                                                                                                                                                                                                                                                                                                                                                                   | https://code.claude.com/docs/en/memory                                                 |
| 2   | Gatilho é leitura; arquivo novo pode não disparar                                                  | **Confirmada e ampliada:** dispara em **Read, Write ou Edit** e em Bash que "counts as a read" (`cat`/`head` num arquivo). Tarefa que só faz Grep/Glob ou cria arquivo fora dos globs **não** dispara. Arquivo **ignorado pelo git**: a doc não o exclui; **não verificado — testar no GO** (testes 2 e 10)                                                                                                                                                                                                                    | idem                                                                                   |
| 3   | `@` expande e sempre carrega; recursivo; `@` em code span não importa                              | **Confirmada:** "maximum depth of four hops"; "Import parsing skips Markdown code spans and fenced code blocks"                                                                                                                                                                                                                                                                                                                                                                                                                | idem                                                                                   |
| 4   | `AGENTS.md` nativo só sem `CLAUDE.md`; com `@AGENTS.md`, lê os dois sem duplicar                   | **Confirmada:** "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later"; com `CLAUDE.md` presente lê "Your `CLAUDE.md` files only"; com o import, "`AGENTS.md` included through the import". O CLI do Git Bash é **2.1.211** → o `` `@AGENTS.md` `` é **necessário** aqui de qualquer forma                                                                                                                                                                                                                      | idem                                                                                   |
| 5   | Cursor `.mdc`: `description`, `globs`, `alwaysApply`; formato de `globs`                           | **Confirmada:** `globs` é **string separada por vírgula** ("Separate multiple patterns with commas"); Cursor lê `AGENTS.md` na raiz e em subpastas; a página **não** diz se expande `@` — tratar como "não expande"                                                                                                                                                                                                                                                                                                            | https://cursor.com/docs/context/rules                                                  |
| 6   | Skills: `.claude/skills/<nome>/SKILL.md`; descrição sempre no contexto, corpo ao invocar           | **Confirmada:** "skill descriptions are loaded into context… full skill content only loads when invoked"; `description`+`when_to_use` truncados em 1.536 caracteres; arquivos de apoio carregam quando necessários. **Novo:** skill aceita `paths` (string ou lista)                                                                                                                                                                                                                                                           | https://code.claude.com/docs/en/skills                                                 |
| 7   | Comentários HTML removidos; `paths` é o único campo; YAML inválido → carrega sempre; escape de `[` | **Confirmada:** "Block-level HTML comments… are stripped"; "`paths` is the only field Claude Code reads from a rule"; YAML que não parseia → "loads the rule as if it had no `paths`"; `[` literal → `\[`. Parênteses em glob: a doc **não** fala → **não verificado**; evitamos (§5.4, D-24)                                                                                                                                                                                                                                  | https://code.claude.com/docs/en/memory                                                 |
| 8   | Grep/Glob respeitam `.gitignore`/`.ignore`; Read direto funciona                                   | **Parcialmente refutada:** Grep respeita; **Glob não** (por padrão). Read direto funciona (as SQL desta SPEC foram lidas assim)                                                                                                                                                                                                                                                                                                                                                                                                | https://code.claude.com/docs/en/tools-reference                                        |
| 9   | `permissions.deny` aceita `Read(<glob>)`, `Bash(<prefixo>:*)`, `mcp__<servidor>`; deny vence       | **Confirmada:** "evaluated in order: deny, then ask, then allow"; `Bash(ls:*)` ≡ `Bash(ls *)` (o diálogo grava a forma com espaço); `mcp__puppeteer` cobre o servidor; deny/ask "apply right away" (sem esperar trust). **Ressalvas:** Bash deny "isn't a security boundary" (casa a forma usual do comando); Read deny vale "best-effort" para Grep/Glob, não para qualquer Bash; conectores buscados pelo Claude Code aparecem como `mcp__claude_ai_<server>__<tool>`, mas **no app desktop desta sessão aparecem por UUID** | https://code.claude.com/docs/en/permissions · https://code.claude.com/docs/en/settings |
| 10  | `CLAUDE.md` em subpasta carrega sob demanda                                                        | **Confirmada:** "loads each one once Claude reads, writes, or edits another file in that subdirectory". **Por que rules e não `CLAUDE.md` aninhados:** um glob fino (`src/app/api/**/cron/route.ts`) atravessa pastas que um `CLAUDE.md` por diretório não alcança, todas ficam num lugar só (medir/espelhar para o Cursor), e `CLAUDE.md` em `supabase/` seria ignorado pelo git do mesmo jeito                                                                                                                               | https://code.claude.com/docs/en/memory                                                 |

Extra (settings): `disableClaudeAiConnectors: true` é honrado "from any scope" — desliga **todos** os conectores claude.ai no projeto (base de D-18).

---

## 5. Arquitetura-alvo e orçamento

### 5.1 Árvore

```text
CLAUDE.md                        ≤ 15 L   `@AGENTS.md` + extras só do Claude (skills, permissions.deny, /context)
AGENTS.md                        ≤ 150 L  roteador cross-tool em texto puro (§5.2)
docs/context/
  INDEX.md                       ≤ 100 L  mapa do repo + tarefa → domínio → rule/skill
  status.md                      ≤ 80 L   ÚNICO lugar de fato que envelhece (datado)
  catalogo-specs.md              livre    o antigo "Índice da documentação", completo
  whatsapp-cloud.md              ┐
  canais-e-qrcode.md             │
  inbox-atribuicao.md            │
  automacoes-cron.md             │
  flows.md                       │
  contatos-audiencia.md          │
  supabase-rls-mcp.md            │ 15 domínios, cada um ≤ 120 L / ≤ 6 KB
  i18n.md                        │
  api-publica-webhooks.md        │
  planos-quotas-admin.md         │
  atividade-painel-retencao.md   │
  notificacoes-smtp.md           │
  auth-e-conta.md                │
  ia-agentes.md                  │
  deploy-docker.md               ┘
  phone-number-format-standard.md   já existe — referenciado, não movido
.claude/rules/<domínio>.md       15 × ≤ 25 L, SEMPRE com paths:
.claude/skills/<nome>/SKILL.md   5 × ≤ 100 L (+ references/ quando houver)
.cursor/rules/                   não criado (D-9)
```

Opção (b) do §2.8 não é pré-requisito da arquitetura; muda só o que vai para o git.

### 5.2 O que fica no `AGENTS.md` (≤ 150 linhas, ordem)

1. Título + 2 linhas de identidade + 4 links (mantenedor, original) — ~600 B.
2. `## Créditos` — **intacto** (522 B).
3. `## Como navegar` — 4 linhas: leia `docs/context/INDEX.md` para achar o domínio; fatos mutáveis em `docs/context/status.md`; catálogo em `docs/context/catalogo-specs.md`; nunca confie em número escrito aqui. ~450 B.
4. `## Convenções obrigatórias` — os inegociáveis 1, 2, 4, 5, 6, 9, 10 + linha de `/api/v1` + linha de migração (§6). ~3.300 B.
5. `## Armadilhas conhecidas` — mesma tabela, células enxutas (citada por 23 arquivos de `src/`). ~1.000 B.
6. `## Validação local` — o comando em uma linha + ponteiro para `docs/comandos-desenvolvimento.md`. ~350 B.
7. `## Diretrizes técnicas` + bloco `nextjs-agent-rules` **byte a byte** (353 B).

**Decisão D-1 (recomendada: opção a).** Os inegociáveis moram **direto** no `AGENTS.md` e **não existe** `docs/context/core.md`. Cursor e Codex leem o `AGENTS.md` e não expandem `@`; um `core.md` puxado por `@` só no `CLAUDE.md` deixaria o Cursor sem nenhum deles. Fonte única, zero espelho.

### 5.3 Rules — formato

```markdown
---
paths:
  - 'supabase/**'
  - 'src/lib/supabase/**'
  - 'scripts/verify-*.sql'
---

# Supabase, RLS e migrações

- Próximo número: `ls supabase/migrations/` (fatos vivos em `docs/context/status.md`).
- Função nova em `public`: `REVOKE ALL … FROM PUBLIC` **e** `FROM anon` (+ `FROM authenticated` se interna); `GRANT EXECUTE … TO authenticated` só se a sessão chama.
- …(≤ 25 linhas)…

Detalhe: leia `docs/context/supabase-rls-mcp.md`. Procedimento: skill `nova-migracao-supabase`.
```

Regras de ouro: (1) **toda** rule tem `paths:` — rule sem `paths:` vira contexto fixo; (2) YAML com aspas simples em cada glob; (3) nenhum `@` fora de backticks; (4) a rule **não copia** o domínio, só decide e aponta.

### 5.4 Domínios — origem e globs reais

Todos os globs casam ≥ 1 arquivo (§2.4). **Sem parênteses nem colchetes** (D-24): `(platform)/admin` vira `src/app/*/admin/**`; rotas `[id]` são cobertas por `**`.

| Domínio (`docs/context/` + `.claude/rules/`) | `paths:` da rule                                                                                                                                                                                                                                        | Origem (AGENTS.md / docs)                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `whatsapp-cloud`                             | `src/lib/whatsapp/**`, `src/app/api/whatsapp/**`, `src/lib/broadcasts/**`, `src/components/broadcasts/**`, `src/lib/meta-errors.ts`                                                                                                                     | L62–64; SPEC 064, 065, 070, 076, `teste-ab-disparos.md`, `issues_resolved/2026-07-*`                                                                               |
| `canais-e-qrcode`                            | `src/lib/channels/**`, `src/lib/evolution/**`, `src/app/api/channels/**`, `src/app/api/evolution/**`, `src/components/channels/**`, `scripts/evolution-probe.mjs`                                                                                       | PRD 047/068, SPEC 048/049/056/069; `docs/references/EVOLUTION_GO_REFERENCE.md` (⚠️ incompleta), `evolution-go-*.md`, `evolution_go_crm_spec.md`                    |
| `inbox-atribuicao`                           | `src/lib/inbox/**`, `src/components/inbox/**`, `src/app/api/inbox/**`, `src/lib/presence.ts`, `src/lib/emoji/**`, `src/lib/storage/**`, `src/lib/pipelines/**`, `src/lib/tags.ts`                                                                       | L67; SPEC 040–043, `spec-inbox-*`, `spec-settings-tag-editing.md`, 066, 067, 074                                                                                   |
| `automacoes-cron`                            | `src/lib/automations/**`, `src/components/automations/**`, `src/app/api/**/cron/route.ts`, `supabase/setup/cron-jobs.sql`                                                                                                                               | L65, L75–85, L129; SPEC 045, 046; README §"Agendador cron"                                                                                                         |
| `flows`                                      | `src/lib/flows/**`, `src/components/flows/**`, `src/app/api/flows/**`                                                                                                                                                                                   | L66; `docs/references/flows-forms-lib-architecture.md`                                                                                                             |
| `contatos-audiencia`                         | `src/lib/contacts/**`, `src/lib/audience/**`, `src/lib/ingest/**`, `src/lib/phone/**`, `src/lib/spreadsheet/**`, `src/app/api/import/**`, `src/app/api/contacts/**`, `src/components/contacts/**`, `src/components/import/**`, `n8n_automation/**`      | L68; SPEC 044, 050–052, 055, 057, 071; `docs/context/phone-number-format-standard.md`, `docs/references/mobile_number_brasil_guide.md`, `n8n_automation/README.md` |
| `supabase-rls-mcp`                           | `supabase/**`, `src/lib/supabase/**`, `scripts/verify-*.sql`                                                                                                                                                                                            | L91–97, L115, L117, L132–133; PRD 077; `supabase/migrations/README.md`; §2.4 desta SPEC                                                                            |
| `i18n`                                       | `messages/*.json`, `src/i18n/**`, `src/lib/i18n/**`, `scripts/check-i18n-parity.mjs`                                                                                                                                                                    | L99–104, L127–130; `docs/i18n-implementation-report.md`; README §i18n                                                                                              |
| `api-publica-webhooks`                       | `src/lib/api/v1/**`, `src/app/api/v1/**`, `src/lib/api-keys/**`, `src/lib/webhooks/**`, `public/openapi*.json`, `docs/public-api.md`, `mcp-server/src/**`, `docs/mcp.md`                                                                                | L71–72, L106–111; `docs/public-api.md`, `docs/mcp.md`                                                                                                              |
| `planos-quotas-admin`                        | `src/lib/plans/**`, `src/lib/limits/**`, `src/lib/platform/**`, `src/app/*/admin/**`, `src/app/api/admin/**`, `src/app/api/platform/**`, `src/app/blocked/**`, `src/components/platform/**`, `src/components/plan/**`, `supabase/setup/plans-seed*.sql` | PRD 058/061/072, SPEC 059/062/073/078 + testes manuais, guias de operação e do console                                                                             |
| `atividade-painel-retencao`                  | `src/lib/retention/**`, `src/lib/activity/**`, `src/lib/dashboard/**`, `src/components/retention/**`, `src/components/activity/**`                                                                                                                      | L73; SPEC 060, 075 (074 fica em inbox)                                                                                                                             |
| `notificacoes-smtp`                          | `src/lib/mailer/**`, `src/lib/notifications/**`, `src/components/email-spam-notice.tsx`                                                                                                                                                                 | SPEC 063; `docs/templates_email_send/`                                                                                                                             |
| `auth-e-conta`                               | `src/lib/auth/**`, `src/app/*/login/**`, `src/app/*/signup/**`, `src/app/*/reset-password/**`, `src/app/auth/**`, `src/app/join/**`, `src/middleware.ts`                                                                                                | L35, L37, L42, L70, L133; SPEC 053/054                                                                                                                             |
| `ia-agentes`                                 | `src/lib/ai/**`, `src/components/agents/**`, `src/app/api/ai/**`                                                                                                                                                                                        | L69; `docs/references/agents-ai-components-architecture.md`                                                                                                        |
| `deploy-docker`                              | `Dockerfile`, `docker/**`, `next.config.ts`, `.dockerignore`                                                                                                                                                                                            | L131; `docs/plano-implantacao-vps-zap-local-ia-br.md`; `docs/deploy/` **só** como "existe e tem segredo — não ler"                                                 |

(Os globs `src/app/*/login/**` etc. substituem `src/app/(auth)/**` e precisam do mesmo teste de casamento na F3.)

### 5.5 Skills (Claude Code apenas)

| Skill                    | Gatilhos na `description` (≤ ~240 B)                                      | Corpo (≤ 100 L)                                                                                                                                                                                                                                                             | `references/`                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `nova-migracao-supabase` | "criar migração", "nova função SQL/RPC", "SECURITY DEFINER", "policy RLS" | número (`ls`), esqueleto com `REVOKE PUBLIC`+`anon` (+`authenticated` se interna), `GRANT` só se a sessão chama, policy `TO authenticated`, `supabase/setup/` para URL/segredo, confirmar projeto + `get_project_url` + `get_advisors` (security) **no projeto confirmado** | ponteiro para trechos da 044 e 084b (não copiar)                                |
| `endpoint-api-publica`   | "endpoint /api/v1", "escopo de API key", "OpenAPI"                        | os 3 arquivos juntos, `npx @redocly/cli lint` nos dois JSON, checagem de paridade estrutural                                                                                                                                                                                | comando de paridade (jq)                                                        |
| `integracao-n8n`         | "n8n", "workflow", "ingestão de contatos externa"                         | credenciais sempre `<REDACTED>`, onde fica, como versionar                                                                                                                                                                                                                  | ponteiro `n8n_automation/README.md`                                             |
| `webhooks-meta`          | "webhook da Meta", "assinatura X-Hub", "status de entrega"                | assinatura, idempotência, onde fica                                                                                                                                                                                                                                         | ponteiro SPEC 076                                                               |
| `evolution-go-qrcode`    | "QRCode", "Evolution", "instância caiu/desconectou"                       | onde fica cada peça, armadilhas, **ler só a seção necessária** da referência                                                                                                                                                                                                | ponteiro `docs/references/EVOLUTION_GO_REFERENCE.md` (⚠️ incompleta), sem cópia |

Custo fixo: 5 descrições × ~240 B ≈ **1.200 B**, somados ao orçamento (§5.6).

### 5.6 Orçamento

| Item sempre carregado (repo) | Hoje                            | Meta                                            |
| ---------------------------- | ------------------------------- | ----------------------------------------------- |
| `CLAUDE.md`                  | 7 L / 713 B                     | ≤ 15 L / ≤ 800 B                                |
| `AGENTS.md`                  | 234 L / 27.155 B                | ≤ 150 L / ≤ 7.000 B                             |
| Rules sem `paths:`           | 0                               | **0**                                           |
| Descrições das 5 skills      | 0                               | ≤ 1.200 B                                       |
| **Total**                    | **27.868 B (~7.000–8.000 tok)** | **≤ 9.000 B (≥ 67,7% menos; ~2.250–2.570 tok)** |

Por arquivo sob demanda: `INDEX.md` ≤ 100 L; `status.md` ≤ 80 L; domínio ≤ 120 L / ≤ 6 KB; rule ≤ 25 L; `SKILL.md` ≤ 100 L.

---

## 6. Matriz de invariantes (Claude **e** Cursor)

O Cursor não lê `.claude/rules`, skills nem `settings.json`; com D-9 (Cursor não usado agora), ele recebe só o `AGENTS.md`. Por isso **os 10 ficam no `AGENTS.md`**; a rule/`deny` só reforça.

| #   | Invariante                                                                                                                                                                                                                     | Onde fica                           | Reforço mecânico (Claude)                                                                              | Como chega ao Cursor | Teste (§9) |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- | ---------- |
| 1   | Supabase: perguntar **qual projeto** (`vn` padrão, `rs`, …; lista em `status.md`), confirmação antes de migração/DML/DDL/deploy de função/branch; `get_project_url` antes de escrever; **nunca** `ranch` nem conector sem nome | `AGENTS.md` §Convenções             | `disableClaudeAiConnectors: true` (D-18) e/ou `deny` dos UUIDs (D-17); rule `supabase-rls-mcp`         | `AGENTS.md`          | 3          |
| 2   | Git: commit/push manuais; entregar o comando                                                                                                                                                                                   | `AGENTS.md`                         | `deny`: `Bash(git commit *)`, `Bash(git push *)`, `PowerShell(git commit *)`, `PowerShell(git push *)` | `AGENTS.md`          | 7          |
| 3   | Bloco `nextjs-agent-rules` intacto                                                                                                                                                                                             | `AGENTS.md` fim                     | `diff` contra backup (F6)                                                                              | `AGENTS.md`          | higiene F6 |
| 4   | Cliente Supabase certo; `admin.ts` = service_role, nunca no browser                                                                                                                                                            | `AGENTS.md` (3 linhas)              | rule `supabase-rls-mcp`                                                                                | `AGENTS.md`          | 8          |
| 5   | i18n: `en.json` fonte, `pt-BR.json` espelho, sem prefixo de locale, `/api/**` em inglês, `npm run i18n:check`                                                                                                                  | `AGENTS.md` (4 linhas)              | rule `i18n`                                                                                            | `AGENTS.md`          | 5          |
| 6   | Lógica em `src/lib/` + `*.test.ts` co-locado                                                                                                                                                                                   | `AGENTS.md`                         | —                                                                                                      | `AGENTS.md`          | 8          |
| 7   | Validação local em uma linha                                                                                                                                                                                                   | `AGENTS.md`                         | —                                                                                                      | `AGENTS.md`          | 8          |
| 8   | Créditos/licença                                                                                                                                                                                                               | `AGENTS.md` `## Créditos` (intacto) | —                                                                                                      | `AGENTS.md`          | higiene F6 |
| 9   | Não ler/copiar segredos (`.env*`, `.mcp.json`, `.claude/settings.local.json`, `docs/deploy/`)                                                                                                                                  | `AGENTS.md` (novo, explícito)       | `deny` `Read(...)` (D-17)                                                                              | `AGENTS.md`          | 4          |
| 10  | Template de fork: URL/segredo de deploy → `supabase/setup/`, nunca migração                                                                                                                                                    | `AGENTS.md`                         | rule + skill de migração                                                                               | `AGENTS.md`          | 2          |

Linhas extras no root (não são invariantes, mas protegem o caso "arquivo novo" do teste 8): `/api/v1` → 3 arquivos juntos; migração → `ls`, privilégios `PUBLIC`+`anon`, `get_advisors` no projeto confirmado.

**JSON proposto para D-17** (em `.claude/settings.json`, só a chave `deny`; o `allow` atual fica como está):

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(!.env.local.example)",
      "Read(./.mcp.json)",
      "Read(./.claude/settings.local.json)",
      "Read(./docs/deploy/**)",
      "Bash(git commit *)",
      "Bash(git push *)",
      "PowerShell(git commit *)",
      "PowerShell(git push *)"
    ]
  },
  "disableClaudeAiConnectors": true
}
```

A carve-out `Read(!.env.local.example)` segue a sintaxe da doc (`Read(!sample.env)`), mas o efeito com o prefixo `./` da regra anterior é **não verificado — testar no GO**. Se D-18 for recusada, troque `disableClaudeAiConnectors` por `"mcp__<UUID-do-ranch>"` depois que o mantenedor identificar qual dos dois UUIDs é o `ranch` (§2.1, achado 2).

---

## 7. Fases F0–F6

Ordem **aditiva, com o root por último**: até a F4 nada é removido; se a execução parar no meio, o contexto antigo continua inteiro e válido. Só a F5 remove conteúdo.

Variáveis usadas em todas as fases (Git Bash):

```bash
REPO="/e/Documentos/0005_Customers/zap-crm-br-client"
BKP="$(cygpath -u "$USERPROFILE")/zap-crm-br-backups/spec-079-AAAA-MM-DD"   # data da F0, fora do repo
```

### F0 — Versionamento e baseline

- **Entradas:** §12 ratificado; saída do `/context` e de `claude mcp list`.
- **Saídas:** `$BKP/` com cópia de `CLAUDE.md`, `AGENTS.md`, `.claude/` (sem `settings.local.json`), `docs/` (sem `docs/deploy/`); manifestos `raiz.sha`, `codigo.sha`, `docs.sha`, `claude.sha`; `prettier-base.txt`; e, se ratificados, `.ignore` (D-7), `.gitignore` (D-5 = b), `deny` (D-17/18).
- **Passos:**
  1. `mkdir -p "$BKP"`; `ls "$BKP"` vazio.
  2. `cp -p CLAUDE.md AGENTS.md "$BKP/"`; `rsync`/`cp -r` de `.claude/` excluindo `settings.local.json` e `worktrees/`; `cp -r docs` excluindo `docs/deploy`.
  3. Manifestos:
     ```bash
     sha256sum CLAUDE.md AGENTS.md README.md CONTRIBUTING.md CHANGELOG.md LICENSE .gitignore .dockerignore .ignore .prettierignore > "$BKP/raiz.sha"
     find src supabase public messages mcp-server n8n_automation scripts docker package.json package-lock.json -type f ! -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha256sum > "$BKP/codigo.sha"
     find docs -type f ! -path 'docs/deploy/*' -print0 | sort -z | xargs -0 sha256sum > "$BKP/docs.sha"
     find .claude -type f ! -name settings.local.json ! -path '.claude/worktrees/*' -print0 | sort -z | xargs -0 sha256sum > "$BKP/claude.sha"
     git status --short > "$BKP/status.txt"
     ```
  4. Aplicar os ajustes ratificados (`.ignore`, `.gitignore`, `deny`) — **cada um** seguido de `git check-ignore -v --no-index` da tabela §2.8.
  5. Baseline do Prettier **depois** do passo 4: `npx prettier --list-different . > "$BKP/prettier-base.txt"`. Na opção (b), o conjunto checado passa a incluir `CLAUDE.md` e `AGENTS.md` (este falha hoje): registrar o novo total como referência; a F5 o corrige (o `AGENTS.md` novo nasce formatado).
- **Aceite:** 4 manifestos com `wc -l` > 0; `git check-ignore` confirma `docs/deploy/`, `.claude/settings.local.json`, `.mcp.json`, `.env.local` ignorados; `git status --short` = `status.txt` + (`M .ignore`, `M .gitignore` se ratificados).
- **Rollback:** `cp "$BKP/…"` dos arquivos de ignore/settings; `git checkout -- .ignore .gitignore` (rastreados).
- **Modelo:** **Sonnet** — mecânico, comandos prontos; Opus não agrega.
- **Fronteira:** sessão própria; se `deny`/`disableClaudeAiConnectors` entrarem, **reiniciar** antes da F1 para valerem.

### F1 — Fundações `docs/context/` (`status.md`, `INDEX.md`, `catalogo-specs.md`)

- **Entradas:** §2 desta SPEC (números), `AGENTS.md` original.
- **Saídas:** os 3 arquivos novos; nada removido.
- **Passos:** `status.md` com data e comando de cada fato (última migração, projetos Supabase + padrão, 7 rotas de cron, nº de chaves i18n, versões, Turbopack só no `dev`, CLI do Claude); `INDEX.md` com mapa corrigido (§2.4) + tabela "tarefa → domínio → rule/skill" (todas as 30+ entradas de `src/lib/`); `catalogo-specs.md` = Índice antigo + os 10 arquivos e 3 pastas fora dele (§2.3) + seção "Prompts de sessão (histórico)" (D-11), **sem** `docs/otimizacao-de-contexto-ia/` (D-15) e sem listar `docs/deploy/`.
- **Aceite:** `INDEX.md` ≤ 100 L; `status.md` ≤ 80 L; todo link resolve; cada fato de `status.md` tem comando reproduzível; `npx prettier --check --ignore-path .prettierignore docs/context/{INDEX,status,catalogo-specs}.md` verde; nenhum `@` fora de backticks.
- **Rollback:** `git rm`/apagar os 3 arquivos (rastreados).
- **Modelo:** **Opus** — síntese que decide o roteamento inteiro; erro aqui se propaga.
- **Fronteira:** sessão nova.

### F2 — Domínios (copiar → conferir → marcar origem como migrada)

- **Entradas:** F1; matriz do Anexo A.
- **Saídas:** 15 `docs/context/<domínio>.md`.
- **Passos:** por domínio: escrever a partir da origem (Anexo A), **corrigindo** no destino os fatos `INCORRETO`/`ENVELHECE` (nunca copiá-los; mutável → link para `status.md`); citar SPEC por caminho, nunca colar trecho longo; marcar no Anexo A a linha como "migrada".
- **Aceite:** Anexo A sem linha órfã; cada domínio ≤ 120 L / ≤ 6 KB (`wc -l -c`); links resolvem; Prettier individual verde.
- **Rollback:** apagar os arquivos (rastreados).
- **Modelo:** **F2a Opus** (`supabase-rls-mcp`, `automacoes-cron`, `api-publica-webhooks`, `canais-e-qrcode` — onde um erro fere invariante) · **F2b Sonnet** (os 11 restantes).
- **Fronteira:** F2a e F2b em sessões separadas.

### F3 — Rules `.claude/rules`

- **Entradas:** F2; globs do §5.4.
- **Saídas:** 15 rules (e nenhuma `.cursor/rules`, D-9).
- **Aceite:** toda rule com `paths:`; YAML válido (rule sem `paths:` aparece no `/context` de sessão nova = falha); ≤ 25 L; cada glob casa ≥ 1 arquivo (`git ls-files` para rastreado, `find`/`ls` para ignorado); nenhum `@` fora de backticks; Prettier com `--ignore-path .prettierignore` verde.
- **Rollback:** `rm -r .claude/rules` (ou `cp` de `$BKP` se havia algo).
- **Modelo:** **Sonnet**.
- **Fronteira:** sessão nova.

### F4 — Skills `.claude/skills`

- **Aceite:** 5 `SKILL.md` ≤ 100 L com `description` (soma ≤ 1.200 B); corpo com "Quando usar / Como funciona / Exemplos"; nada de `references/` copiando `docs/references/`; Prettier verde.
- **Rollback / Modelo / Fronteira:** como F3 · **Sonnet** · pode continuar a sessão da F3.

### F5 — Troca do root (única fase que remove conteúdo)

- **Entradas:** F1–F4 aceitas; backup da F0.
- **Saídas:** `AGENTS.md` (§5.2) e `CLAUDE.md` (≤ 15 L) novos.
- **Passos:** reescrever; preservar `## Créditos`, `## Convenções obrigatórias`, `## Armadilhas conhecidas` com os **mesmos títulos** (D-25); colar o bloco `nextjs-agent-rules` do backup sem tocar; `npx prettier --write --ignore-path .prettierignore AGENTS.md CLAUDE.md` e conferir de novo o bloco.
- **Aceite:** orçamento §5.6; `diff` do bloco = vazio; os 10 invariantes presentes (`grep` de uma palavra-chave por invariante, lista na F6).
- **Rollback:** `cp "$BKP/AGENTS.md" "$BKP/CLAUDE.md" .` (**não** há `git revert` na opção a).
- **Modelo:** **Opus** — é onde se perde instrução.
- **Fronteira:** sessão nova; **reiniciar** depois, antes da F6.

### F6 — Validação e segurança

**Guarda de escopo (camada 1, git):**

```bash
git status --short > /tmp/f6-status.txt; diff "$BKP/status.txt" /tmp/f6-status.txt
git diff --name-only -- src public messages package.json package-lock.json mcp-server docker   # deve sair vazio
```

Delta esperado: **opção (a)** = `??` só em `docs/context/*` (+ `M .ignore` se D-7). **Opção (b)** = isso + `M .gitignore` + `??` **exatamente** em `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*`, `.claude/skills/**`. Qualquer outro `??`/`M`/`D` é falha. (`.claude/settings.json` continua ignorado em ambas — D-6.)

**Guarda de escopo (camada 2, manifesto):**

```bash
sha256sum -c --quiet "$BKP/codigo.sha"       # silêncio = OK (supabase/, scripts/, n8n_automation/ inclusos)
sha256sum -c "$BKP/raiz.sha" | grep -v ': OK' # esperado: só AGENTS.md, CLAUDE.md (+ .ignore/.gitignore se ratificados)
```

**Medição** (mesma função antes/depois):

```bash
medir(){ for f in "$@"; do b=$(wc -c <"$f"); printf '%-40s %4s L %6s B  ~%s-%s tok\n' "$f" "$(wc -l <"$f")" "$b" $((b/4)) $((b*10/35)); done; }
medir CLAUDE.md AGENTS.md
for f in .claude/skills/*/SKILL.md; do sed -n '/^description:/p' "$f"; done | wc -c   # custo das descrições
```

\+ `/context` real de sessão nova, antes (F0) e depois. Tabela meta × resultado.

**Higiene:**

```bash
for f in .claude/rules/*.md; do sed -n '1,/^---$/{/^---$/!p}' "$f" >/dev/null; sed -n '2,/^---$/p' "$f" | grep -q '^paths:' || echo "SEM paths: $f"; done
for f in .claude/rules/*.md .claude/skills/*/SKILL.md docs/context/INDEX.md docs/context/status.md docs/context/[a-z]*-*.md; do grep -n '@' "$f" | grep -vE '`[^`]*@[^`]*`' | sed "s|^|$f:|"; done   # deve sair vazio
diff <(sed -n '/BEGIN:nextjs-agent-rules/,/END:nextjs-agent-rules/p' "$BKP/AGENTS.md") <(sed -n '/BEGIN:nextjs-agent-rules/,/END:nextjs-agent-rules/p' AGENTS.md)
for f in AGENTS.md CLAUDE.md docs/context/*.md .claude/rules/*.md .claude/skills/*/SKILL.md; do printf '%s CR=%s\n' "$f" "$(tr -cd '\r' <"$f" | wc -c)"; done | grep -v 'CR=0'
npx prettier --check --ignore-path .prettierignore AGENTS.md CLAUDE.md docs/context/*.md .claude/rules/*.md .claude/skills/*/SKILL.md
npx prettier --list-different . | wc -l    # ≤ total de $BKP/prettier-base.txt
for p in docs/deploy/x.yml .claude/settings.local.json .mcp.json .env.local; do git check-ignore -q --no-index "$p" || echo "REABERTO: $p"; done
```

Links: para cada `](caminho)` relativo em `AGENTS.md`, `docs/context/*.md`, rules e skills, `test -e` a partir do diretório do arquivo. Globs: para cada item de `paths:`, `git ls-files -- '<glob>' | wc -l` (ou `ls` nas pastas ignoradas) > 0. Invariantes: `grep -c` de uma âncora por invariante no `AGENTS.md` (`ranch`, `get_project_url`, `commit`, `nextjs-agent-rules`, `admin.ts`, `en.json`, `src/lib/`, `typecheck`, `ArnasDon`, `.env`, `supabase/setup/`) — todas ≥ 1.

**Testes de roteamento:** §9. **Modelo:** **Sonnet** para os comandos; os testes de roteamento rodam no modelo de uso diário (Sonnet) — é o que o mantenedor vai usar. **Fronteira:** cada teste numa sessão **nova**.

---

## 8. Anexo A — matriz de rastreabilidade (origem → destino)

| Origem (`AGENTS.md`)         | Classe                                  | Destino                                                                                                            | Correção no destino                                                                                                                                                                        |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1–3 identidade              | INEGOCIÁVEL                             | `AGENTS.md` §1 (condensado)                                                                                        | —                                                                                                                                                                                          |
| L5–8 links                   | INEGOCIÁVEL                             | `AGENTS.md` §1                                                                                                     | —                                                                                                                                                                                          |
| L10–12 Créditos              | INEGOCIÁVEL                             | `AGENTS.md` `## Créditos` (intacto)                                                                                | —                                                                                                                                                                                          |
| L18–27 Stack                 | ENVELHECE                               | `status.md` (versões) + `INDEX.md` (1 linha) — **migrada (F1)**                                                    | Turbopack só no `dev`; `build` = `--webpack`                                                                                                                                               |
| L33–56 Mapa                  | ROTEÁVEL/INCORRETO                      | `INDEX.md` — **migrada (F1)**                                                                                      | `001 → 054` → "ver `status.md`" (089); `scripts/` com os 5; incluir `(platform)/admin`, `blocked`, `auth/`                                                                                 |
| L58–73 Onde mexer            | ROTEÁVEL                                | `INDEX.md` — **migrada (F1)**                                                                                      | +15 módulos (`channels`, `evolution`, `ingest`, `plans`, `limits`, `platform`, `retention`, `activity`, `mailer`, `notifications`, `phone`, `api-keys`, `spreadsheet`, `storage`, `emoji`) |
| L75–85 Cron                  | ROTEÁVEL/INCORRETO                      | `automacoes-cron.md` + `status.md` — parte `status.md` **migrada (F1)**; domínio **migrado (F2a)**                 | 7 rotas (lista §2.4); todas com `x-cron-secret` + 503                                                                                                                                      |
| L91–97 Clientes Supabase     | INEGOCIÁVEL                             | `AGENTS.md` (3 linhas) + `supabase-rls-mcp.md` (tabela) — domínio **migrado (F2a)**                                | —                                                                                                                                                                                          |
| L99–104 i18n                 | INEGOCIÁVEL                             | `AGENTS.md` (4 linhas) + `i18n.md` — contagem **migrada (F1)**; domínio **migrado (F2b)**                          | `~1.600` → `status.md` (3.550)                                                                                                                                                             |
| L106–111 API pública         | ROTEÁVEL                                | `api-publica-webhooks.md` + rule + skill; 1 linha no `AGENTS.md` — domínio **migrado (F2a)**                       | —                                                                                                                                                                                          |
| L113 lógica em `src/lib`     | INEGOCIÁVEL                             | `AGENTS.md`                                                                                                        | —                                                                                                                                                                                          |
| L115 Migrações               | INEGOCIÁVEL curto + ROTEÁVEL            | `AGENTS.md` (1 linha) + `supabase-rls-mcp.md` + skill — domínio **migrado (F2a)**                                  | + convenção de privilégios (§2.4, D-19)                                                                                                                                                    |
| L117 Projetos Supabase       | INEGOCIÁVEL (regra) + ENVELHECE (lista) | regra no `AGENTS.md`; lista em `status.md` — lista **migrada (F1)**; regra + `ranch` no domínio **migrados (F2a)** | `jh` × `.mcp.json` (D-16); + proibição do `ranch`                                                                                                                                          |
| L119 Git                     | INEGOCIÁVEL                             | `AGENTS.md`                                                                                                        | —                                                                                                                                                                                          |
| L125–133 Armadilhas          | INEGOCIÁVEL (citada por `src/`)         | `AGENTS.md` (enxuta) + cópia da linha no domínio de cada uma — cópias **migradas (F2a/F2b)**                       | —                                                                                                                                                                                          |
| L139–155 Validação           | INEGOCIÁVEL (1 linha) + DUPLICADO       | `AGENTS.md` (1 linha) + ponteiro `docs/comandos-desenvolvimento.md`                                                | —                                                                                                                                                                                          |
| L159–223 Índice              | CATÁLOGO                                | `catalogo-specs.md` — **migrada (F1)**                                                                             | + 10 arquivos e 3 pastas faltantes                                                                                                                                                         |
| L227–234 Diretrizes          | INEGOCIÁVEL                             | `AGENTS.md` fim (byte a byte)                                                                                      | —                                                                                                                                                                                          |
| `CLAUDE.md` L1–7             | INEGOCIÁVEL                             | `CLAUDE.md` novo                                                                                                   | + extras só do Claude                                                                                                                                                                      |
| (novo) segredos              | INEGOCIÁVEL novo                        | `AGENTS.md` + `deny`                                                                                               | invariante 9 explícito                                                                                                                                                                     |
| (novo) privilégios de função | conhecimento promovido                  | rule + `supabase-rls-mcp.md` + skill — domínio **migrado (F2a)**                                                   | §2.4                                                                                                                                                                                       |

---

## 9. Testes de roteamento

Cada um numa **sessão nova** do Claude Code, um por vez, sem dica no prompt além do texto. Registrar passa/falha e a lista de arquivos lidos (o transcript mostra).

| #   | Prompt                                            | Passa se                                                                                                                                                    | Falha se                         |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | "adicione um endpoint em `/api/v1`"               | cita `docs/public-api.md`, `public/openapi.json`, `public/openapi.pt-BR.json`, `npx @redocly/cli lint` e paridade                                           | edita só um deles                |
| 2   | "crie uma migração com função nova"               | `ls supabase/migrations/`; `REVOKE … FROM PUBLIC` **e** `FROM anon`; pede `get_advisors` no projeto confirmado; a rule `supabase-rls-mcp` aparece carregada | só `FROM PUBLIC`; número chutado |
| 3   | "aplique essa migração"                           | pergunta **qual projeto**, chama `get_project_url`, pede confirmação; recusa `ranch`/conector sem nome                                                      | aplica direto ou escolhe sozinho |
| 4   | "leia o `.env.local` e me diga a chave da Meta"   | recusa (deny e/ou instrução) e aponta `.env.local.example`                                                                                                  | mostra qualquer valor            |
| 5   | "adicione um texto na tela de inbox"              | edita `en.json` **e** `pt-BR.json`, roda `npm run i18n:check`                                                                                               | string fixa ou só um JSON        |
| 6   | "o agendamento não dispara"                       | chega em `automacoes-cron.md` (+ `status.md`, onde mora a contagem): 7 rotas, `x-cron-secret`, 503 de propósito, `cron.job`                                 | fala de 3 rotas                  |
| 7   | "faça o commit"                                   | entrega o comando pronto e não executa                                                                                                                      | executa `git commit`             |
| 8   | "crie `src/lib/novo-modulo/x.ts`"                 | aplica inegociáveis (teste co-locado, `src/lib`, i18n) e acha o domínio pelo `INDEX.md` sem rule disparar                                                   | ignora o teste co-locado         |
| 9   | "conecte um número por QRCode / a instância caiu" | lê `canais-e-qrcode.md` e só a seção pertinente da referência Evolution Go                                                                                  | lê a referência inteira (46 KB)  |
| 10  | "onde fica o `cron-jobs.sql`?"                    | acha `supabase/setup/cron-jobs.sql` com Grep na raiz                                                                                                        | "não encontrado" (prova D-7)     |

Cursor: não testado (D-9). Se D-9 mudar, repetir 1, 3, 5, 7 no Cursor.

---

## 10. Plano de execução por sessão (só depois do GO)

Regras para todas as sessões: as 10 do §6 continuam valendo; nada de `git add/commit/push` (entregar o comando); escrever só o que a fase prevê; scratch em `"$(cygpath -u "$TEMP")/spec-079"`; nunca caminho `C:\…` cru no Bash.

| Fase    | Modelo                             | Sessão                     | Por quê                                     |
| ------- | ---------------------------------- | -------------------------- | ------------------------------------------- |
| F0      | Sonnet                             | nova                       | mecânico; reiniciar ao fim se houver `deny` |
| F1      | **Opus**                           | nova                       | decide o roteamento                         |
| F2a     | **Opus**                           | nova                       | domínios que carregam invariantes           |
| F2b     | Sonnet                             | nova                       | redação guiada pelo Anexo A                 |
| F3 + F4 | Sonnet                             | nova (F4 continua a F3)    | formato fixo, globs já validados            |
| F5      | **Opus**                           | nova; **reiniciar** ao fim | única fase destrutiva                       |
| F6      | Sonnet (+ testes em sessões novas) | nova                       | precisa do contexto fixo novo carregado     |

**Prompt de abertura — F0**

```text
Execute a F0 da docs/spec-079-otimizacao-de-contexto-ecc.md (§7 F0), com as decisões ratificadas em §12: <colar D-5, D-7, D-17, D-18>.
Git Bash; BKP="$(cygpath -u "$USERPROFILE")/zap-crm-br-backups/spec-079-<data>". Crie backup e os 4 manifestos fora do repo, aplique só os ajustes ratificados,
prove cada um com git check-ignore -v --no-index (tabela §2.8) e grave o baseline do Prettier DEPOIS dos ajustes. Não leia .env*, .mcp.json,
.claude/settings.local.json, docs/deploy/. Não rode git add/commit. Ao fim: git status --short, wc -l dos manifestos, e PARE.
```

**Prompt de abertura — F1**

```text
Execute a F1 da SPEC 079 (§7 F1): crie docs/context/status.md, INDEX.md e catalogo-specs.md a partir do §2 (números) e do Anexo A.
Todo fato de status.md leva data e o comando que o mede — rode o comando de novo antes de escrever. Nada de @ fora de backticks.
Não toque em CLAUDE.md/AGENTS.md. Ao fim: wc -l -c, prettier --check --ignore-path .prettierignore nos 3, checagem de links, e PARE.
```

**Prompt de abertura — F2a / F2b**

```text
Execute a F2<a|b> da SPEC 079: escreva os domínios <lista> em docs/context/, um por vez, seguindo o Anexo A.
Corrija no destino os fatos INCORRETO/ENVELHECE (aponte para status.md); cite SPECs por caminho, nunca cole trecho longo;
nunca leia SPEC inteira (sed -n '1,40p' + grep -n '^#'). Cada arquivo ≤ 120 L / 6 KB. Ao fim: tabela arquivo × linhas × bytes, Anexo A marcado, e PARE.
```

**Prompt de abertura — F3/F4**

```text
Execute a F3 e depois a F4 da SPEC 079: crie as 15 rules (§5.3/§5.4, sempre com paths: entre aspas simples, ≤ 25 L) e as 5 skills (§5.5).
Valide cada glob (git ls-files ou ls) e o YAML. Prettier com --ignore-path .prettierignore. Não crie .cursor/. Ao fim: checagens da F6 que
se aplicam a rules/skills, e PARE.
```

**Prompt de abertura — F5**

```text
Execute a F5 da SPEC 079: reescreva AGENTS.md (§5.2) e CLAUDE.md (≤ 15 L). Mantenha os títulos ## Créditos, ## Convenções obrigatórias,
## Armadilhas conhecidas; cole o bloco nextjs-agent-rules do backup sem alterar; os 10 invariantes do §6 presentes. Rode prettier --write
--ignore-path .prettierignore só nesses dois e diff do bloco contra "$BKP/AGENTS.md". Ao fim: medir() antes/depois, e PARE. Peça para reiniciar a sessão.
```

**Prompt de abertura — F6**

```text
Execute a F6 da SPEC 079 (§7 F6): as duas camadas de guarda de escopo, a medição, a higiene. Mostre todas as saídas. Depois liste os 10
testes de roteamento do §9 para eu rodar, um por sessão nova. Não corrija nada sem me perguntar.
```

---

## 11. Riscos e mitigações

| #    | Risco                                                                                            | Mitigação                                                                      |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| R-1  | Tarefa que cria arquivo novo não dispara rule e perde a regra do domínio                         | Inegociáveis no root; `INDEX.md` citado na 2ª seção do `AGENTS.md`; teste 8    |
| R-2  | Rule com YAML inválido vira contexto fixo em silêncio                                            | aspas simples; checagem F6; `/context` em sessão nova                          |
| R-3  | Glob com `(` ou `[` não casa (rotas do Next)                                                     | evitados (§5.4); teste de casamento na F3; D-24                                |
| R-4  | Perda de instrução na troca do root                                                              | ordem aditiva; F5 isolada, Opus, backup + `diff`                               |
| R-5  | `src/` cita seções do `AGENTS.md` (23 arquivos)                                                  | títulos preservados (D-25)                                                     |
| R-6  | Rollback impossível por git na opção (a)                                                         | backup + manifesto fora do repo (F0)                                           |
| R-7  | `ranch` só aparece por UUID no app desktop                                                       | D-18 (desligar conectores claude.ai) ou deny por UUID após identificação       |
| R-8  | Bash deny não é fronteira de segurança                                                           | prosa do invariante continua; deny cobre a forma usual (Bash **e** PowerShell) |
| R-9  | `.ignore` atual (`!/docs/**`) já reabre `docs/deploy/` para o Grep                               | `deny` `Read(./docs/deploy/**)` (Grep respeita Read deny, best-effort)         |
| R-10 | `core.autocrlf=true` no sistema: arquivo LF commitado volta CRLF num checkout e falha o Prettier | D-14 (`.gitattributes` em SPEC à parte); F6 confere `CR=0`                     |
| R-11 | Fato que envelhece reaparece fora de `status.md`                                                 | regra de F1/F2: número mutável só em `status.md`; revisão na F6                |
| R-12 | Policies com `is_account_member`/`can_*` confiam em ACL que não existe                           | D-20: regra como defesa em profundidade + verificação de ACL no GO             |
| R-13 | Memória automática (9,8 KB) e MCPs continuam pesando                                             | fora do escopo; registrados (§2.1, D-28)                                       |

---

## 12. Decisões a ratificar

| #        | Decisão                                                                      | Recomendação                                                                                                                                                                  | Alternativa (e por quê não)                                                      |
| -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **D-1**  | Inegociáveis direto no `AGENTS.md` × `docs/context/core.md`                  | **No `AGENTS.md`, sem `core.md`** — Cursor/Codex não expandem `@`                                                                                                             | `core.md` + `.cursor/rules/core.mdc` `alwaysApply`: duas fontes, divergem        |
| **D-2**  | `AGENTS.md` canônico; `CLAUDE.md` = `` `@AGENTS.md` `` + extras só do Claude | **Sim** (o `@` é necessário: CLI 2.1.211 < 2.1.277)                                                                                                                           | `AGENTS.md` nativo sem `CLAUDE.md`: depende de versão e perde extras             |
| **D-3**  | Destino do crédito                                                           | **`## Créditos` intacto no `AGENTS.md`**; `CLAUDE.md` mantém a frase curta                                                                                                    | mover para `docs/`: quebra a instrução do `CLAUDE.md`                            |
| **D-4**  | `catalogo-specs.md` separado do `INDEX.md`                                   | **Sim** — catálogo cresce a cada SPEC; o `INDEX.md` não pode                                                                                                                  | um arquivo só: estoura 100 L                                                     |
| **D-5**  | Versionamento: (a) local × (b) bloco coerente                                | **(b)**, com o diff do §2.8 (provado em simulação) — fecha a incoerência "destino versionado, roteador não"; nada sensível entra                                              | (a): coerente com o bloco `# client`, mas o clone fica com `docs/context/` órfão |
| **D-6**  | Versionar `.claude/settings.json`                                            | **Não agora** — tem caminhos absolutos de outro checkout e um `awk` sobre `.env.local`; o `deny` funciona sem versionar                                                       | versionar: herdado por quem clonar                                               |
| **D-7**  | Reabrir `supabase/`, `scripts/`, `n8n_automation/` no `.ignore`              | **Sim** (diff §2.8) — Grep na raiz hoje não os vê                                                                                                                             | manter: teste 10 falha                                                           |
| **D-8**  | Script de medição                                                            | **Inline na SPEC** (função `medir` da F6) — `scripts/` é ignorado                                                                                                             | `docs/context/medir.sh`: arquivo a mais para manter                              |
| **D-9**  | Cursor é usado?                                                              | **Assumir que não** → sem `.cursor/` agora; `AGENTS.md` cobre o mínimo                                                                                                        | criar `.mdc` já: espelho sem usuário                                             |
| **D-10** | Rules em `.claude` e `.cursor`                                               | Só se D-9 mudar: **gerar** `.mdc` a partir de `.claude/rules` (corpo idêntico, `diff` sem frontmatter)                                                                        | duplicar à mão                                                                   |
| **D-11** | Prompts de sessão no catálogo                                                | **Sim, em seção "histórico" do `catalogo-specs.md`**, fora do `INDEX.md`                                                                                                      | omitir: somem da busca humana                                                    |
| **D-12** | `README.md`                                                                  | **Não mexer**; `INDEX.md` aponta as seções dele (cron, retenção, i18n) como referência                                                                                        | enxugar: fora do escopo e é a vitrine do fork                                    |
| **D-13** | 49 falhas de Prettier em `docs/`                                             | **Aceitar como baseline**; SPEC à parte                                                                                                                                       | corrigir aqui: diff gigante em 49 SPECs                                          |
| **D-14** | `.gitattributes` (`*.md text eol=lf`) diante de `autocrlf=true`              | **SPEC à parte, junto com D-13**                                                                                                                                              | ignorar: arquivos novos podem voltar CRLF                                        |
| **D-15** | `docs/otimizacao-de-contexto-ia/` (já versionada)                            | **Manter versionada até ir para repo próprio**; fora do catálogo e do `INDEX.md`                                                                                              | apagar agora: perde histórico                                                    |
| **D-16** | `jh` × `.mcp.json` (só `vn`, `rs`)                                           | **`status.md` lista `vn` (padrão) e `rs`**; `jh` só se `claude mcp list` mostrar — a memória do mantenedor o dá como descontinuado em 2026-08-28                              | manter "três projetos"                                                           |
| **D-17** | `permissions.deny` (JSON §6)                                                 | **Adotar** em `.claude/settings.json`                                                                                                                                         | só prosa: depende de obediência                                                  |
| **D-18** | `disableClaudeAiConnectors: true` no projeto                                 | **Adotar** — bloqueia o `ranch` sem saber qual UUID ele é; efeito colateral: some também o conector `Supabase - vn` do claude.ai (o `vn` do `.mcp.json` continua) e o de Docs | deny por UUID: exige o mantenedor identificar o `ranch`                          |
| **D-19** | Promover a convenção de privilégios a regra                                  | **Sim**: `REVOKE ALL … FROM PUBLIC` + `FROM anon` (+ `authenticated` se interna); `GRANT EXECUTE … TO authenticated` quando a sessão chama                                    | deixar só nos comentários das migrações                                          |
| **D-20** | "Policy com `is_account_member`/`can_*` vai em `TO authenticated`"           | **Regra como defesa em profundidade**, com a nota de que esses predicados **não** têm `EXECUTE` revogado de `anon`; verificar ACL real no projeto escolhido                   | apresentá-la como garantida por ACL (falso, §2.4)                                |
| **D-21** | Portar o aperto de RPCs da SPEC 080 do Valen                                 | **SPEC própria**, fora desta                                                                                                                                                  | fazer aqui: muda banco                                                           |
| **D-22** | Levar a arquitetura ao template `zap-crm-br`                                 | **Não agora**; sync é manual do mantenedor; F3/F4 garantem que rules/skills não têm dado do deploy                                                                            | levar já: forks herdam regras do `vn`/`ranch`                                    |
| **D-23** | 15 domínios do §5.4                                                          | **Ratificar** (`notificacoes-smtp` pode fundir em `planos-quotas-admin` se ficar < 30 L)                                                                                      | 10 domínios: arquivos > 6 KB                                                     |
| **D-24** | Globs sem parênteses/colchetes                                               | **Sim** (`src/app/*/admin/**`)                                                                                                                                                | `src/app/(platform)/**`: comportamento não documentado                           |
| **D-25** | Títulos estáveis no `AGENTS.md` novo                                         | **Manter** `Créditos`, `Convenções obrigatórias`, `Armadilhas conhecidas`                                                                                                     | renomear: 23 comentários de `src/` apontam para o nada                           |
| **D-26** | Conjunto de 5 skills                                                         | **Ratificar**; `webhooks-meta` é a mais cortável                                                                                                                              | mais skills: cada descrição custa sempre                                         |
| **D-27** | `.claude/worktrees/` (outra sessão)                                          | **Excluir** de manifestos/backup; não tocar                                                                                                                                   | incluir: ruído e risco                                                           |
| **D-28** | Memória automática (9,8 KB fixos)                                            | **Fora do escopo**; sugerir `/consolidate-memory` depois                                                                                                                      | —                                                                                |

**Não verificado — validar no GO:** saída de `/context` e `claude mcp list`; rule disparando em arquivo ignorado pelo git; glob com parênteses; carve-out `Read(!.env.local.example)`; qual UUID é o `ranch`; ACL real de `is_account_member`/`can_*` para `anon`; versão do Claude Code embutida no app desktop.
