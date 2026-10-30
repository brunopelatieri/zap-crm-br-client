# Status do repositório — fatos que envelhecem

> **Único lugar** de fato mutável do contexto de IA (SPEC 079, F1). Regras, domínios e o `AGENTS.md` apontam para cá em vez de repetir número.
> Cada linha traz a data da medição e o comando que a reproduz (Git Bash, na raiz do repo). Ao mudar o fato: rode o comando de novo e troque **valor e data** juntos.

## Banco — Supabase

| Fato                            | Valor                                                                                                                                                                             | Medido em  | Comando                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Última migração                 | `089_console_billing_and_identity.sql`                                                                                                                                            | 2026-10-30 | `ls supabase/migrations/ \| tail -2` (a última linha é o `README.md`)                                                                                                       |
| Próximo número livre            | **`090`**                                                                                                                                                                         | 2026-10-30 | idem — sempre conferir antes de criar, outra sessão pode ter pego o número                                                                                                  |
| Arquivos `.sql` em `migrations` | 89 — existe `084b_*`; **não** existe `043_*` (explicado em [`supabase/migrations/README.md`](../../supabase/migrations/README.md))                                                | 2026-10-30 | `ls supabase/migrations/*.sql \| wc -l` · `ls supabase/migrations \| grep '^04[2-4]'`                                                                                       |
| Scripts de `supabase/setup/`    | `cron-jobs.sql`, `orphan-media-cleanup.sql`, `plans-seed.sql`, `plans-seed-vn.sql`, `plans-seed-rs.sql` (não são migração)                                                        | 2026-10-30 | `ls supabase/setup/`                                                                                                                                                        |
| Projetos Supabase (MCP)         | **`vn`** (padrão) e **`rs`**, ambos conectados. `jh` não aparece mais — não usar                                                                                                  | 2026-10-30 | `claude mcp list` (copiar só nome e status: a saída bruta pode conter chave). "Padrão" não sai do comando: é convenção do mantenedor (`AGENTS.md`, Convenções obrigatórias) |
| Projeto proibido                | `ranch` — nunca chamar. Os conectores do claude.ai (onde ele aparece só por UUID) estão desligados por `disableClaudeAiConnectors: true` em `.claude/settings.json` (sessão nova) | 2026-10-30 | `grep -n disableClaudeAiConnectors .claude/settings.json`                                                                                                                   |

Regra (não envelhece, mas fica junto da lista): **confirmar com o mantenedor antes de aplicar migração** em `vn` ou `rs`.

## Rotas de cron

Todas as **7** exigem o header `x-cron-secret` = `AUTOMATION_CRON_SECRET` e respondem **`503` de propósito** quando a variável falta no servidor. Sem agendador externo o recurso simplesmente não acontece.

| Rota                           | Agendada em `supabase/setup/cron-jobs.sql` |
| ------------------------------ | ------------------------------------------ |
| `/api/broadcasts/cron`         | sim                                        |
| `/api/automations/cron`        | sim                                        |
| `/api/flows/cron`              | sim                                        |
| `/api/messages/retention/cron` | bloco comentado (opcional)                 |
| `/api/plans/lifecycle/cron`    | bloco comentado (opcional)                 |
| `/api/contacts/check/cron`     | bloco comentado (opcional)                 |
| `/api/contacts/harvest/cron`   | bloco comentado (opcional)                 |

Medido em 2026-10-30 com: `ls src/app/api/*/cron/route.ts src/app/api/*/*/cron/route.ts` (7) · `grep -c x-cron-secret` e `grep -c 503` em cada (≥ 1) · `grep -l AUTOMATION_CRON_SECRET <as 7> | wc -l` (7) · `grep -n "api/.*cron" supabase/setup/cron-jobs.sql`.

## i18n

| Fato                           | Valor                                          | Medido em  | Comando                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaves (folhas) por dicionário | **3.550** em `en.json` e 3.550 em `pt-BR.json` | 2026-10-30 | `node -e "const c=o=>Object.values(o).reduce((n,v)=>n+(v&&typeof v==='object'?c(v):1),0);for(const f of ['messages/en.json','messages/pt-BR.json'])console.log(f,c(require('./'+f)))"` |

## Stack e build

| Fato                     | Valor                                                                                                                                                                                                                                             | Medido em  | Comando                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Versões (`package.json`) | `next` 16.2.6 · `react`/`react-dom` 19.2.4 · `typescript` ^6 · `next-intl` ^4.13.1 · `tailwindcss` ^4 · `vitest` ^4.1.9 · `@supabase/supabase-js` ^2.107.0 · `@supabase/ssr` ^0.12.0 · `@xyflow/react` ^12.11.0 · `eslint` ^9 · `prettier` ^3.9.1 | 2026-10-30 | `node -e "const p=require('./package.json');console.log({...p.dependencies,...p.devDependencies})"`                        |
| Node                     | `engines.node` = `>=20.0.0`                                                                                                                                                                                                                       | 2026-10-30 | `node -p "require('./package.json').engines"`                                                                              |
| Bundler                  | **Turbopack só no `dev`** (`next dev`, padrão do Next 16). `build` = `next build --webpack`                                                                                                                                                       | 2026-10-30 | `node -p "require('./package.json').scripts"` · `node_modules/next/dist/docs/01-app/01-getting-started/01-installation.md` |

## Ferramentas de IA e baseline da SPEC 079

| Fato                                 | Valor                                                                                                               | Medido em  | Comando                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Claude Code CLI (Git Bash)           | `2.1.211` — o app desktop pode embutir outra versão; registrar a de cada sessão                                     | 2026-10-30 | `claude --version`                                                                                            |
| `/context` de sessão nova (baseline) | **72,2k / 1M tokens (7%)**, app desktop, antes da F0                                                                | 2026-10-30 | `/context` (só interativo, em sessão nova neste repo)                                                         |
| Contexto fixo do repo (baseline)     | `CLAUDE.md` 7 L / 713 B + `AGENTS.md` 234 L / 27.155 B = **27.868 B** (meta da SPEC 079: ≤ 9.000 B)                 | 2026-10-30 | `wc -l -c CLAUDE.md AGENTS.md`                                                                                |
| Contexto fixo do repo (após F5)      | `AGENTS.md` 81 L / 6.919 B + `CLAUDE.md` 11 L / 792 B + descrições das 5 skills 940 B = **8.651 B** (−69%)          | 2026-10-30 | `wc -l -c AGENTS.md CLAUDE.md` · `for f in .claude/skills/*/SKILL.md; do sed -n '/^description:/p' "$f"; done | wc -c` |
| `/context` de sessão nova (após F5)  | pendente — medir e registrar aqui                                                                                   | —          | `/context`                                                                                                    |
| Prettier (baseline aceito, D-13)     | **50** arquivos com aviso: 49 em `docs/` + `docker/runtime-env.mjs` (eram 51 antes da F5; o `AGENTS.md` novo passa) | 2026-10-30 | `npx prettier --list-different .                                                                              | wc -l` |

## Documentação

| Fato                     | Valor                                                                  | Medido em  | Comando                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| Última SPEC/PRD numerada | 079 (`spec-079-otimizacao-de-contexto-ecc.md`) → próxima livre **080** | 2026-10-30 | `ls docs \| grep -E '^(spec\|prd)-[0-9]{3}' \| sed -E 's/^(spec\|prd)-([0-9]{3}).*/\2/' \| sort -u \| tail -1` |
| Catálogo de documentos   | [`catalogo-specs.md`](./catalogo-specs.md)                             | —          | —                                                                                                              |
