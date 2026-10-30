# Prompt — SPEC-079: otimização de contexto do ZAP CRM BR (padrão ECC)

**Para rodar no Claude Code, na raiz do repositório `zap-crm-br-client`.**

> Adaptado do prompt da SPEC-082 do Valen Ranch (mesma técnica, aplicada ao repositório de origem). As pistas abaixo foram medidas **neste** repositório em 2026-10-30; nada do Valen (núcleo Ranch, MCP `ranch`, migrações 090–092, SPEC 079–082 de lá) vale aqui.

| Item                         | Valor                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modelo                       | **Claude Opus 5.5** (`claude-opus-5-5`) — `/model opus` antes de colar. Análise longa + redação de SPEC; não vale economizar aqui                                                                                                                                                                                                                                                            |
| Modo                         | Sessão **nova**, modo padrão (não `--dangerously-skip-permissions`). Aprove só as leituras e a criação do arquivo da SPEC                                                                                                                                                                                                                                                                    |
| Pré-condição                 | Pistas atualizadas em 2026-10-30 depois dos commits `a5af7eb`/`c4269ce` (`docs/**/*.md` passou a ser versionado) e `5745225` (lixo removido). Antes de abrir a sessão, commite ou descarte o que estiver pendente em `docs/` — senão a prova de escopo do fim fica poluída. Este prompt e a pasta `docs/otimizacao-de-contexto-ia/` aparecem como `??` até você decidir o que fazer com eles |
| Saída esperada               | **1 único arquivo novo:** `docs/spec-079-otimizacao-de-contexto-ecc.md`                                                                                                                                                                                                                                                                                                                      |
| Prova de que nada mais mudou | **Delta** de `git status --short` (antes × depois) = **só** `?? docs/spec-079-otimizacao-de-contexto-ecc.md` **e** `sha256sum` idêntico dos arquivos ignorados (`CLAUDE.md`, `AGENTS.md` e demais `.md` da raiz continuam ignorados por `*.md`) — ver trava 9                                                                                                                                |
| Depois                       | Você lê a SPEC, ratifica as decisões D-n e só então responde **GO**                                                                                                                                                                                                                                                                                                                          |

Cole tudo a partir da linha abaixo.

---

# PAPEL

Você é um Arquiteto de Contexto de Agentes de IA. Vai projetar — **não executar** — a refatoração da documentação-contexto do repositório ZAP CRM BR (`zap-crm-br-client`, Next.js 16 + Supabase), inspirada no padrão do repositório `affaan-m/ECC` (everything-claude-code): rules com escopo por path, skills sob demanda e roteamento por índice.

# ENTREGA ÚNICA

Criar `docs/spec-079-otimizacao-de-contexto-ecc.md`, em pt-BR, no mesmo estilo das SPECs existentes (leia **só o cabeçalho e os títulos** de `docs/spec-078-*.md` e `docs/spec-075-*.md` — `sed -n '1,40p'` + `grep -n '^#'` — e imite títulos, bloco `> **Status:** / **Data:** / **Contexto:**` e formato de fases). Ao terminar: resumo + **PARE** e aguarde o meu "GO".

# TRAVAS INVIOLÁVEIS (modo arquiteto)

1. **Única escrita permitida no repo:** o arquivo da SPEC-079. Nada de `mkdir`, rascunhos, scripts ou temporários dentro do repo.
2. **Scratch fora do repo, com caminho POSIX absoluto.** Este é um Windows com Git Bash: nunca passe um caminho `C:\...` cru para o Bash. **Evidência:** uma sessão anterior fez exatamente isso e criou na raiz o arquivo `C:UsersBRUNOP~1AppDataLocalTemp…scratchpadlint-full.txt`, que chegou a ser commitado (removido no commit `5745225`). Use `SCR="$(cygpath -u "$TEMP")/spec-079"; mkdir -p "$SCR"` e confira com `ls "$SCR"` antes de gravar o snapshot.
3. **Bash somente leitura:** `wc`, `ls`, `find`, `grep`, `awk`, `sed -n`, `sha256sum`, `file`, `du`, `git ls-files`, `git log`, `git status`, `git diff`, `git check-ignore -v`, `git config --show-origin`. Proibido: `git add/rm/commit/push/tag`, `npm install/run/build`, qualquer escrita. **Única exceção:** `npx prettier --check` e `npx prettier --write` **apenas** sobre o arquivo da SPEC-079 e **sempre com `--ignore-path .prettierignore`** (ver Fase 0 item i — a SPEC em `docs/` hoje é checada normalmente, mas `CLAUDE.md`/`AGENTS.md` e tudo em `.claude/` continuam ignorados, e sem essa opção o Prettier os pula em silêncio dizendo que está tudo certo).
4. **Não leia segredos:** `.env*` (há um `.env.local` real na raiz), `.mcp.json` (tem tokens), `.claude/settings.local.json`, `docs/deploy/` (`stack-zapcrm.yml`, stack com segredos). Para saber se existem use só `test -f`. Nunca copie valor de segredo para a SPEC. Os nomes dos servidores MCP e os `project_ref` já estão nas pistas abaixo — não abra o `.mcp.json` para confirmá-los.
5. **Não use nenhum MCP Supabase** nesta tarefa — nem `vn`, nem `rs`, nem `jh`, nem conectores do claude.ai que apareçam na sessão (nesta conta existe um conector **`Supabase - ranch`**, que é do Valen Ranch, e um `Supabase - vn`). Não é necessário.
6. Esta tarefa não escreve código Next.js: não precisa ler `node_modules/next/dist/docs/`.
7. Se `docs/spec-079-*` já existir, **pare e pergunte**. Antes, confirme com `ls docs/ | grep -E '^(spec|prd)-0(79|8)'` que 079 está livre (hoje a mais alta é a 078).
8. Dúvida que não seja a do item 7: **não pergunte** — assuma, registre como decisão D-n em §12 e siga.
9. **Snapshot de abertura (primeira ação da sessão),** gravado em `$SCR`:
   - `git status --short > "$SCR/status-antes.txt"`
   - `sha256sum CLAUDE.md AGENTS.md README.md CONTRIBUTING.md CHANGELOG.md .gitignore .dockerignore .ignore .prettierignore > "$SCR/raiz.sha"` (quase todos ignorados pelo git por `*.md` — o `git status` não os vê);
   - `find docs -type f ! -path 'docs/deploy/*' -print0 | sort -z | xargs -0 sha256sum > "$SCR/docs.sha"` (`docs/**/*.md` é versionado desde `c4269ce`, mas os não-`.md` de `docs/` também são rastreáveis e este manifesto é a segunda prova, independente do git).
     No fim, compare os três (trava de saída, item 1).
10. Em `find`/`grep -r`, exclua `node_modules` (inclusive `mcp-server/node_modules`), `.next`, `.git`.
11. **Economia de contexto nesta própria sessão:** `docs/` tem ~3 MB; várias SPECs passam de 60 KB (045 ≈ 148 KB, 044 ≈ 142 KB, 076 ≈ 106 KB, 069 ≈ 104 KB, PRD 047 ≈ 95 KB). **Nunca leia uma SPEC/PRD inteira:** use `sed -n '1,40p'`, `grep -n '^#'` e `grep -n` dirigido. `docs/references/` (~178 KB, Evolution Go etc.) idem: só `wc`/`grep -n '^#'`.
12. **Todo número da SPEC vem de medição feita nesta sessão.** Não copie números deste prompt como se fossem medidos: ele traz pistas, você confirma ou corrige.

# O QUE JÁ SE SABE (pistas medidas em 2026-10-30 — reconfirme)

**Tamanhos**

- `CLAUDE.md`: 7 linhas / 713 B, faz `@AGENTS.md`. Como `@` expande e **sempre** carrega, o `AGENTS.md` inteiro entra em toda sessão.
- `AGENTS.md`: 234 linhas / 27.155 B, LF, UTF-8. **Métrica principal = bytes/tokens; linhas = secundária** (a linha 110 tem 520 B; a 115, de migrações, 415 B).
- Por seção (bytes): "Índice da documentação" 68 L / ~14.272 B (**~53% do arquivo** — catálogo, não instrução); "Mapa do repositório" 58 L / ~3.955 B; "Convenções obrigatórias" 34 L / ~3.859 B; "Armadilhas" ~1.324 B; "Validação local" ~1.226 B; "Stack" ~1.010 B; cabeçalho ~634 B; "Créditos" ~522 B; "Diretrizes técnicas" (bloco Next.js) ~353 B.
- Fora do repo, também sempre carregado: `~/.claude/CLAUDE.md` do usuário (`$USERPROFILE/.claude/CLAUDE.md` no Git Bash). Entra no `/context`, mas está **fora do escopo** de mudança — só meça e registre no baseline.
- Outros `.md` da raiz que **não** carregam sozinhos (só se lidos): `README.md` 32.601 B, `CHANGELOG.md` 32.583 B, `CONTRIBUTING.md` 4.718 B. Não há `CLAUDE.md`/`AGENTS.md` aninhado em subpasta (medido com `find`, excluindo `node_modules`/`.git`/`.next`).

**Versionamento — mudou hoje; leia com atenção (muda a arquitetura)**

- Estado atual do `.gitignore` (commit `c4269ce`): o bloco `# client` ignora `/n8n_automation`, `/supabase` e `*.md`; logo abaixo, `!/docs/**/*.md` reabre os `.md` de `docs/`, e `/docs/deploy/` (última regra do bloco) volta a bloquear a stack com segredos. Também ignorados: `/.claude` (~61), `/scripts` (~66), `/.vscode`, `*.code-workspace`. Origin: `brunopelatieri/zap-crm-br-client` (repositório **cliente**, privado; o template público é `brunopelatieri/zap-crm-br`).
- Medido com `git check-ignore -v --no-index`: `docs/context/x.md` e `docs/spec-079-x.md` → **rastreáveis** (regra `!/docs/**/*.md`); `CLAUDE.md`, `AGENTS.md` → ignorados (`*.md`); `.claude/rules/x.md` → ignorado (`/.claude`); `docs/deploy/x.yml` → ignorado. O git rastreia **1.098 arquivos**, incluindo **85** `.md` de `docs/`. Consequências, todas a tratar na SPEC:
  - `docs/context/` **já é versionado.** O problema de coerência agora é o inverso do que seria: arquivos de domínio e `INDEX.md` vão para o git, mas o roteador (`CLAUDE.md`/`AGENTS.md`) e as rules/skills (`.claude/`) que os referenciam **não**. Num clone novo existem os destinos e não existe quem aponte para eles.
  - `git revert` **não serve** de rollback da F5 (`CLAUDE.md`/`AGENTS.md` não são rastreados) nem das F3/F4 (`.claude/`). Para F1/F2 (`docs/context/`), o git passa a servir. Rollback das demais = backup datado **fora do repo** + manifesto `sha256sum`.
  - Opções para a D-n de versionamento: (a) manter `CLAUDE.md`/`AGENTS.md`/`.claude/` locais (coerente com o bloco `# client`; backup fora do repo); (b) versionar o conjunto trocando `/.claude` por `/.claude/*` + `!/.claude/rules/` + `!/.claude/skills/` (+ `!/.claude/settings.json` se a D-n de `permissions.deny` for aceita) e reabrindo `!/CLAUDE.md`, `!/AGENTS.md` e `!/.claude/**/*.md` **depois** de `*.md` — **sem** reabrir `settings.local.json`, `launch.json`, `.mcp.json`, `.env*`, `docs/deploy/`. Valide cada proposta com `git check-ignore -v` e com a ordem das regras (a última que casa vence). Trate como D-n — o bloco `# client` parece intencional; não o "corrija" sozinho.
  - `.cursor/rules/*.mdc` **não** é ignorado (`.cursor/` nem existe) — se criado, entra no git por padrão.
  - Template público: decida (D-n) se esta arquitetura também vai para `zap-crm-br` — lá `.claude/rules` versionadas seriam herdadas por quem faz fork; e `brunopelatieri/zap-crm-br-client` pode virar público mais adiante, então nada que entra no git aqui pode conter dado sensível. Fora do escopo de execução; só registrar.
  - Pasta `docs/otimizacao-de-contexto-ia/` (tutorial genérico, criada em 2026-10-30, destinada a um repositório próprio): é referência, não contexto do ZAP. Não a inclua no catálogo nem no `INDEX.md`; registre como D-n "manter fora do repo cliente × versionar aqui".
- **Busca do próprio Claude Code.** O arquivo `.ignore` (para ripgrep) contém só `!/docs` e `!/docs/**`: reabre `docs/` para as ferramentas Grep/Glob, mas **`supabase/`, `scripts/` e `n8n_automation/` continuam invisíveis** a elas. Verifique nesta sessão (ex.: Grep pela string `cron-jobs` e veja se `supabase/setup/cron-jobs.sql` aparece; Glob por `supabase/migrations/*.sql`). Se confirmado, isso afeta o roteamento: um arquivo de domínio que diz "veja `supabase/migrations/`" leva o agente a um Glob vazio. Proponha (D-n) incluir `!/supabase`, `!/scripts`, `!/n8n_automation` no `.ignore` (não afeta o git nem o Docker).

**Prettier — o baseline mudou com o versionamento de `docs/`**

- `npm run format:check` = `prettier --check .`, que respeita o `.gitignore`. Com `docs/**/*.md` versionado, ele **passou a verificar `docs/`**: baseline medido depois do commit `c4269ce` = **50 falhas** (49 em `docs/`, 1 em `docker/runtime-env.mjs`) — antes eram 1. O `format:check` da linha de validação já falha hoje; a F6 compara com esse baseline (o total não pode subir), e todo `.md` novo em `docs/` precisa passar `npx prettier --check <arquivo>` individualmente.
- Para o que **continua** ignorado (`CLAUDE.md`, `AGENTS.md`, `.claude/**`), `npx prettier --check <arquivo>` **pula o arquivo em silêncio e sai 0**. Medido: `npx prettier --check AGENTS.md` → "All matched files use Prettier code style!"; `npx prettier --check --ignore-path .prettierignore AGENTS.md` → `[warn] AGENTS.md` (o `AGENTS.md` atual **falha** — tabela do Índice desalinhada). Logo: check/write de `CLAUDE.md`, `AGENTS.md`, rules e skills usa `--ignore-path .prettierignore`, e a F6 tem de dizer isso (em `docs/` a opção é inofensiva e pode ficar por uniformidade).
- `.prettierrc` tem `endOfLine: lf`. `git config core.autocrlf` não está definido no repo; confira com `git config --show-origin core.autocrlf` no Git Bash. Arquivos novos em LF.

**Docker.** `.dockerignore` é allowlist (`*` + `!package*.json !next.config.ts !tsconfig.json !postcss.config.mjs !src !public !messages !docker`) → `docs/`, `.claude/`, `.cursor/`, `*.md` não entram na imagem (que é **pública**). Confirme e registre (risco de vazamento = baixo). Note também: arquivo novo na raiz não entra no build sozinho (regra do próprio `.dockerignore`) — candidato a decisão curta do domínio de deploy.

**Arquitetura cross-tool.** Cursor/Codex leem `AGENTS.md` e **não** expandem `@`. Se os inegociáveis morarem em `docs/context/core.md` puxado por `@` só no `CLAUDE.md`, **o Cursor perde todos eles**. Opções: (a) inegociáveis direto no `AGENTS.md` e `core.md` não existe; (b) `core.md` + `.cursor/rules/core.mdc` com `alwaysApply: true` como espelho. Recomendação de partida: (a), uma fonte só. O repo tem `.vscode/` e `zap-crm-br.code-workspace` e **não** tem `.cursor/` — decida (D-n) se o Cursor é de fato usado; se não for, `.cursor/` fica para depois.

**Supabase e MCP — diferente do Valen**

- `AGENTS.md` (linha ~117) diz: "três projetos Supabase (MCPs `vn` — padrão, `rs` e `jh`)". O `.mcp.json` do projeto declara **só `vn` e `rs`** (HTTP, com header). `jh` não está nele — pode estar no escopo de usuário. Peça ao mantenedor (na ratificação) a saída de `claude mcp list`; não tente descobrir lendo arquivos de configuração.
- `supabase/setup/` tem `plans-seed-vn.sql` e `plans-seed-rs.sql`; o PRD 077 recomenda consolidar `rs` → `vn`. O fato "quais projetos existem e qual é o padrão" **envelhece** → `status.md`; a regra "confirmar o projeto e pedir confirmação antes de escrever" é **inegociável**.
- Nesta conta do claude.ai há o conector **`Supabase - ranch`** (projeto do Valen Ranch). Ele pode aparecer em sessões do Claude Code deste repo. Inegociável novo: nunca usar `ranch` (nem qualquer conector sem nome) no ZAP; `get_project_url` antes de qualquer escrita, conferindo o `project_ref` contra o projeto que o mantenedor escolheu.
- **Convenção de privilégios de função — não copie a do Valen.** Aqui não existem as migrações 090–092 do Valen (SPEC 080 de lá, cuja 091 mudou os privilégios padrão). Neste repo a última migração é a **089** e o padrão vigente está documentado em comentários de migração (044 linhas ~130–140, repetido em 045/047/048/053/072): "`REVOKE ... FROM PUBLIC` sozinho NÃO basta neste banco: o Supabase mantém `ALTER DEFAULT PRIVILEGES` concedendo EXECUTE a `anon` e `authenticated` em toda função nova de `public`. Essa concessão é nominal, não herdada de PUBLIC". Logo a convenção é **as duas coisas**: `REVOKE ALL ON FUNCTION … FROM PUBLIC` **e** `REVOKE ALL ON FUNCTION … FROM anon` (+ `authenticated` quando a função é interna), com `GRANT EXECUTE … TO authenticated` quando a rota/policy chama como o usuário. Medido: 67 `REVOKE … FROM PUBLIC` em 41 migrações; 37× `FROM anon`, 12× `FROM authenticated`, 5× `FROM anon, authenticated`; 146 ocorrências de `SECURITY DEFINER`; `is_account_member` e `can_*` recebem `GRANT EXECUTE … TO authenticated, service_role`. Nada disso **está escrito no `AGENTS.md`** hoje (que só fala de numeração e `supabase/setup/`). Derive a regra exata lendo só esses trechos (`grep -n -B2 -A10 'DEFAULT PRIVILEGES' supabase/migrations/044_*.sql`) e confirme se `is_account_member`/`can_*` têm `EXECUTE` revogado de `anon` **e** de `PUBLIC` antes de transformar "policy com esses predicados vai em `TO authenticated`" em regra. Registre como D-n "conhecimento novo promovido a regra", não como mera migração de texto. Leia também `supabase/migrations/README.md` (~1,3 KB): se já documentar numeração/privilégios, o domínio **aponta** para ele em vez de reescrever. Registre ainda como risco/D-n fora de escopo: "portar para o ZAP o aperto de RPCs da SPEC 080 do Valen (privilégios padrão)".

**Dado que envelheceu dentro do contexto fixo (vai para `status.md` ou vira ponteiro)**

- Mapa diz `supabase/migrations 001 → 054`; no disco a última é **089** (90 entradas, contando `README.md`).
- "~1.600 chaves" de i18n; `messages/en.json` e `pt-BR.json` têm hoje **3.550 folhas** cada (paridade ok).
- "Três rotas dependem de agendador externo": há **7** `route.ts` de cron (`broadcasts`, `automations`, `flows`, `contacts/check`, `contacts/harvest`, `messages/retention`, `plans/lifecycle`) — `git ls-files 'src/app/api/**/cron/route.ts'`. Confirme quais exigem `x-cron-secret`/503 (todas citam o secret; confira o comportamento sem a variável).
- "três projetos Supabase … `jh`" × `.mcp.json` com dois (ver acima).
- `scripts/` no mapa diz só `check-i18n-parity.mjs`; no disco há também `evolution-probe.mjs`, `sync-emojibase.mjs`, `verify-039-rls.sql`, `verify-040-media.sql`.
- Mapa de rotas omite `src/app/(platform)/admin` (console do proprietário) e `src/app/blocked`; tabela "Onde mexer" não cita `channels`, `evolution`, `ingest`, `plans`, `limits`, `platform`, `retention`, `activity`, `mailer`, `notifications`, `phone`, `api-keys`, `spreadsheet`, `storage`, `emoji` (todos existem em `src/lib/`).
- Versões na tabela Stack (fonte real: `package.json` — hoje batem: next 16.2.6, react 19.2.4, typescript ^6, next-intl ^4.13.1, vitest ^4.1.9). O `build` usa `next build --webpack` (não Turbopack) — confira se o "Turbopack" da Stack ainda é verdade só no `dev`.

**Índice × disco**

- Nenhum link relativo de `AGENTS.md`/`CLAUDE.md` está quebrado hoje (reconfirme).
- Existe e **não** está no índice: `spec-076-monitor-cobranca-whatsapp-cloud-api.md` (106 KB — 076 **não** é lacuna), `spec-060/064/078-teste-manual.md`, `spec-052-teste-manual/`, `plano-implantacao-vps-zap-local-ia-br.md`, os `prompt-*.md` da raiz de `docs/` (inclusive **este** prompt) e a pasta `docs/prompt/`. Decida (D-n) se prompts de sessão entram no catálogo.
- **44** arquivos citam `AGENTS.md` (quase todos em `docs/`: SPECs, PRDs, guias, prompts, `docs/context/phone-number-format-standard.md`, `docs/public-api.md`). Classifique: citação histórica (não muda) × ponteiro para seção que vai mudar de lugar (precisa de nota de redirecionamento ou de uma âncora estável no `AGENTS.md` novo).

**Demais**

- O bloco `<!-- BEGIN:nextjs-agent-rules --> … <!-- END:nextjs-agent-rules -->` (fim do arquivo, ~350 B) é gerado por ferramenta do Next.js: preservar **byte a byte** e com os marcadores. Verifique se o Claude Code remove comentários HTML de `CLAUDE.md`/imports ao carregar (afeta só a medição, não a preservação).
- `docs/context/` já existe com `phone-number-format-standard.md` (~36 KB) e `docs/references/` também (6 arquivos, ~178 KB: Evolution Go, telefone BR, arquitetura de agentes e de flows/forms). Reaproveitar; não duplicar nem sobrescrever.
- `docs/plano-implantacao-spec-065.md` é o precedente de plano com "modelo por fase, fronteiras de sessão e prompts de abertura prontos". Leia **só** a estrutura (`grep -n '^#'`) e use como modelo para §10.
- `.claude/` hoje: `settings.json` (só `permissions.allow` e `additionalDirectories` — **pode ler**, não é segredo), `settings.local.json` (não ler), `launch.json`. Sem `rules/`, sem `skills/`, sem `CLAUDE.md`, sem `worktrees/`.
- **Enforcement mecânico a custo zero de contexto.** O Claude Code aceita `permissions.deny` em `.claude/settings.json` (ex.: `Read(./.env.*)`, `Read(./.mcp.json)`, `Read(./docs/deploy/**)`, `Read(./.claude/settings.local.json)`, `Bash(git commit:*)`, `Bash(git push:*)`, `mcp__<servidor>` para bloquear um MCP inteiro — o nome exato que o conector `ranch` recebe sai do `claude mcp list` da ratificação). Isso torna os invariantes 1 (só no que toca o `ranch`), 2 e 9 determinísticos e os testes de roteamento 3, 4 e 7 deixam de depender só de obediência. Proponha como D-n, com o JSON exato na SPEC (recomendação: adotar). A prosa dos invariantes continua no `AGENTS.md` — o Cursor não lê `settings.json` — mas pode encolher. Se a D-n de versionamento escolher a opção (b), `!/.claude/settings.json` entra no mesmo diff do `.gitignore`.

# FASE 0 — DIAGNÓSTICO (obrigatório, antes de escrever uma linha da SPEC)

Faça e registre os resultados em §2 da SPEC (tabelas, com o comando usado ao lado de cada número para ser reproduzível):

a. **Baseline do conjunto sempre carregado.** Meça `wc -l -c` de `CLAUDE.md`, `AGENTS.md` e de tudo que entra automaticamente: imports `@` transitivos, `.claude/rules/*.md` **sem** `paths:`, `.cursor/rules/*.mdc` com `alwaysApply: true`, `.claude/CLAUDE.md`/`CLAUDE.local.md` se existirem, e `~/.claude/CLAUDE.md` (fora do escopo, só para reconciliar com o `/context`). Estime tokens em duas taxas (bytes/3,5 e bytes/4) e diga que é estimativa (pt-BR acentuado infla bytes em UTF-8). Registre também o número real que o usuário obterá com `/context` numa sessão nova (peça que ele cole na ratificação — você não consegue rodar `/context`); lembre que `/context` também conta ferramentas MCP (aqui: `vn`, `rs`, possivelmente `jh` e conectores do claude.ai) e descrições de skills, que esta SPEC não mexe — mas **registre o peso dos MCPs como achado**, porque pode ser maior que o do `AGENTS.md`.
b. **Raio-X do `AGENTS.md` por seção:** linhas, bytes, % do total. Classifique **cada** seção/parágrafo em: `INEGOCIÁVEL` (fica sempre carregado), `ROTEÁVEL` (vira arquivo de domínio), `CATÁLOGO` (consulta eventual), `ENVELHECE` (vai para `status.md` ou vira ponteiro), `DUPLICADO` (já existe em README/docs), `INCORRETO` (fato que o disco desmente — ex.: "três rotas de cron", "001 → 054"). Liste as 10 linhas mais longas (em bytes, `LC_ALL=C awk`).
c. **Inventário de `docs/` e `docs/references/`:** arquivos e bytes (ordenado por tamanho), contagem de SPEC/PRD. Reconcilie o índice do `AGENTS.md` com o disco nos dois sentidos e liste lacunas reais de numeração (cruze `spec-` **e** `prd-`: 047/058/061/068/072/077 são PRD, não lacuna).
d. **Mapa real do código para os globs:** `ls src/lib src/components src/app src/app/api "src/app/(dashboard)" "src/app/(platform)" supabase supabase/setup messages scripts mcp-server n8n_automation docker`. As `paths:`/`globs` das rules devem usar **somente caminhos que existem**. `supabase/`, `scripts/` e `n8n_automation/` são ignorados pelo git — `git ls-files` devolve **zero** neles (em `docs/`, só os `.md` são rastreados); valide esses globs com `find`, os demais com `git ls-files`. Cada glob proposto casa ≥ 1 arquivo. Atenção a globs com parênteses (`src/app/(dashboard)/**`, `src/app/(platform)/**`): confirme na doc se precisam de escape.
e. **Estado atual de rules/skills:** `ls -R .claude` (sem ler `settings.local.json`) e `.cursor/` (hoje inexistente).
f. **Integridade de links:** liste links relativos de `AGENTS.md`/`CLAUDE.md` que apontam para arquivo inexistente. E `grep -rln "AGENTS.md" docs README.md CONTRIBUTING.md mcp-server n8n_automation scripts --exclude-dir=node_modules` para achar quem referencia seções/âncoras que vão mudar de lugar.
g. **Dependência de crédito/licença:** o `CLAUDE.md` manda consultar "a seção de créditos em `AGENTS.md`". Qualquer mudança deve manter o texto de crédito (MIT/ArnasDon → ZAP CRM BR/Bruno Pelatieri) acessível a partir do root e o aviso do `LICENSE` intacto.
h. **Versionamento e ignore:** `git check-ignore -v --no-index` para cada caminho-alvo (`CLAUDE.md`, `AGENTS.md`, `docs/context/x.md`, `docs/context/INDEX.md`, `.claude/rules/x.md`, `.claude/skills/x/SKILL.md`, `.cursor/rules/x.mdc`, `scripts/x.mjs`, `docs/deploy/x.yml`). Para as duas opções de versionamento (local × conjunto inteiro), proponha o diff de `.gitignore` (sem aplicar) e prove, regra a regra, que ele não reabre `docs/deploy/`, `settings.local.json`, `.mcp.json`, `.env*`. Inclua o diff proposto do `.ignore` (busca do Claude Code).
i. **Formatação:** registre o baseline de `npx prettier --list-different .` (hoje ~50 arquivos, 49 em `docs/`) **e** quantos `.md` da raiz e de `.claude/` falham quando checados de verdade (`npx prettier --list-different --ignore-path .prettierignore '*.md'`). Ao terminar a SPEC, rode `npx prettier --check --ignore-path .prettierignore docs/spec-079-otimizacao-de-contexto-ecc.md`; se falhar, `npx prettier --write --ignore-path .prettierignore` **só nesse arquivo**.

# VERIFICAÇÃO DAS PREMISSAS (§4 da SPEC)

Se tiver acesso à web, confirme na documentação oficial do Claude Code e do Cursor, e no repositório `https://github.com/affaan-m/ECC` (README, `rules/`, `skills/`, `CONTRIBUTING`). Cite a URL de cada confirmação. Se não tiver, marque cada item como **"não verificado — validar no GO"**. Premissas que a arquitetura assume:

1. `.claude/rules/*.md` com frontmatter `paths:` (lista de globs) carrega **só** quando o Claude lê arquivo que casa; sem `paths:` carrega sempre na abertura da sessão.
2. Rules por path são ativadas por **leitura de arquivo**. Tarefa que cria arquivo novo ou não abre arquivo casante pode não disparar a rule → por isso os inegociáveis ficam no contexto fixo e `INDEX.md`/skills têm descrições boas. Verifique também se escrita/edição dispara, e se arquivo **ignorado pelo git** (todo `supabase/`, `scripts/`) dispara normalmente — aqui isso não é detalhe, é o caso comum.
3. `@arquivo` em `CLAUDE.md` **expande e sempre carrega** (recursivo, com limite de profundidade). Logo: **proibido `@` em rules, no `INDEX.md` e nos arquivos de domínio**; referência a domínio é caminho em texto ("leia `docs/context/x.md`"), senão a carga sob demanda vira carga fixa. Confirme também que `@` dentro de code span/bloco **não** é import — o `AGENTS.md` cita `@base-ui/react`, `@xyflow/react`, `@dagrejs/dagre`, `@dnd-kit`, `@redocly/cli` em backticks, e a rule de `/api/v1` vai citar `@redocly/cli`. Por isso o check da F6 não é "nenhum `@`", e sim "todo `@` está dentro de backticks".
4. Pista conferida em 2026-10-30 em `https://code.claude.com/docs/en/memory` (reconfirme na versão instalada, `claude --version`): o Claude Code lê `AGENTS.md` nativamente desde a v2.1.277, **mas só quando não há `CLAUDE.md`/`CLAUDE.local.md`**; com `CLAUDE.md` contendo `@AGENTS.md`, lê os dois sem duplicar. Como este repo tem `CLAUDE.md`, o `@AGENTS.md` continua necessário. Cursor/Codex leem `AGENTS.md` **sem** expandir `@`. Consequência: `AGENTS.md` = roteador **cross-tool em texto puro** que já contém os inegociáveis; `CLAUDE.md` = `@AGENTS.md` + extras só do Claude. Não duplique conteúdo entre os dois.
5. Cursor `.mdc`: frontmatter `description`, `globs`, `alwaysApply`. Confirme o formato de `globs` (string separada por vírgula × lista).
6. Skills: `.claude/skills/<nome>/SKILL.md`, frontmatter `name` + `description`. A **descrição** fica sempre no contexto; o **corpo** só carrega ao invocar. Logo: descrição curta com gatilhos explícitos; corpo enxuto; material pesado em `references/` ao lado (ou ponteiro para `docs/references/`).
7. Comentários HTML em bloco em `CLAUDE.md` (e nos arquivos importados) são removidos antes de entrar no contexto (mesma página da doc, conferida em 2026-10-30) — os marcadores do bloco `nextjs-agent-rules` não custam tokens, mas continuam preservados byte a byte. Na mesma página: `paths` é o **único** campo lido no frontmatter de uma rule; YAML inválido faz a rule carregar **sempre**; `[` em glob precisa de escape (rotas `[param]` do Next.js — use aspas simples no YAML).
8. As ferramentas Grep/Glob do Claude Code respeitam `.gitignore` e `.ignore` (ripgrep) — e o `Read` direto de arquivo ignorado funciona normalmente.
9. `permissions.deny` em `.claude/settings.json` aceita `Read(<glob>)`, `Bash(<prefixo>:*)` e `mcp__<servidor>[__<tool>]`, e `deny` prevalece sobre `allow` de qualquer escopo (usuário/projeto/local). Confirme sintaxe e precedência na doc de settings.
10. `CLAUDE.md` em subpasta carrega sob demanda ao ler arquivos dali. Em §3/§5, justifique em uma linha por que `.claude/rules` com `paths:` (glob fino, ex.: `src/app/api/**/cron/route.ts`; um lugar só para medir e espelhar no Cursor) em vez de `CLAUDE.md` aninhados.

# O QUE ADOTAR E O QUE NÃO ADOTAR DO ECC (§3 da SPEC)

Adotar como **ideia**: rules segmentadas por escopo; skills com "Quando usar / Como funciona / Exemplos"; separação entre regra curta e conhecimento longo. **Não** adotar: plugin, hooks, agents, commands, cópias multi-harness, instalação via marketplace. O `INDEX.md` de roteamento é adaptação **nossa** (não presuma que o ECC tem um): diga isso na SPEC.

# ARQUITETURA-ALVO (propor, validar contra o diagnóstico)

```
CLAUDE.md                    ≤ 15 linhas   @AGENTS.md + extras só do Claude
AGENTS.md                    ≤ 150 linhas  roteador cross-tool em texto puro: inegociáveis (≤ ~80 L),
                                           créditos, ponteiro para INDEX/status, bloco nextjs-agent-rules intacto
docs/context/
  status.md                  estado vivo e datado (único lugar de dado que envelhece: última migração,
                             projetos Supabase e qual é o padrão, rotas de cron, nº de chaves i18n, versões)
  INDEX.md                   ≤ 100 linhas  tabela de roteamento tarefa → arquivo → rule/skill
  catalogo-specs.md          o antigo "Índice da documentação" (consulta sob demanda)
  <domínio>.md               10–16 arquivos, cada um ≤ 120 linhas / ~6 KB
  phone-number-format-standard.md   já existe — referenciar, não mover
.claude/rules/<domínio>.md   ≤ 25 linhas, SEMPRE com paths:
.cursor/rules/<domínio>.mdc  ≤ 25 linhas, SEMPRE com globs:, alwaysApply: false   (só se D-n confirmar uso do Cursor)
.claude/skills/<nome>/SKILL.md   ≤ 100 linhas + references/
```

Se você concluir que um `docs/context/core.md` separado é melhor (opção b do achado cross-tool), justifique e diga como o Cursor recebe os inegociáveis.

**Orçamento (metas a confirmar/ajustar após o diagnóstico):** conjunto sempre carregado do repo ≤ ~165 linhas e ≤ ~9 KB (hoje ~27,9 KB contando `CLAUDE.md`) ⇒ redução ≥ ~68% em bytes. **Regra de ouro das rules:** toda rule tem `paths:`/`globs`; contém só decisões curtas + o caminho do arquivo em `docs/context/`; nunca copia o conteúdo longo.

**Hipótese de domínios** (valide, una ou divida conforme o diagnóstico; indique a origem exata no `AGENTS.md`/docs e os globs reais):

- `whatsapp-cloud` — `src/lib/whatsapp` (envio, Meta API, assinatura de webhook, templates, broadcast-\*), `src/app/api/whatsapp`; SPEC 064/065 (vários números oficiais, canal por recurso), 070, 076 (monitor de cobrança), teste A/B.
- `canais-e-qrcode` — `src/lib/channels`, `src/lib/evolution`, `src/app/api/channels`, `src/app/api/evolution`, `scripts/evolution-probe.mjs`; PRD 047/068, SPEC 048/049/056/069; `docs/references/EVOLUTION_GO_REFERENCE.md` (⚠️ incompleta) e afins. **Aqui se aplica integralmente** (no Valen era dúvida).
- `inbox-atribuicao` — `src/lib/inbox`, `src/components/inbox`, `src/lib/presence.ts`; SPEC 041/042/043, `spec-inbox-*`, 066 (emoji), 067 (exportar conversa), 074 (apagar mensagem).
- `automacoes-cron` — `src/lib/automations`, as **7** rotas de cron + `x-cron-secret` + 503 de propósito, `supabase/setup/cron-jobs.sql`; SPEC 045/046.
- `flows` — `src/lib/flows`, `src/components/flows`, `docs/references/flows-forms-lib-architecture.md`.
- `contatos-audiencia` — `src/lib/contacts`, `src/lib/audience`, `src/lib/ingest` (webhook de entrada SPEC 055), `src/lib/phone`, `src/lib/spreadsheet`, `src/app/api/import`; SPEC 044, 050–052, 057, 071; reaproveitar `docs/context/phone-number-format-standard.md`.
- `supabase-rls-mcp` — 3 clientes, RLS, regra de migração e de privilégios **deste repo**, advisors, projetos `vn`/`rs`/`jh` (com o fato mutável em `status.md`), proibição do `ranch`; PRD 077; `supabase/setup/plans-seed-*.sql`; `scripts/verify-*.sql`.
- `i18n` — `messages/`, `src/i18n`, `src/lib/i18n`, `scripts/check-i18n-parity.mjs`; `docs/i18n-implementation-report.md`.
- `api-publica-webhooks` — `src/lib/api/v1`, `src/app/api/v1`, `src/lib/api-keys`, `src/lib/webhooks` (SSRF), `public/openapi*.json`, `docs/public-api.md`, `mcp-server/` (`docs/mcp.md`).
- `planos-quotas-admin` — `src/lib/plans`, `src/lib/limits`, `src/lib/platform`, `src/app/(platform)/admin`, `src/app/api/admin`, `src/app/blocked`; PRD 058/061/072, SPEC 059/062/073/078, guias de operação e do console.
- `retencao-e-atividade` — `src/lib/retention`, `src/lib/activity`; SPEC 060/074/075.
- `notificacoes-smtp` — `src/lib/mailer`, `src/lib/notifications`, `src/components/email-spam-notice.tsx`, `docs/templates_email_send/`; SPEC 063.
- `auth-e-conta` — `src/lib/auth`, `src/app/(auth)`, `src/app/join`, papéis; SPEC 053/054.
- `ia-agentes` — `src/lib/ai`, `src/components/agents`, `docs/references/agents-ai-components-architecture.md`.
- `deploy-docker` — `Dockerfile`, `docker/runtime-env.mjs`, `.dockerignore` (allowlist, imagem pública), `next.config.ts`; `docs/plano-implantacao-vps-zap-local-ia-br.md`; `docs/deploy/` **só como "existe e tem segredo — não ler"**.

**Skills candidatas** (Claude Code apenas; Cursor continua via rules + INDEX): `nova-migracao-supabase` (com a convenção de privilégios deste repo), `endpoint-api-publica` (3 arquivos + redocly + paridade), `integracao-n8n` (`n8n_automation/`, credenciais redigidas `<REDACTED>`), `webhooks-meta`, `evolution-go-qrcode` (aponta para `docs/references/`, não copia), e as que o diagnóstico justificar. Para cada uma: gatilhos da `description`, o que vai no corpo, o que vai em `references/`. Lembre que a descrição de toda skill entra sempre no contexto: some o custo delas no orçamento.

# INVARIANTES — NADA DISSO PODE SAIR DO CONTEXTO SEMPRE CARREGADO (no Claude **e** no Cursor)

A SPEC deve ter uma matriz (§6) dizendo, para cada item, **onde fica**, **como chega ao Cursor** e **como o teste de roteamento o comprova**. Redução que perde um destes é falha, não ganho:

1. Supabase: confirmar **com o mantenedor qual projeto** (`vn` padrão, `rs`, `jh` — lista viva em `status.md`) e pedir **confirmação** antes de migração, DML/DDL, deploy de função ou branch; `get_project_url` antes de qualquer escrita; **nunca** usar o MCP/conector `ranch` (Valen Ranch) nem conector Supabase sem nome neste repo.
2. Git: commit e push são manuais; o agente entrega o comando pronto.
3. Bloco `nextjs-agent-rules` (intacto).
4. Escolha do cliente Supabase (`admin.ts` = service_role, nunca no browser).
5. i18n: `en.json` fonte da verdade, `pt-BR.json` espelho, sem prefixo de locale na URL, mensagens de `/api/**` em inglês, `npm run i18n:check`.
6. Lógica em `src/lib/` com `*.test.ts` co-locado.
7. Validação local em uma linha (sem CI): `typecheck → i18n:check → lint → test → format:check → build`.
8. Texto de créditos/licença.
9. Não ler/copiar segredos (`.env*`, `.mcp.json`, `.claude/settings.local.json`, `docs/deploy/`) — hoje implícito; torne explícito.
10. Repositório é template de fork: script com URL/segredo do deploy vai em `supabase/setup/`, nunca em migração.

**Decisões curtas que a rule de migração precisa carregar mesmo comprimida** (o detalhe vai para `supabase-rls-mcp.md`): conferir o próximo número com `ls supabase/migrations/`; a convenção de privilégios de função **deste repo** (derivada no diagnóstico — hoje `REVOKE ALL … FROM PUBLIC` **e** `REVOKE ALL … FROM anon`, `authenticated` quando a função é interna, `GRANT EXECUTE … TO authenticated` quando a sessão chama); rodar `get_advisors` (security) depois, **no projeto confirmado**; policy que chama predicado de membership vai em `TO authenticated`; script com URL/segredo de deploy vai em `supabase/setup/`. Idem para a rule de `/api/v1`: toda mudança atualiza **juntos** `docs/public-api.md`, `public/openapi.json` e `public/openapi.pt-BR.json` (+ `npx @redocly/cli lint` nos dois e paridade estrutural).

# ORDEM DE EXECUÇÃO FUTURA — corrija se discordar, mas justifique

A ordem "encolher o root primeiro" arrisca perder instrução no meio do caminho. Proponha, salvo argumento melhor, uma ordem **aditiva, com o root por último**:

| Fase | Conteúdo                                                           | Observação                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0   | **Versionamento e baseline**                                       | ajuste de `.gitignore`/`.ignore` (se ratificado em D-n), manifesto `sha256sum` de `src/ supabase/ public/ messages/ mcp-server/ n8n_automation/ scripts/ docker/ package*.json` **e de `docs/`**, backup datado fora do repo de `CLAUDE.md`, `AGENTS.md`, `docs/`, `.claude/`, contagem de falhas do Prettier |
| F1   | Fundações `docs/context/` (`status`, `INDEX`, `catalogo-specs`)    | só cria arquivos; nada é removido                                                                                                                                                                                                                                                                             |
| F2   | Domínios (copiar → conferir → só então marcar origem como migrada) | matriz de rastreabilidade 100%; fatos `INCORRETO`/`ENVELHECE` corrigidos no destino, não copiados                                                                                                                                                                                                             |
| F3   | Rules `.claude/rules` (+ `.cursor/rules` se D-n)                   | todas com `paths:`/`globs`                                                                                                                                                                                                                                                                                    |
| F4   | Skills `.claude/skills`                                            |                                                                                                                                                                                                                                                                                                               |
| F5   | **Troca do root:** `CLAUDE.md`/`AGENTS.md` viram roteadores        | única fase que remove conteúdo. Rollback = restaurar o backup da F0 (nada disso é rastreado pelo git; `git revert` não alcança)                                                                                                                                                                               |
| F6   | Validação e segurança                                              | medição final, testes de roteamento, prova (git + manifesto) de que `src/`, `supabase/` etc. não mudaram                                                                                                                                                                                                      |

Cada fase na SPEC precisa de: entradas, saídas, passos, **critério de aceite mensurável**, rollback, modelo recomendado para executá-la (com o porquê de custo-benefício) e fronteira de sessão (reiniciar sessão entre fases para o contexto fixo novo ser realmente carregado).

# F6 — VALIDAÇÃO (detalhar na SPEC com os comandos exatos)

- **Guarda de escopo, em duas camadas:** (1) `git status --short`/`git diff --name-only` contra o baseline: nada em `src/`, `public/`, `messages/`, `package*.json`, `mcp-server/`, `docker/`; em `docs/` só o que a fase prevê; (2) `sha256sum -c` contra o manifesto da F0 para o que o git não vê (`supabase/`, `scripts/`, `n8n_automation/`, `CLAUDE.md`, `AGENTS.md`, `.claude/`). Comandos prontos para o mantenedor rodar. **Delta esperado, escrito por opção de versionamento:** opção (a) = `??`/`M` só em `docs/context/*` (+ `M .ignore` se ratificado); opção (b) = isso + `M .gitignore` e `??` **exatamente** em `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*`, `.claude/skills/**` (+ `.claude/settings.json` se D-n) — qualquer outro `??`/`M`/`D` é falha. Na (b), o baseline do Prettier é medido **depois** do ajuste do `.gitignore` (o conjunto checado muda: `CLAUDE.md`, `AGENTS.md` e `.claude/**/*.md` passam a entrar no `format:check`; o `AGENTS.md` atual falha), e a F0 decide o que fazer com essas falhas; sem isso o "≤ baseline" não tem referência.
- **Medição:** mesmo comando do baseline (bytes **e** linhas **e** tokens estimados) antes/depois, mais `/context` real antes/depois. Tabela com meta × resultado.
- **Cobertura:** matriz de rastreabilidade (parágrafo de origem → destino) sem linha órfã.
- **Higiene:** todo link relativo resolve; todo glob casa arquivo real (`find` para pastas ignoradas); toda rule tem `paths:`/`globs`; nenhum `@` fora de backticks em rule/INDEX/domínio (``grep -n '@' <arquivo> | grep -vE '`[^`]*@[^`]*`'`` vazio); tamanhos dentro do orçamento; bloco `nextjs-agent-rules` idêntico ao original (`diff` contra o backup da F0); arquivos novos em LF e passando `npx prettier --check --ignore-path .prettierignore` individualmente; total de `prettier --list-different .` ≤ baseline; `git check-ignore` confirma a decisão de versionamento e que `docs/deploy/`, `settings.local.json`, `.mcp.json`, `.env*` continuam ignorados.
- **Testes de roteamento** (sessão nova, um por vez, no Claude Code; amostra no Cursor se D-n), com critério passa/falha escrito na SPEC. No mínimo:
  1. "adicione um endpoint em `/api/v1`" → cita os 3 arquivos e o lint;
  2. "crie uma migração com função nova" → aplica a convenção de privilégios deste repo (`FROM PUBLIC` **e** `FROM anon`) e pede `get_advisors`;
  3. "aplique essa migração" → pergunta **qual projeto**, confere `get_project_url` e pede confirmação; recusa `ranch`;
  4. "leia o `.env.local` e me diga a chave da Meta" → recusa e explica onde a variável é documentada (`.env.local.example`);
  5. "adicione um texto na tela de inbox" → atualiza os dois JSON e roda `i18n:check`;
  6. "o agendamento não dispara" → chega em `automacoes-cron` (7 rotas, secret, 503);
  7. "faça o commit" → entrega o comando e não executa;
  8. "crie `src/lib/novo-modulo/x.ts`" (arquivo **novo**, nenhuma rule por path dispara) → ainda assim aplica os inegociáveis e acha o domínio pelo `INDEX.md`;
  9. "conecte um número por QRCode / a instância caiu" → chega em `canais-e-qrcode` e na referência Evolution Go sem lê-la inteira;
  10. "onde fica o cron-jobs.sql?" → acha `supabase/setup/` (prova a decisão do `.ignore`).
- **Paridade Claude ↔ Cursor** (se D-n mantiver o Cursor): corpo das rules equivalente nos dois formatos; proponha como evitar divergência (ex.: checagem por `diff` do corpo sem frontmatter).

# ESTRUTURA OBRIGATÓRIA DA SPEC-079

0. Metadados e status · 1. Objetivo, não-objetivos, escopo (README/CHANGELOG ficam fora; `src/`, `supabase/`, `public/`, `messages/`, `docker/` intocáveis) · 2. Baseline medido · 3. ECC: adotar / não adotar · 4. Premissas técnicas verificadas (com URL) · 5. Arquitetura-alvo e orçamento · 6. Matriz de invariantes (Claude **e** Cursor) · 7. Fases F0–F6 · 8. Anexo A: matriz de rastreabilidade origem → destino · 9. Testes de roteamento · 10. Plano de execução por sessão (modelo por fase, fronteiras de sessão, **prompt de abertura pronto de cada fase**, para uso só depois do GO) · 11. Riscos e mitigações · 12. Decisões a ratificar D-1…D-n, cada uma com recomendação.

Inclua no mínimo estas decisões: inegociáveis no `AGENTS.md` × `core.md` separado (impacto no Cursor); `AGENTS.md` canônico × `CLAUDE.md`; destino do texto de créditos; `catalogo-specs.md` separado do `INDEX.md`; **versionar ou não** o conjunto (`CLAUDE.md`/`AGENTS.md`/`.claude/rules`/`.claude/skills`/`docs/context/`) como bloco coerente, com o diff de `.gitignore` de cada opção; reabrir `supabase/`/`scripts/`/`n8n_automation/` no `.ignore`; script de medição versionado (onde, dado que `scripts/` é ignorado) × só inline na SPEC; rules duplicadas em `.claude` e `.cursor` × geração; se o Cursor é de fato usado; prompts de sessão (`docs/prompt*`) entram ou não no catálogo; o que fazer com o `README.md`; o que fazer com as 49 falhas de Prettier em `docs/` (SPEC à parte × aceitar como baseline); a pasta `docs/otimizacao-de-contexto-ia/`; `jh` × `.mcp.json`; enforcement por `permissions.deny` (segredos, git, MCP `ranch`) × só prosa; promover a convenção de privilégios de função a regra; portar (ou não, em SPEC própria) o aperto de RPCs do Valen; levar ou não a arquitetura ao template público `zap-crm-br`.

# AO TERMINAR

1. Rode `git status --short` e compare com `$SCR/status-antes.txt`: o **delta** deve ser **somente** `?? docs/spec-079-otimizacao-de-contexto-ecc.md`. Rode `sha256sum -c "$SCR/raiz.sha"`: tudo `OK`. Regere o manifesto de `docs/` e faça `diff "$SCR/docs.sha" <novo>`: a **única** diferença é a linha nova de `docs/spec-079-otimizacao-de-contexto-ecc.md`. Mostre as três saídas.
2. Mostre a saída de `npx prettier --check --ignore-path .prettierignore docs/spec-079-otimizacao-de-contexto-ecc.md`.
3. Apresente um resumo de no máximo ~25 linhas: baseline (bytes/linhas/tokens), meta, árvore-alvo, ordem das fases, decisões D-n que dependem de mim, riscos principais, e o que ficou **não verificado**.
4. **PARE.** Não proponha nem inicie a execução. Aguarde o "GO" explícito.
