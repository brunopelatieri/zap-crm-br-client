-- (IDs e nomes anonimizados para publicação; troque os <PLACEHOLDERS> antes de reutilizar)
-- Recuperação pós-incidente 2026-10-06 (projeto Supabase: vn)
-- Exclusão do usuário A (<ID_USUARIO_A>) apagou em cascata 1.627 contatos
-- da conta <ID_CONTA> via `user_id → auth.users ON DELETE CASCADE`.
--
-- O que este script faz (transação única — tudo ou nada):
--   1) Devolve Usuária B (<ID_USUARIO_B>) à conta <ID_CONTA> como admin
--      e reatribui a ela as 10 conversas que a remoção (19:39:59 UTC) desatribuiu.
--   2) Decodifica o telefone do wamid da Cloud API (`wamid.HBg<len><telefone>...`)
--      dos destinatários de disparo sem contato e do log de exclusão de mensagem,
--      recria os contatos em nome de Usuária C (<ID_USUARIO_C>),
--      com a etiqueta "Recuperado 06/10", e religa `broadcast_recipients.contact_id`.
--
-- Rodar no SQL Editor do Supabase (projeto vn). A conta pessoal vazia criada para
-- a Usuária B (<ID_CONTA_PESSOAL_B>) NÃO é apagada aqui — ver bloco opcional no fim.

create or replace function pg_temp.norm(d text) returns text language sql immutable as $$
  select case when x ~ '^55[1-9][0-9][6-9][0-9]{7}$' then substr(x,1,4)||'9'||substr(x,5) else x end
  from (select case when d !~ '^55' and length(d) in (10,11) then '55'||d else d end x) s $$;

begin;

-- 1) Usuária B
create temp table usr_b_conv on commit drop as
  select id from conversations
   where account_id = '<ID_CONTA>'
     and assigned_agent_id is null
     and updated_at between '2026-10-06 19:39:59.9+00' and '2026-10-06 19:40:00.5+00';

update profiles
   set account_id = '<ID_CONTA>', account_role = 'admin'
 where user_id = '<ID_USUARIO_B>';

update conversations
   set assigned_agent_id = '<ID_USUARIO_B>'
 where id in (select id from usr_b_conv);

-- 2) Telefones recuperados dos wamids
create temp table rec on commit drop as
select src, rid, pg_temp.norm(encode(substring(b from 4 for get_byte(b, 2)), 'escape')) p
from (
  select 'recipient' src, r.id rid,
         decode(translate(substr(r.whatsapp_message_id, 7, 24), '-_', '+/'), 'base64') b
    from broadcast_recipients r
    join broadcasts bb on bb.id = r.broadcast_id
   where r.contact_id is null
     and bb.account_id = '<ID_CONTA>'
     and r.whatsapp_message_id like 'wamid.HBg%' and length(r.whatsapp_message_id) >= 30
  union all
  select 'deletion_log', null,
         decode(translate(substr(provider_message_id, 7, 24), '-_', '+/'), 'base64')
    from message_deletion_log
   where account_id = '<ID_CONTA>'
     and provider_message_id like 'wamid.HBg%' and length(provider_message_id) >= 30
) x;

delete from rec where p !~ '^[0-9]{12,13}$';

insert into tags (user_id, account_id, name, color)
select '<ID_USUARIO_C>', '<ID_CONTA>', 'Recuperado 06/10', '#f59e0b'
 where not exists (select 1 from tags
                    where account_id = '<ID_CONTA>' and name = 'Recuperado 06/10');

create temp table novos on commit drop as
with ins as (
  -- phone_normalized é coluna gerada (regexp_replace(phone, '\D', '', 'g')) — não entra no INSERT
  insert into contacts (user_id, account_id, phone, name, created_via)
  select distinct '<ID_USUARIO_C>'::uuid,
         '<ID_CONTA>'::uuid, p, null::text, 'legacy'
    from rec
   where p not in (select coalesce(phone_normalized, regexp_replace(phone, '\D', '', 'g'))
                     from contacts where account_id = '<ID_CONTA>')
  returning id)
select id from ins;

insert into contact_tags (contact_id, tag_id)
select n.id, t.id
  from novos n
  join tags t on t.account_id = '<ID_CONTA>' and t.name = 'Recuperado 06/10'
on conflict do nothing;

create temp table relig on commit drop as
with upd as (
  update broadcast_recipients r
     set contact_id = c.id
    from rec, contacts c
   where rec.src = 'recipient' and r.id = rec.rid
     and c.account_id = '<ID_CONTA>'
     and coalesce(c.phone_normalized, regexp_replace(c.phone, '\D', '', 'g')) = rec.p
  returning r.id)
select id from upd;

select (select count(*) from usr_b_conv) as conversas_devolvidas_usuaria_b,
       (select account_role::text from profiles
         where user_id = '<ID_USUARIO_B>') as papel_usuaria_b,
       (select count(*) from rec)   as telefones_decodificados,
       (select count(*) from novos) as contatos_recriados_usuaria_c,
       (select count(*) from relig) as destinatarios_religados;

commit;

-- Opcional, DEPOIS de conferir o resultado acima: apagar a conta pessoal vazia
-- criada para a Usuária B na remoção (0 contatos, 0 conversas, 0 canais em 2026-10-06).
-- delete from accounts where id = '<ID_CONTA_PESSOAL_B>'
--   and owner_user_id = '<ID_USUARIO_B>'
--   and not exists (select 1 from profiles where account_id = '<ID_CONTA_PESSOAL_B>');
