---
paths:
  - 'src/lib/auth/**'
  - 'src/app/*/login/**'
  - 'src/app/*/signup/**'
  - 'src/app/*/reset-password/**'
  - 'src/app/auth/**'
  - 'src/app/join/**'
  - 'src/middleware.ts'
  - 'src/lib/account/**'
  - 'src/app/api/account/**'
  - 'src/app/api/invitations/**'
---

# Autenticação, papéis e conta

- Papéis `viewer < agent < admin < owner` só por `hasMinRole` e pelos predicados de `roles.ts` (espelham `is_account_member` no SQL); nunca `role === …` à mão.
- O servidor repete toda guarda da UI (`requireRole`); `minRole` na interface só esconde o item.
- O middleware retorna cedo em `/auth/callback` e `/auth/confirm`, antes de `getUser()` (senão o verifier PKCE é apagado); rota nova de troca de token entra nessa exceção. Webhook de entrada novo sai do `matcher` (corpo >10 MB). Não existe `proxy.ts`. Redirect no middleware copia os cookies renovados (`withRefreshedCookies`).
- Link de e-mail não consome o token no GET: `/auth/confirm` chama `verifyOtp` só no clique.
- Origem pública vem de `resolveRequestOrigin`, nunca de `request.nextUrl.origin`.
- Senha só por `password-policy.ts` (limite em bytes UTF-8); erro de Auth precisa de chave no namespace (`CODE_TO_MESSAGE_KEY`).
- Convite guarda só o hash SHA-256; excluir ou transferir a conta é só do `owner`; a exclusão segue a ordem canônica da SPEC 073 §4 (`docs/context/planos-quotas-admin.md`).

Detalhe: leia `docs/context/auth-e-conta.md`.
