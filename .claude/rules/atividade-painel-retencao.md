---
paths:
  - 'src/lib/retention/**'
  - 'src/lib/activity/**'
  - 'src/lib/dashboard/**'
  - 'src/components/retention/**'
  - 'src/components/activity/**'
---

# Atividade, painel e retenção de mensagens

- Dois escritores no registro de atividade: trigger `SECURITY DEFINER` (o que o navegador grava direto) e `recordActivity()` (o que só a rota ou o motor sabe); rota que esquece de chamá-la não registra.
- O INSERT do registro passa por `supabaseAdmin()` (a tabela é append-only por RLS e grant); `recordActivity` nunca lança. Não é o `platform_audit_log`.
- Visibilidade (LGPD): `admin`/`owner` veem tudo e abrem `/activity`; `agent` só o que ele mesmo fez; `viewer` nada. Não amplie o corte do agente.
- Retenção de mensagens nasce desligada (`MESSAGE_RETENTION_ENABLED`); o piso de idade prevalece sobre qualquer política; ausência de configuração e `0` significam não apagar.
- O banco executa a limpeza (`purge_channel_messages`) e o TypeScript decide os números (`policy.ts`); não troque por laço em Node.
- Política e padrões de retenção se editam só no console do proprietário.
- O painel agrega sobre dados que a RLS já escopou; módulo novo que leia `conversations` respeita a atribuição por linha.

Detalhe: leia `docs/context/atividade-painel-retencao.md`.
