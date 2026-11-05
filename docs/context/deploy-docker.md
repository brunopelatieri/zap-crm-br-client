# Deploy, Docker e build

> Domínio da SPEC 079. Rule: `.claude/rules/deploy-docker.md`. Versões, bundler e Node: [`status.md`](./status.md) (não repita aqui). Rotas de cron: [`automacoes-cron.md`](./automacoes-cron.md). Mapa: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Imagem de produção:** `Dockerfile` (estágios `deps` → `build` → `run`)
- **Variáveis `NEXT_PUBLIC_*` em runtime:** `docker/runtime-env.mjs`
- **Contexto de build:** `.dockerignore` (**allowlist**)
- **Saída `standalone`, cabeçalhos, imagens:** `next.config.ts`
- **Plano de implantação na VPS:** [`../plano-implantacao-vps-zap-local-ia-br.md`](../plano-implantacao-vps-zap-local-ia-br.md)
- **Comandos de validação:** [`../comandos-desenvolvimento.md`](../comandos-desenvolvimento.md)

`docs/deploy/` **existe e contém segredo (stack com valores reais) — não ler, não copiar para chat, não citar conteúdo.** A pasta é ignorada pelo Git de propósito.

## Regras que não podem quebrar

1. **Uma imagem pública, sem segredo e sem configuração dentro.** Nada de `--build-arg`: `docker build --platform linux/amd64 -t …` sem argumentos. Segredos (`service_role`, `ENCRYPTION_KEY`, …) entram **só** na stack do Portainer, jamais no Dockerfile.
2. **`NEXT_PUBLIC_*` são gravadas no bundle no build**, então o Dockerfile usa valores-**marcador** e `docker/runtime-env.mjs` troca cada um pelo valor da stack ao subir o container (`CMD`: `node runtime-env.mjs && exec node server.js`). Os marcadores têm de ser **idênticos** no `ENV` do Dockerfile e em `PLACEHOLDERS` do script — `node docker/runtime-env.mjs --verify-build` reprova o build se divergirem ou se o minificador "resolveu" alguma. Variável obrigatória ausente = o container **para** com mensagem no log, em vez de subir e responder 500. Variável `NEXT_PUBLIC_*` nova exige marcador nos dois lugares. (O plano de implantação ainda descreve `--build-arg`: está superado pelo Dockerfile.)
3. **`.dockerignore` é lista de permissão** (`*` ignora tudo; `!` libera `src`, `public`, `messages`, `docker` e a configuração do build). Arquivo novo na raiz **não** entra sozinho — se o build falhar por falta de um, libere-o de propósito. Existe para impedir que `.env*`, `.mcp.json`, `.claude/`, `docs/deploy` ou dump vire camada de uma imagem pública. `docs/` e `*.md` ficam fora mesmo versionados.
4. **Turbopack só no `dev`; o `build` roda `next build --webpack`** (fonte: [`status.md`](./status.md), seção Stack e build). Não "corrija" o `build` para Turbopack nem presuma que o que roda no `dev` passa no host.
5. **Saída `standalone` é condicional** (`NEXT_OUTPUT=standalone`, ligado no Dockerfile). `next dev`, `npm run build` e hospedagem com `next start` (Hostinger) seguem como antes; `next start` não serve um build standalone. Arquivo que o servidor lê em runtime e o rastreio não enxerga (ex.: fontes `.ttf` do PDF de exportação) entra por `outputFileTracingIncludes`.
6. **`ENCRYPTION_KEY` do novo ambiente tem de ser a mesma do anterior**: tokens da Meta e chaves de IA gravados ficam ilegíveis com outra chave. Troque de ambiente só copiando a chave, nunca gerando outra.
7. **Imagem final enxuta**: base `distroless/cc` (Debian 12, glibc) com o binário do Node sem símbolos e BusyBox estático (o `CMD` e o console do Portainer precisam de shell), usuário `node` (UID 1000), `npm`/`npx`/`apt` fora. O `sharp` é removido e `images.unoptimized` fica ligado só no `standalone`: `next/image` nunca otimiza nessa imagem, então mídia pesada nova deve ser leve na origem. Use o npm do Dockerfile (versão fixada junto do `package-lock.json`): o npm 10 recusa o lock.
8. **Cron fica em um agendador só por vez.** Ao mudar de host, desligue o do host antigo antes de ligar o novo (chamadas duplicadas). Cookie de sessão é por domínio: usuários reentram ao trocar de domínio.
9. **Site URL e Redirect URLs do Supabase Auth** precisam apontar para o domínio novo — senão convite e redefinição de senha vão para o domínio antigo ou `localhost` ([`auth-e-conta.md`](./auth-e-conta.md)).
10. **Webhooks já registrados guardam a URL antiga** (instâncias Evolution e Meta). Depois da virada, repontar; não presuma que o app re-registra.

## CSP

`next.config.ts` envia `Content-Security-Policy-Report-Only` (nada é bloqueado, só reportado). Rota nova que carregue recurso de outro host precisa entrar em `connect-src`/`img-src`/`media-src` antes de a política virar bloqueante.

## Armadilhas

| Sintoma                              | Causa provável                                                      |
| ------------------------------------ | ------------------------------------------------------------------- |
| Build passa em `dev` e falha no host | `dev` é mais tolerante — sempre rodar `npm run build` antes do push |

Outras: container reinicia no boot = variável obrigatória faltando na stack (leia o log do `runtime-env`); build falha por arquivo "inexistente" = faltou `!` no `.dockerignore`; trocar o URL do Supabase na stack "não pega" = marcador fora de sincronia ou variável sem marcador.

## Validação antes de publicar

Rode a sequência obrigatória do `AGENTS.md` (tipos, i18n, lint, testes, formatação e `npm run build`). O passo de `build` equivale ao do host. Não há CI.

## Mais

[`../comandos-desenvolvimento.md`](../comandos-desenvolvimento.md) · README § "Validação local" · [`catalogo-specs.md`](./catalogo-specs.md).
