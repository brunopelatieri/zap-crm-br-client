'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { toast } from 'sonner';
import type { Contact, Tag } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Users,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Filter,
  X,
  QrCode,
  BadgeCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { formatPhoneForDisplay } from '@/lib/phone/br';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { planContactQuery } from '@/lib/contacts/contact-filter-query';

const PAGE_SIZE = 25;

/**
 * Aba "Contacts" do Inbox — diretório com busca (spec: "A contact
 * directory list featuring a search bar", sem filtro de etiquetas —
 * isso já existe na página /contacts completa).
 *
 * ## D2 FECHADA (SPEC 042): o filtro do agente é ERGONOMIA, não isolamento
 *
 * `contacts_select` é e continua sendo `is_account_member(account_id)`
 * ([017:386](../../../supabase/migrations/017_account_sharing.sql#L386))
 * — qualquer membro da conta lê a base inteira de contatos pela RLS. O
 * filtro abaixo (resolver `contact_id` das conversas do agente e
 * restringir `contacts` por `.in('id', ...)`) NÃO é controle de acesso:
 * um agente com a `anon key` que já está no bundle obtém a base inteira
 * com uma chamada direta ao PostgREST. Isso é sabido e aceito — a
 * decisão está registrada em detalhe na
 * [SPEC 042, §2](../../../docs/spec-042-supervisao-e-escopo-de-contatos.md#2-d2--f-42-b--o-isolamento-de-contatos-é-cosmético-e-a-tela-diz-o-contrário).
 *
 * Por quê endurecer NÃO compensa: contato é um ATIVO DA CONTA, não do
 * agente — um contato recém-criado, ainda sem conversa, precisa
 * continuar visível para quem o criou. Restringir por RLS quebraria
 * esse fluxo, mudaria o `total_count` do RPC `filter_contacts_by_tags`
 * (025) e exigiria retestar toda a paginação de `/contacts`. Nenhum
 * conteúdo de conversa vaza aqui — só nome/telefone/empresa, que já é
 * de conta.
 *
 * Então o filtro por agente existe só para PRIORIZAR: "mostre primeiro
 * quem é meu" (o texto da UI reflete isso — ver `subtitleMine` — e não
 * afirma isolamento nenhum). Ambos os papéis continuam podendo abrir
 * `/contacts` e ver a base inteira.
 *
 *   - admin/owner (`canViewAllConversations`) → todos os contatos da
 *     conta, igual à página /contacts.
 *   - agent → contatos com pelo menos uma conversa ATRIBUÍDA A ELE
 *     (ergonomia, não segurança — ver acima). Resolve os `contact_id`
 *     das conversas dele primeiro, depois filtra `contacts` por
 *     `.in('id', ...)`. O índice único (account_id, contact_id) da
 *     migração 036 garante no máximo uma conversa por contato+conta,
 *     então este conjunto é do tamanho da carteira do agente, não da
 *     base inteira — mesmo trade-off de escala que
 *     `lib/dashboard/queries.ts` já documenta para o resto do app.
 */
export function ContactsDirectory() {
  const t = useTranslations('Inbox.contactsDirectory');
  const { user, profileLoading } = useAuth();
  // Extraído do objeto `user` para uma primitiva estável: o callback
  // abaixo só toca `userId`, nunca `user` diretamente, para casar com o
  // que o React Compiler infere como dependência (senão a memoização
  // manual do `useCallback` e a inferida divergem e ele desiste de
  // otimizar o componente).
  const userId = user?.id ?? null;
  const canViewAll = useCan('view-all-conversations');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Filtro de etiquetas (OR entre as selecionadas) e de canal ("tem
  // conversa neste canal", OR também) — mesmas regras e mesmo RPC da
  // página /contacts (`filter_contacts_by_tags`, migrações 025/061).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  // Canal exibido por item (ícone na linha) — a conversa mais recente
  // do contato, não um campo do contato (que não pertence a canal
  // nenhum). Só faz sentido perguntar isto numa conta com mais de um
  // canal; ver `accountChannels.count` abaixo.
  const [contactChannelIds, setContactChannelIds] = useState<
    Record<string, string>
  >({});
  const accountChannels = useAccountChannels();

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);

  // Mesma guarda de corrida que a página /contacts usa: só o fetch
  // mais recente pode gravar seu resultado.
  const fetchSeq = useRef(0);

  const fetchTagsCatalog = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((tag) => {
        map[tag.id] = tag;
      });
      setTagsMap(map);
      // Uma etiqueta apagada em outra tela não deve continuar filtrando
      // em silêncio.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, []);

  const fetchContacts = useCallback(async () => {
    // Espera o papel resolver — senão `canViewAll` lê `false` durante
    // o loading (useCan) e um admin veria brevemente "meus contatos"
    // antes de trocar para "todos" assim que o perfil chegasse.
    if (profileLoading || !userId) return;

    const seq = ++fetchSeq.current;
    setLoading(true);

    const supabase = createClient();
    const plan = planContactQuery({
      search,
      tagIds: selectedTagIds,
      channelIds: selectedChannelIds,
      page,
      pageSize: PAGE_SIZE,
    });

    let contactRows: Contact[];
    let count: number;

    if (plan.mode === 'rpc') {
      // Etiqueta/canal precisam de JOIN — vão pelo RPC da 061, que
      // enxerga a CONTA inteira. O recorte "meus contatos" abaixo (só
      // ergonomia, não isolamento — SPEC 042 D2, ver o cabeçalho deste
      // arquivo) não entra aqui: cruzá-lo com o RPC exigiria resolver o
      // recorte no cliente, reintroduzindo a truncagem de ~1000 linhas
      // do PostgREST que o próprio RPC existe para evitar. Com filtro
      // ativo, agente e admin veem a mesma base — o mesmo que já
      // acontece quando qualquer um dos dois abre /contacts.
      const { data, error } = await supabase.rpc(
        'filter_contacts_by_tags',
        plan.params
      );
      if (seq !== fetchSeq.current) return;
      if (error) {
        toast.error(t('loadError'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let contactIdsFilter: string[] | null = null;

      if (!canViewAll) {
        const { data: myConvs, error: convErr } = await supabase
          .from('conversations')
          .select('contact_id')
          .eq('assigned_agent_id', userId);
        if (seq !== fetchSeq.current) return;
        if (convErr) {
          toast.error(t('loadError'));
          setLoading(false);
          return;
        }
        contactIdsFilter = Array.from(
          new Set((myConvs ?? []).map((c) => c.contact_id))
        );
        if (contactIdsFilter.length === 0) {
          setContacts([]);
          setTotalCount(0);
          setContactChannelIds({});
          setLoading(false);
          return;
        }
      }

      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(plan.from, plan.to);
      if (contactIdsFilter) query = query.in('id', contactIdsFilter);
      if (plan.search) {
        const like = `%${plan.search}%`;
        query = query.or(
          `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
        );
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return;
      if (error) {
        toast.error(t('loadError'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setContactChannelIds({});
      setLoading(false);
      return;
    }

    const contactIds = contactRows.map((c) => c.id);

    const [tagsRes, channelsRes] = await Promise.all([
      supabase
        .from('contact_tags')
        .select('contact_id, tag_id')
        .in('contact_id', contactIds),
      // Só pergunta pelo canal numa conta com mais de um — numa conta
      // de canal único o ícone seria ruído em toda linha (mesmo corte
      // de `showChannelBadge` em conversation-list.tsx).
      accountChannels.count > 1
        ? supabase
            .from('conversations')
            .select('contact_id, channel_id, last_message_at')
            .in('contact_id', contactIds)
            .not('channel_id', 'is', null)
            .order('last_message_at', { ascending: false })
        : null,
    ]);
    if (seq !== fetchSeq.current) return;

    const tagsByContact: Record<string, string[]> = {};
    tagsRes.data?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    // A primeira linha de cada contato vence — a query já veio ordenada
    // por `last_message_at DESC`, então é sempre a conversa mais recente.
    const channelByContact: Record<string, string> = {};
    channelsRes?.data?.forEach((row) => {
      if (row.channel_id && !(row.contact_id in channelByContact)) {
        channelByContact[row.contact_id] = row.channel_id;
      }
    });

    setContacts(
      contactRows.map((c) => ({
        ...c,
        tags: (tagsByContact[c.id] ?? [])
          .map((tid) => tagsMap[tid])
          .filter(Boolean),
      }))
    );
    setContactChannelIds(channelByContact);
    setLoading(false);
  }, [
    profileLoading,
    userId,
    canViewAll,
    page,
    search,
    selectedTagIds,
    selectedChannelIds,
    tagsMap,
    accountChannels.count,
    t,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTagsCatalog();
  }, [fetchTagsCatalog]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const allChannels = [...accountChannels.byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const showChannelFilter = accountChannels.count > 1;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  function toggleChannelFilter(channelId: string) {
    setSelectedChannelIds((prev) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId]
    );
    setPage(0);
  }

  function clearChannelFilters() {
    setSelectedChannelIds([]);
    setPage(0);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  const openDetail = useCallback((id: string) => {
    setDetailContactId(id);
    setDetailOpen(true);
  }, []);

  const emptyMessage = search.trim()
    ? t('noneMatch')
    : canViewAll
      ? t('noneYet')
      : t('noneAssigned');

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-hidden">
      <div className="border-border space-y-3 border-b p-4">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {canViewAll ? t('subtitleAll') : t('subtitleMine')}
          </p>
          {/* D2 (SPEC 042): o texto acima é ergonomia, não promessa de
              isolamento — este link deixa explícito que a base inteira
              de contatos da conta continua acessível. */}
          {!canViewAll && (
            <Link
              href="/contacts"
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
            >
              {t('viewAllContactsHint')}
            </Link>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Resultado muda de tamanho — a página N pode não valer mais.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="bg-muted border-border pl-8"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted w-full justify-start"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="bg-primary text-primary-foreground ml-1 inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="border-border flex items-center justify-between border-b px-3 py-2">
                <span className="text-popover-foreground text-sm font-medium">
                  {t('filterByTags')}
                </span>
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={clearTagFilters}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="text-muted-foreground px-3 py-4 text-center text-sm">
                  {t('noTagsYet')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label
                      key={tag.id}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-3 py-1.5"
                    >
                      <Checkbox
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTagFilter(tag.id)}
                        aria-label={`Filter by ${tag.name}`}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="text-popover-foreground truncate text-sm">
                        {tag.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Filtro de canal — só em conta com mais de um canal (mesmo
              corte de /contacts: numa conta de canal único seria ruído). */}
          {showChannelFilter && (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    className="border-border text-muted-foreground hover:bg-muted w-full justify-start"
                  />
                }
              >
                <Filter className="size-4" />
                {t('filterByChannel')}
                {selectedChannelIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground ml-1 inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold">
                    {selectedChannelIds.length}
                  </span>
                )}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                <div className="border-border flex items-center justify-between border-b px-3 py-2">
                  <span className="text-popover-foreground text-sm font-medium">
                    {t('filterByChannel')}
                  </span>
                  {selectedChannelIds.length > 0 && (
                    <button
                      onClick={clearChannelFilters}
                      className="text-muted-foreground hover:text-foreground text-xs"
                    >
                      {t('clearAll')}
                    </button>
                  )}
                </div>
                {/* A semântica está escrita na tela porque não é óbvia:
                    um contato não pertence a canal nenhum. */}
                <p className="text-muted-foreground border-border border-b px-3 py-2 text-xs">
                  {t('channelFilterHint')}
                </p>
                <div className="max-h-64 overflow-y-auto py-1">
                  {allChannels.map((channel) => (
                    <label
                      key={channel.id}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-3 py-1.5"
                    >
                      <Checkbox
                        checked={selectedChannelIds.includes(channel.id)}
                        onCheckedChange={() => toggleChannelFilter(channel.id)}
                        aria-label={`Filter by ${channel.name}`}
                      />
                      {channel.type === 'whatsapp_qr' ? (
                        <QrCode className="text-muted-foreground size-3.5 shrink-0" />
                      ) : (
                        <BadgeCheck className="text-muted-foreground size-3.5 shrink-0" />
                      )}
                      <span className="text-popover-foreground truncate text-sm">
                        {channel.name}
                      </span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* Chips dos filtros de canal ativos */}
        {selectedChannelIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedChannelIds.map((id) => {
              const channel = accountChannels.byId.get(id);
              if (!channel) return null;
              return (
                <span
                  key={id}
                  className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                >
                  {channel.type === 'whatsapp_qr' ? (
                    <QrCode className="size-3" />
                  ) : (
                    <BadgeCheck className="size-3" />
                  )}
                  {channel.name}
                  <button
                    onClick={() => toggleChannelFilter(id)}
                    aria-label={`Remove ${channel.name} filter`}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearChannelFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-xs"
            >
              {t('clearAll')}
            </button>
          </div>
        )}

        {/* Chips dos filtros de etiqueta ativos */}
        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: tag.color + '20',
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => toggleTagFilter(id)}
                    aria-label={`Remove ${tag.name} filter`}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearTagFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-xs"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Users className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <div className="divide-border divide-y">
            {contacts.map((c) => {
              const channel = accountChannels.byId.get(
                contactChannelIds[c.id] ?? ''
              );
              const tags = c.tags ?? [];
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openDetail(c.id)}
                  className="hover:bg-muted/50 flex w-full items-start gap-3 px-4 py-3 text-left"
                >
                  <div className="bg-muted text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium">
                    {(c.name || c.phone).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {c.name || (
                        <span className="text-muted-foreground italic">
                          {t('unnamed')}
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {formatPhoneForDisplay(c.phone)}
                    </p>
                    {(channel || tags.length > 0) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {channel && (
                          <span
                            title={channel.name}
                            className="text-muted-foreground inline-flex items-center gap-1 text-[10px]"
                          >
                            {channel.type === 'whatsapp_qr' ? (
                              <QrCode className="size-3 shrink-0" />
                            ) : (
                              <BadgeCheck className="size-3 shrink-0" />
                            )}
                            <span className="truncate">{channel.name}</span>
                          </span>
                        )}
                        {tags.map((tag) => (
                          <span
                            key={tag.id}
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: `${tag.color}20`,
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="border-border flex items-center justify-between border-t px-4 py-2">
          <p className="text-muted-foreground text-xs">
            {t('pageCount', { page: page + 1, total: totalPages })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />
    </div>
  );
}
