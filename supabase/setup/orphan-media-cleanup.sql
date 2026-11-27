-- ============================================================
-- orphan-media-cleanup.sql — objetos órfãos no bucket `chat-media`
-- (SPEC 060 §9)
--
-- ⚠️ ISTO NÃO É UMA MIGRAÇÃO. Não numere, não coloque em
--    `supabase/migrations/`, não rode em CI. É operação de ambiente,
--    para rodar manualmente de vez em quando — no mesmo espírito do
--    bloco opcional de purga em `cron-jobs.sql`.
--
-- Por que isto existe
--
--   A retenção de mensagens (migração 068) apaga a LINHA de `messages`,
--   nunca o arquivo no Storage — decisão deliberada do mantenedor
--   (SPEC 060 §9): é a opção mais segura (nenhum risco de apagar mídia
--   ainda referenciada por outra linha) e a mais barata (a varredura de
--   retenção não paga uma chamada assinada por mensagem). A
--   contrapartida é honesta: o bucket `chat-media` só CRESCE. Este
--   script fecha esse ciclo, à mão, quando o operador decidir que vale
--   a pena.
--
-- Escopo: só `chat-media` (mídia de conversa, `messages.media_path`).
--   `flow-media` NÃO entra — não é mídia de conversa, e a retenção
--   desta SPEC não toca nela.
--
-- Onde rodar: SQL Editor do painel do Supabase, no projeto do seu
-- deploy. Idempotente — rodar de novo só encontra menos (ou nenhum)
-- objeto órfão.
--
-- ⚠️ RODE O SELECT DE CONFERÊNCIA PRIMEIRO. Leia o resultado. Só depois
--    descomente o DELETE. Um objeto apagado no Storage não tem
--    "lixeira" — é a mesma regra de ouro da SPEC inteira (§1): apagar é
--    a única operação sem desfazer.
-- ============================================================


-- ============================================================
-- 1) CONFERÊNCIA — quantos objetos de `chat-media` não têm mais
--    `media_path` correspondente em `messages`?
--
--    `storage.objects.name` guarda o path DENTRO do bucket, no mesmo
--    formato que `messages.media_path` grava (sem prefixo de bucket —
--    ver `resolveMediaRef`, que hardcoda `bucket: 'chat-media'` para
--    todo path resolvido de `messages`). Por isso a comparação é uma
--    igualdade direta, sem parsing de URL.
-- ============================================================

SELECT count(*) AS orphan_objects,
       coalesce(sum((metadata->>'size')::bigint), 0) AS orphan_bytes
  FROM storage.objects o
 WHERE o.bucket_id = 'chat-media'
   AND NOT EXISTS (
     SELECT 1 FROM messages m
      WHERE m.media_path = o.name
   );

-- Quer ver QUAIS objetos, antes de decidir? Descomente:
--
-- SELECT o.name, o.created_at, (o.metadata->>'size')::bigint AS bytes
--   FROM storage.objects o
--  WHERE o.bucket_id = 'chat-media'
--    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.media_path = o.name)
--  ORDER BY o.created_at
--  LIMIT 200;


-- ============================================================
-- 2) LIMPEZA — comentado de propósito. Descomente só depois de ler o
--    resultado do SELECT acima.
--
--    `storage.objects` é uma tabela normal para fins de DELETE (o
--    binário em si é removido pelo Storage API de forma assíncrona
--    quando a linha correspondente some — comportamento do próprio
--    Supabase Storage, não algo que este script precisa orquestrar).
-- ============================================================

-- DELETE FROM storage.objects o
--  WHERE o.bucket_id = 'chat-media'
--    AND NOT EXISTS (
--      SELECT 1 FROM messages m
--       WHERE m.media_path = o.name
--    );


-- ============================================================
-- CONFERÊNCIA PÓS-LIMPEZA
-- ============================================================
--
-- Rode a query da seção 1 de novo — `orphan_objects` deve estar em 0
-- (ou perto disso, se novas mensagens foram apagadas pela retenção
-- entre as duas rodadas).
