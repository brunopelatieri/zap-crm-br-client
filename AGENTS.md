# ZAP CRM BR — CRM para WhatsApp feito para o mercado brasileiro

**ZAP CRM BR** é um CRM para WhatsApp auto-hospedável, construído sobre Next.js e Supabase (caixa de entrada compartilhada, contatos, funis de vendas, disparos em massa e automações no-code), localizado e adaptado para as necessidades do mercado brasileiro.

- **Repositório (mantenedor):** https://github.com/brunopelatieri/zap-crm-br
- **Mantenedor / autor das modificações:** [Bruno Pelatieri](https://github.com/brunopelatieri)
- **Repositório original:** https://github.com/ArnasDon/wacrm
- **Autor original:** [ArnasDon](https://github.com/ArnasDon)
- **Stack:** Next.js App Router; UI shadcn/ui, `@base-ui/react`, `lucide-react`, `sonner`; flows `@xyflow/react` + `@dagrejs/dagre`; kanban `@dnd-kit`; testes Vitest.

## Créditos

> Este projeto é um fork/derivado do repositório original [wacrm](https://github.com/ArnasDon/wacrm) desenvolvido por [ArnasDon](https://github.com/ArnasDon). Todos os créditos pelo core original da aplicação pertencem ao autor original. As modificações, localização para o mercado brasileiro e evolução deste projeto sob o nome **ZAP CRM BR** são mantidas por [Bruno Pelatieri](https://github.com/brunopelatieri) no repositório [zap-crm-br](https://github.com/brunopelatieri/zap-crm-br).

---

## Como navegar

- Achar o domínio da tarefa (mapa do repo, onde mexer, rule/skill): [`docs/context/INDEX.md`](./docs/context/INDEX.md).
- Fatos que mudam (versões, última migração, nº de chaves i18n, rotas de cron): [`docs/context/status.md`](./docs/context/status.md).
- SPECs, PRDs e guias: [`docs/context/catalogo-specs.md`](./docs/context/catalogo-specs.md).
- Nunca confie em fato desse tipo escrito fora de `status.md`.

## Convenções obrigatórias

**Supabase (MCP):** o projeto tem um único banco, o `vn`. Confirme com o mantenedor antes de migração, DML, DDL, deploy de Edge Function ou branch. Antes de ler ou escrever, rode `get_project_url` e confira que é o `vn`. Nunca use outro projeto nem conector Supabase sem nome (só UUID). Detalhe: [`supabase-rls-mcp.md`](./docs/context/supabase-rls-mcp.md).

**Clientes Supabase — escolher o certo importa (RLS depende disso):**

- `src/lib/supabase/client.ts` — Browser / Client Components; sujeito a RLS.
- `src/lib/supabase/server.ts` — Server Components, Route Handlers; sujeito a RLS, usa cookies da sessão.
- `src/lib/supabase/admin.ts` — **service_role**, ignora RLS. Só em rotas de servidor com autorização já validada. Nunca importar em código que chega ao browser.

**Migrações:** numeração sequencial em `supabase/migrations/` — rode `ls supabase/migrations/` antes de criar. Função nova: `REVOKE ALL … FROM PUBLIC` **e** `FROM anon` (interna: também `FROM authenticated`; `GRANT` e `SECURITY DEFINER` em [`supabase-rls-mcp.md`](./docs/context/supabase-rls-mcp.md#privilégios-de-função-em-public-d-19)). Depois de DDL, `get_advisors` (security) no `vn`. Script que carrega URL/segredo do deploy específico **não** é migração: vai em `supabase/setup/` (senão o fork de terceiros agendaria chamadas para o seu domínio).

**i18n — toda string visível ao usuário é traduzida:**

- `messages/en.json` é a **fonte da verdade**; `messages/pt-BR.json` espelha a mesma árvore (traduz só os valores, preserva placeholders `{count}`, `{name}`). Chave nova em um exige chave nova no outro → `npm run i18n:check`.
- Locale por cookie `NEXT_LOCALE` + `NEXT_PUBLIC_APP_LOCALE`. **Não existe `/pt-br/...` na URL** — nunca adicione prefixo de locale a rotas.
- Mensagens de `/api/**` ficam em **inglês** (são para integrações); a UI traduz o erro quando necessário.

**Lógica de negócio vive em `src/lib/`, não em componentes.** É o que permite testar sem browser — todo módulo relevante já tem `*.test.ts` co-locado. Ao adicionar regra nova, adicione o teste ao lado.

**API pública (`/api/v1`):** endpoint novo, campo alterado/removido ou escopo novo atualiza **três arquivos juntos**, na mesma alteração: `docs/public-api.md` (fonte de verdade), `public/openapi.json` e `public/openapi.pt-BR.json` (espelho; só `summary`/`description` em pt-BR). Lint e paridade: [`api-publica-webhooks.md`](./docs/context/api-publica-webhooks.md).

**Git:** commits e push são executados **manualmente pelo mantenedor**. Agentes entregam o comando pronto, não o executam.

**Segredos:** não leia nem copie `.env*` (exceto `.env.local.example`, a lista de variáveis), `.mcp.json`, `.claude/settings.local.json` nem `docs/deploy/` (exceção: `docs/deploy/server_contabo.md`, sem segredo, é o acesso SSH à VPS — [`vps-ssh.md`](./docs/context/vps-ssh.md)).

## Armadilhas conhecidas

| Sintoma                                       | Causa provável                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Tela quebrada só em pt-BR (ou só em en)       | Chave ausente em um dicionário — rodar `i18n:check`                                      |
| `INVALID_MESSAGE` no console do browser       | Sintaxe ICU errada em `t.rich()` / placeholder — `typecheck` **não** pega                |
| Agendamento "não dispara", sem erro           | Falha silenciosa: sem cron ou sem `AUTOMATION_CRON_SECRET` (rota devolve 503)            |
| Erro de tipo com `t` dentro de `.map()`       | Shadowing de `useTranslations` — renomeie a variável do map                              |
| Build passa em `dev` e falha no host          | `dev` é mais tolerante — sempre rodar `npm run build` antes do push                      |
| Query retorna vazio inesperadamente           | Cliente Supabase errado (RLS barrando) ou membership de conta não resolvida              |
| E-mail de confirmação aponta para `localhost` | **Site URL** do Supabase não trocada para produção (independe de `NEXT_PUBLIC_SITE_URL`) |

## Validação local — obrigatória (não há CI neste repositório)

Sem `.github/` (nem Actions, nem Dependabot): rode nesta ordem antes de push/deploy.

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

O que cada comando cobre e quando rodar: [`docs/comandos-desenvolvimento.md`](./docs/comandos-desenvolvimento.md).

---

## Diretrizes técnicas

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
