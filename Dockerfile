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
RUN npm install -g npm@11.17.0

COPY package.json package-lock.json ./
RUN npm ci

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
RUN npm run build

# Garante que cada marcador chegou ao código gerado. Sem isto, uma variável que o
# minificador resolveu no build subiria "configurada" mas ignorando a stack.
RUN node docker/runtime-env.mjs --verify-build

FROM node:22-bookworm-slim AS run
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
# Cache de imagens/ISR em runtime precisa de diretório gravável pelo usuário node.
RUN mkdir -p .next/cache && chown node:node .next/cache

# Troca os marcadores pelos valores da stack e só então sobe o servidor. Falta
# variável obrigatória? O container para com a mensagem no log (em vez de subir
# quebrado e responder 500 em tudo).
COPY --chown=node:node docker/runtime-env.mjs ./runtime-env.mjs

USER node
EXPOSE 3000
CMD ["sh", "-c", "node runtime-env.mjs && exec node server.js"]
