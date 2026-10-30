---
paths:
  - 'Dockerfile'
  - 'docker/**'
  - 'next.config.ts'
  - '.dockerignore'
---

# Deploy, Docker e build

- `docs/deploy/` tem segredo (stack com valores reais): não leia, não copie, não cite.
- Imagem pública sem segredo e sem `--build-arg`; segredos entram só na stack do Portainer.
- `NEXT_PUBLIC_*` usa marcador idêntico no `Dockerfile` e em `docker/runtime-env.mjs`; variável nova exige marcador nos dois lugares e `node docker/runtime-env.mjs --verify-build`.
- `.dockerignore` é allowlist: arquivo novo na raiz só entra com `!` deliberado.
- `build` é `next build --webpack` (Turbopack só no `dev`); rode `npm run build` antes de publicar.
- `ENCRYPTION_KEY` do novo ambiente é a mesma do anterior; outra chave deixa tokens e chaves de IA ilegíveis.
- Cron em um agendador só por vez; Site URL do Supabase Auth e webhooks já registrados precisam ser repontados.
- CSP é `Report-Only`: host novo entra em `connect-src` / `img-src` / `media-src` antes de virar bloqueante.

Detalhe: leia `docs/context/deploy-docker.md`.
