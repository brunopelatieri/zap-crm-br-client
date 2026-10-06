# ZAP CRM BR — imagem de produção (VPS / Docker Swarm / Portainer)
#
# ⚠️ As variáveis NEXT_PUBLIC_* são EMBUTIDAS no bundle do navegador em
# tempo de build. Por isso entram como ARG aqui, não só como `environment`
# da stack: trocar a URL pública ou a chave anon exige RECONSTRUIR a imagem.
# Segredos (service_role, ENCRYPTION_KEY, etc.) NUNCA entram aqui — só na stack.
#
# Build (ver docs/plano-implantacao-vps-zap-local-ia-br.md §F1):
#   docker build -t zapcrm:$(date +%Y%m%d-%H%M) \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://zap.local.ia.br .

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=pt-BR
ARG NEXT_PUBLIC_SIGNUP_ENABLED
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_PUBLIC_SIGNUP_ENABLED=$NEXT_PUBLIC_SIGNUP_ENABLED \
    NEXT_TELEMETRY_DISABLED=1

# Sem `npm prune --omit=dev`: o `next start` precisa carregar o
# next.config.ts e não vale arriscar a 1ª implantação por ~300 MB de imagem.
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Sem `output: 'standalone'` de propósito na 1ª implantação: `next start`
# com node_modules completo é o caminho que o `npm run build` já valida e
# não mexe no next.config.ts. Imagem maior, risco menor.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/messages ./messages
COPY --from=build /app/next.config.ts ./next.config.ts
# Fontes do PDF de exportação (SPEC 067) — lidas do disco em tempo de execução.
COPY --from=build /app/src/lib/inbox/export/fonts ./src/lib/inbox/export/fonts

USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
