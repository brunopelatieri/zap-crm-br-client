# syntax=docker/dockerfile:1
# (habilita os `--mount=type=cache` abaixo — BuildKit, padrão no Docker 23+)

# ZAP CRM BR — imagem de produção (VPS / Docker Swarm / Portainer)
#
# Imagem ÚNICA e PÚBLICA, sem segredo e sem configuração dentro:
#   docker build --platform linux/amd64 -t SEU_USUARIO/zapcrm:AAAAMMDD-N .
# (nenhum --build-arg). URL/chave do Supabase, domínio, idioma e cadastro público
# vêm de `environment:` da stack no Portainer, lidos quando o container sobe
# (docker/runtime-env.mjs troca marcadores no código gerado pelo Next).
#
# Segredos (service_role, ENCRYPTION_KEY, etc.) NUNCA entram aqui — só na stack.

# ---- deps: instala as dependências (camada de cache própria) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# npm 11, o MESMO do ambiente de dev que gerou o package-lock.json. A imagem
# node:22 traz npm 10, e o `npm ci` dele recusa o lock com
#   "Missing: @swc/helpers@0.5.23 from lock file":
# `next-intl` > `@swc/core` declara o peer OPCIONAL `@swc/helpers >=0.5.17`,
# enquanto `next` fixa `@swc/helpers@0.5.15`. O npm 11 tolera esse peer
# opcional inválido; o npm 10 tenta resolvê-lo e não acha no lock. Subir o
# npm da imagem é mais seguro do que regenerar o lock com outra versão.
# Ao atualizar o npm do dev, atualize esta versão junto.
RUN --mount=type=cache,target=/root/.npm npm install -g npm@11.17.0

# Cache do npm fora da camada: rebuild com o mesmo lock não baixa tudo de novo,
# e o tarball baixado não fica gravado na imagem.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- build ----
FROM deps AS build
COPY . .

# Marcadores no lugar dos valores reais de NEXT_PUBLIC_*. O Next os grava no
# bundle do navegador, no middleware e no servidor; ao subir, runtime-env.mjs
# troca cada um pelo valor da stack. Têm de ser IGUAIS aos de docker/runtime-env.mjs
# (o `--verify-build` abaixo reprova o build se divergirem). Os de URL precisam ser
# URLs válidas porque o build executa `new URL(...)` (src/app/layout.tsx).
ENV NEXT_PUBLIC_SUPABASE_URL=https://zapcrm-placeholder-supabase-url.invalid \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=zapcrm-placeholder-supabase-anon-key \
    NEXT_PUBLIC_SITE_URL=https://zapcrm-placeholder-site-url.invalid \
    NEXT_PUBLIC_APP_LOCALE=zapcrm-placeholder-app-locale \
    NEXT_PUBLIC_SIGNUP_ENABLED=zapcrm-placeholder-signup-enabled \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone

# Saída `standalone` (NEXT_OUTPUT acima, lida pelo next.config.ts): o build gera
# .next/standalone com SÓ as dependências que o código usa — é isso que tira a
# imagem de ~2 GB (node_modules inteiro, com devDependencies, SWC, TypeScript…).
# O cache do webpack (.next/cache) fica num volume do BuildKit: acelera o rebuild
# e não entra em camada nenhuma.
RUN --mount=type=cache,target=/app/.next/cache npm run build

# Garante que cada marcador chegou ao código gerado. Sem isto, uma variável que o
# minificador resolveu no build subiria "configurada" mas ignorando a stack.
RUN node docker/runtime-env.mjs --verify-build

# O `sharp` (com o libvips, ~18 MB) só serve ao otimizador do next/image, que a saída
# standalone desliga (`images.unoptimized` no next.config.ts). Ele continua no pacote
# porque o rastreio do Next o inclui mesmo sem uso.
RUN rm -rf .next/standalone/node_modules/sharp .next/standalone/node_modules/@img

# ---- node-bin ----
# O binário oficial do Node sem os símbolos de depuração nativos (~18 MB a menos).
# Não afeta o Node nem o stack trace do JavaScript; só o backtrace de um crash em C++.
FROM node:22-bookworm-slim AS node-bin
RUN apt-get update \
 && apt-get install -y --no-install-recommends binutils \
 && strip --strip-all /usr/local/bin/node \
 && /usr/local/bin/node --version

# ---- run ----
# Só o que o Node precisa do sistema: glibc, libstdc++ e tzdata, do mesmo Debian 12
# da node:22-bookworm-slim. O binário já embute OpenSSL, ICU completo para pt-BR e as
# CAs da Mozilla. npm, npx, corepack, apt e perl ficam de fora: cada um é superfície
# de CVE a menos.
FROM gcr.io/distroless/cc-debian12 AS run

# O distroless não tem shell, mas o CMD abaixo, o console do Portainer e um eventual
# healthcheck da stack dependem de um. BusyBox estático: ~1 MB e sem dependências.
COPY --from=busybox:1.37.0-musl /bin /bin
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node

# Usuário `node` com o mesmo UID/GID 1000 da imagem oficial (volumes e permissões
# continuam iguais) + diretório de cache de ISR gravável por ele.
RUN echo 'node:x:1000:1000::/home/node:/bin/sh' >> /etc/passwd \
 && echo 'node:x:1000:' >> /etc/group \
 && mkdir -p /home/node /app/.next/cache \
 && chown -R node:node /home/node /app

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Servidor mínimo gerado pelo Next (inclui os .ttf do PDF de exportação, via
# `outputFileTracingIncludes` do next.config.ts, e os `node_modules` rastreados).
COPY --from=build --chown=node:node /app/.next/standalone ./
# O standalone NÃO copia estes dois — é o próprio Next que manda copiar à mão.
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Troca os marcadores pelos valores da stack e só então sobe o servidor. Falta
# variável obrigatória? O container para com a mensagem no log (em vez de subir
# quebrado e responder 500 em tudo).
COPY --chown=node:node docker/runtime-env.mjs ./runtime-env.mjs

USER node
EXPOSE 3000
CMD ["sh", "-c", "node runtime-env.mjs && exec node server.js"]
