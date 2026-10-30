---
paths:
  - 'src/lib/plans/**'
  - 'src/lib/limits/**'
  - 'src/lib/platform/**'
  - 'src/app/*/admin/**'
  - 'src/app/api/admin/**'
  - 'src/app/api/platform/**'
  - 'src/app/blocked/**'
  - 'src/components/platform/**'
  - 'src/components/plan/**'
  - 'supabase/setup/plans-seed*.sql'
---

# Planos, quotas, console `/admin` e bloqueio

- O banco decide, o app explica: quota é trigger no Postgres (o navegador insere direto); guarda só em rota é contornável. `quotas_enforced` varia por ambiente: consulte o banco.
- Catálogo comercial vai em `supabase/setup/` (`plans-seed*.sql`), nunca em migração.
- O console não afrouxa RLS: nada de policy `is_platform_owner()`; leitura entre contas é rota de servidor com `requirePlatformOwner()`. Sem `PLATFORM_OWNER_EMAILS`, `/admin` e `/api/platform/**` dão `404`; `/api/admin/**` exige `x-admin-secret` (`503` sem a variável).
- Bloqueio tem três camadas (RLS via `is_account_member`, sessão via `AccountBlockedError`, motores); a ingestão de mensagens continua. Ao redefinir `is_account_member`, mantenha `STABLE` e `OWNER TO postgres`.
- Vencimento por `addMonths`; renovação idempotente por `paymentRef`; id de pagamento manual vai literal.
- Excluir a conta segue a ordem canônica da SPEC 073 §4 (não troque); excluir `auth.users` cascateia por `user_id`.
- Limite fora de `src/lib/limits/registry.ts` é limite escondido.

Detalhe: leia `docs/context/planos-quotas-admin.md`.
