// ============================================================
// POST /api/inbox/conversations/[id]/export — SPEC 067 §9
//
// ⚠️ AUTENTICAR NÃO É AUTORIZAR.
//
//   Toda leitura de conversa, mensagem e mídia usa `ctx.supabase` (o
//   cliente de SESSÃO). Quem decide o que este usuário enxerga é a RLS
//   da 039 (`messages_select` → `can_access_conversation`), não este
//   arquivo. `supabaseAdmin()` aparece em UM lugar só: o INSERT da
//   trilha de auditoria, depois do papel já checado. Trocar qualquer
//   uma dessas consultas por service role reabriria o furo que a
//   039/040 fecharam — um agente baixaria a conversa de um colega.
//
//   O 404 é genérico de propósito: "não existe" e "não é sua" precisam
//   ser indistinguíveis para quem sonda ids.
// ============================================================

import { NextResponse } from 'next/server';
import { getLocale, getTranslations } from 'next-intl/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  CONVERSATION_EXPORT_MAX_MESSAGES,
  fetchThreadForExport,
} from '@/lib/inbox/export/fetch-thread';
import {
  buildTranscript,
  type FormatDateTime,
  type TranscriptLabels,
} from '@/lib/inbox/export/model';
import { buildMediaPlan } from '@/lib/inbox/export/media-plan';
import {
  DEFAULT_MEDIA_FETCH_LIMITS,
  fetchMediaBytes,
  type FetchedMedia,
} from '@/lib/inbox/export/fetch-media';
import { renderConversationPdf, type PdfLabels } from '@/lib/inbox/export/pdf';
import {
  buildConversationZip,
  buildMediaManifestCsv,
  buildReadmeText,
  conversationExportFilename,
  type ManifestLabels,
  type ReadmeLabels,
} from '@/lib/inbox/export/zip';
import {
  isValidTimeZone,
  resolvePeriodBoundary,
} from '@/lib/inbox/export/period';

// D-12: 100 MB de mídia não cabem nos 60s padrão do host. Se o host
// cortar antes, o ajuste é baixar `maxTotalBytes` (D-5), não subir isto.
export const maxDuration = 300;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D-9: uma exportação pode custar 100 MB de egresso do Storage. */
const RATE_LIMIT = { limit: 3, windowMs: 600_000 };

/**
 * D-5: no formato "só PDF" nada vai para o zip, então só as imagens
 * que serão embutidas em linha são baixadas.
 *
 * `maxFileBytes` também é reduzido para bater com `maxTotalBytes`
 * (achado de review): sem isto, um único arquivo dentro do teto padrão
 * de 50MB por arquivo — mas acima do teto de 40MB deste modo — baixava
 * inteiro e sozinho já estourava o orçamento que `maxTotalBytes` existe
 * para impor, já que a checagem do total só roda ANTES de cada
 * download, não durante.
 */
const EMBEDDED_IMAGE_LIMITS = {
  ...DEFAULT_MEDIA_FETCH_LIMITS,
  maxTotalBytes: 40 * 1024 * 1024,
  maxFileBytes: 40 * 1024 * 1024,
};

interface ParsedExportRequest {
  format: 'pdf' | 'zip';
  from?: string;
  to?: string;
  timeZone: string;
}

function parseRequestBody(
  body: unknown
): ParsedExportRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const b = body as Record<string, unknown>;

  if (b.format !== 'pdf' && b.format !== 'zip') {
    return { error: 'format must be "pdf" or "zip"' };
  }

  const timeZone = typeof b.timeZone === 'string' ? b.timeZone : 'UTC';
  // D-7: fuso inválido é erro do chamador. Sem esta guarda o
  // `Intl.DateTimeFormat` lá embaixo estouraria como 500.
  if (!isValidTimeZone(timeZone)) {
    return { error: 'timeZone is not a valid IANA time zone' };
  }

  let from: string | undefined;
  if (b.from !== undefined && b.from !== null && b.from !== '') {
    if (typeof b.from !== 'string') return { error: 'from must be a string' };
    const resolved = resolvePeriodBoundary(b.from, timeZone, 'start');
    if (!resolved) return { error: 'from is not a valid date' };
    from = resolved;
  }

  let to: string | undefined;
  if (b.to !== undefined && b.to !== null && b.to !== '') {
    if (typeof b.to !== 'string') return { error: 'to must be a string' };
    const resolved = resolvePeriodBoundary(b.to, timeZone, 'end');
    if (!resolved) return { error: 'to is not a valid date' };
    to = resolved;
  }

  if (from && to && from > to) {
    return { error: 'from must be before or equal to to' };
  }

  return { format: b.format, from, to, timeZone };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1) Papel mínimo (D-1). `viewer` não exporta: quem não pode escrever
  //    também não leva a base embora.
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  // 2) Frequência (D-9).
  const limit = checkRateLimit(`conv-export:${ctx.userId}`, RATE_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);

  // 3) Corpo.
  const body = await request.json().catch(() => null);
  const parsed = parseRequestBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { format, from, to, timeZone } = parsed;

  // 4) `id` antes de tocar no banco.
  const { id: conversationId } = await params;
  if (!UUID_RE.test(conversationId)) {
    return NextResponse.json(
      { error: 'Conversation not found' },
      { status: 404 }
    );
  }

  // 5) Coleta — cliente de SESSÃO, RLS decide.
  const data = await fetchThreadForExport(ctx.supabase, {
    conversationId,
    from,
    to,
  });
  if (!data) {
    return NextResponse.json(
      { error: 'Conversation not found' },
      { status: 404 }
    );
  }
  if (data.truncated) {
    return NextResponse.json(
      {
        error: 'export_too_large',
        total: data.total,
        max: CONVERSATION_EXPORT_MAX_MESSAGES,
      },
      { status: 413 }
    );
  }

  // 6) Rótulos e formatadores, no locale e no fuso de quem exporta.
  const locale = await getLocale();
  const t = await getTranslations('Inbox.exportConversation');
  const tDoc = await getTranslations('Inbox.exportConversation.doc');
  const tManifest = await getTranslations('Inbox.exportConversation.manifest');
  const tReadme = await getTranslations('Inbox.exportConversation.readme');

  const dayFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formatDateTime: FormatDateTime = (iso, style) =>
    style === 'day'
      ? dayFormatter.format(new Date(iso))
      : timeFormatter.format(new Date(iso));

  const transcriptLabels: TranscriptLabels = {
    customerSender: (name) => tDoc('customerSender', { name }),
    customerWord: tDoc('customerWord'),
    bot: tDoc('bot'),
    unknownAgent: tDoc('unknownAgent'),
    statusSent: tDoc('statusSent'),
    statusDelivered: tDoc('statusDelivered'),
    statusRead: tDoc('statusRead'),
    statusFailed: tDoc('statusFailed'),
    favoriteBadge: tDoc('favoriteBadge'),
    deletedRevokedBadge: tDoc('deletedRevokedBadge'),
    deletedBadge: tDoc('deletedBadge'),
    aiBadge: tDoc('aiBadge'),
    campaignBadge: (name) => tDoc('campaignBadge', { name }),
    templateBadge: (name) => tDoc('templateBadge', { name }),
    channelDeviationBadge: tDoc('channelDeviationBadge'),
    buttonReply: tDoc('buttonReply'),
    locationLabel: tDoc('locationLabel'),
  };

  // 7) Id da exportação ANTES de renderizar: ele vai impresso no rodapé
  //    do PDF, e é por ele que se acha a linha da trilha depois.
  const exportId = crypto.randomUUID();
  const blocks = buildTranscript(data, transcriptLabels, formatDateTime);
  const plan = buildMediaPlan(blocks);

  // 8) Bytes. No formato "só PDF" apenas as imagens — vídeo, áudio e
  //    documento viram cartão e não precisam de download nenhum.
  const planToFetch =
    format === 'zip'
      ? plan
      : plan.filter((entry) => entry.contentType === 'image');

  let media = new Map<number, FetchedMedia>();
  if (planToFetch.length > 0) {
    media = await fetchMediaBytes(
      ctx.supabase,
      ctx.accountId,
      planToFetch,
      format === 'zip' ? DEFAULT_MEDIA_FETCH_LIMITS : EMBEDDED_IMAGE_LIMITS
    );
  }

  const okMedia = [...media.values()].filter((m) => m.status === 'ok');
  // `planToFetch.length`, não `plan.length` (achado de review): no
  // formato "só PDF", vídeo/áudio/documento nunca são baixados — viram
  // cartão por design (passo 8) — e contá-los contra `plan.length`
  // inteiro os apontava como "mídia ausente" na trilha de auditoria e no
  // toast do usuário, quando na verdade nunca foram sequer tentados.
  const missingMedia = planToFetch.length - okMedia.length;

  const periodLabel =
    from && to
      ? t('periodRange', {
          from: dateTimeFormatter.format(new Date(from)),
          to: dateTimeFormatter.format(new Date(to)),
        })
      : from
        ? t('periodFrom', { from: dateTimeFormatter.format(new Date(from)) })
        : to
          ? t('periodTo', { to: dateTimeFormatter.format(new Date(to)) })
          : t('periodAll');

  const exporterName = await resolveExporterName(ctx.supabase, ctx.userId);
  const exportedByLabel = t('exportedBy', {
    name: exporterName,
    date: dateTimeFormatter.format(new Date()),
  });

  const channelLabel = data.channel
    ? [data.channel.name, data.channel.identifier].filter(Boolean).join(' · ')
    : t('unknownChannel');

  const pdfLabels: PdfLabels = {
    documentTitle: tDoc('title'),
    headerContact: tDoc('headerContact'),
    headerPhone: tDoc('headerPhone'),
    headerChannel: tDoc('headerChannel'),
    headerPeriod: tDoc('headerPeriod'),
    headerCounts: tDoc('headerCounts'),
    headerExportedBy: tDoc('headerExportedBy'),
    headerExportId: tDoc('headerExportId'),
    messageCount: (count) => tDoc('messageCount', { count }),
    attachmentCount: (count) => tDoc('attachmentCount', { count }),
    attachmentImage: tDoc('attachmentImage'),
    attachmentVideo: tDoc('attachmentVideo'),
    attachmentAudio: tDoc('attachmentAudio'),
    attachmentDocument: tDoc('attachmentDocument'),
    attachmentSticker: tDoc('attachmentSticker'),
    mediaMissing: tDoc('mediaMissing'),
    mediaTooLarge: tDoc('mediaTooLarge'),
    mediaSkipped: tDoc('mediaSkipped'),
    mediaError: tDoc('mediaError'),
    inZip: tDoc('inZip'),
    replyPrefix: tDoc('replyPrefix'),
    buttonPrefix: tDoc('buttonPrefix'),
    formatBytes: (bytes) => formatBytes(bytes, locale),
    page: (current, total) => tDoc('page', { current, total }),
  };

  // 9) Render.
  const pdfBytes = await renderConversationPdf({
    header: {
      contactName: data.contact.name || data.contact.phone,
      contactPhone: data.contact.phone,
      channelLabel,
      periodLabel,
      messageCount: data.messages.length,
      attachmentCount: plan.length,
      exportedByLabel,
      exportId,
      accountName: ctx.account.name,
    },
    blocks,
    plan,
    media,
    labels: pdfLabels,
    includeZipReferences: format === 'zip',
  });

  const now = new Date();
  const contactName = data.contact.name || data.contact.phone;
  const pdfName = conversationExportFilename(
    t('filenamePrefix'),
    contactName,
    'pdf',
    now
  );

  let fileBody: Uint8Array = pdfBytes;
  let filename = pdfName;
  let contentType = 'application/pdf';

  if (format === 'zip') {
    const manifestLabels: ManifestLabels = {
      columns: {
        file: tManifest('columnFile'),
        index: tManifest('columnIndex'),
        dateTime: tManifest('columnDateTime'),
        sender: tManifest('columnSender'),
        type: tManifest('columnType'),
        displayName: tManifest('columnDisplayName'),
        byteSize: tManifest('columnByteSize'),
        status: tManifest('columnStatus'),
        messageId: tManifest('columnMessageId'),
      },
      types: {
        image: tManifest('typeImage'),
        video: tManifest('typeVideo'),
        audio: tManifest('typeAudio'),
        document: tManifest('typeDocument'),
        sticker: tManifest('typeSticker'),
      },
      status: {
        ok: tManifest('statusOk'),
        missing: tManifest('statusMissing'),
        too_large: tManifest('statusTooLarge'),
        skipped: tManifest('statusSkipped'),
        error: tManifest('statusError'),
      },
      formatDateTime: (iso) => dateTimeFormatter.format(new Date(iso)),
      notIncluded: '',
    };

    const readmeLabels: ReadmeLabels = {
      title: tReadme('title'),
      contactLine: (name) => tReadme('contactLine', { name }),
      exportedByLine: (by) => tReadme('exportedByLine', { by }),
      exportIdLine: (id) => tReadme('exportIdLine', { id }),
      pdfLine: (name) => tReadme('pdfLine', { name }),
      mediaLine: (included, total) => tReadme('mediaLine', { included, total }),
      manifestLine: (name) => tReadme('manifestLine', { name }),
      noteStickersAndVideos: tReadme('noteStickersAndVideos'),
      noteMissingMedia: tReadme('noteMissingMedia'),
      noteMonochromeEmoji: tReadme('noteMonochromeEmoji'),
      notePersonalData: tReadme('notePersonalData'),
    };

    fileBody = buildConversationZip({
      pdfBytes,
      pdfName,
      plan,
      media,
      manifest: buildMediaManifestCsv(plan, media, blocks, manifestLabels),
      readme: buildReadmeText(
        {
          contactName,
          exportedByLabel,
          exportId,
          pdfName,
          includedMediaCount: okMedia.length,
          totalMediaCount: plan.length,
        },
        readmeLabels
      ),
      now,
    });
    filename = conversationExportFilename(
      t('filenamePrefix'),
      contactName,
      'zip',
      now
    );
    contentType = 'application/zip';
  }

  // 10) Trilha (§9.1). `supabaseAdmin()` SÓ aqui, com o papel já
  //     checado. Best-effort: o arquivo já está pronto, e derrubá-lo
  //     puniria o usuário por um problema nosso.
  try {
    const { error } = await supabaseAdmin()
      .from('conversation_exports')
      .insert({
        id: exportId,
        account_id: ctx.accountId,
        conversation_id: conversationId,
        contact_id: data.contact.id,
        user_id: ctx.userId,
        format,
        message_count: data.messages.length,
        media_count: okMedia.length,
        media_missing: missingMedia,
        total_bytes: fileBody.byteLength,
        period_from: from ?? null,
        period_to: to ?? null,
      });
    if (error) {
      console.error(
        '[conversation-export] audit insert failed:',
        error.message
      );
    }
  } catch (err) {
    console.error('[conversation-export] audit insert threw:', err);
  }

  return new NextResponse(new Uint8Array(fileBody), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      // `filename*` porque nome de contato tem acento: sem ele o
      // navegador salva "conversa-jos-.pdf".
      'Content-Disposition': `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Export-Message-Count': String(data.messages.length),
      'X-Export-Media-Count': String(okMedia.length),
      'X-Export-Media-Missing': String(missingMedia),
    },
  });
}

/** Nome do exportador para o carimbo do documento. Falha aqui não pode
 *  derrubar a exportação — o cabeçalho degrada, não some. */
async function resolveExporterName(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  userId: string
): Promise<string> {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('user_id', userId)
      .maybeSingle();
    const name = (data as { full_name?: string } | null)?.full_name?.trim();
    return name || '—';
  } catch {
    return '—';
  }
}

/** O parâmetro `filename` do header só admite ASCII; o nome real, com
 *  acento, viaja em `filename*`. */
function asciiFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
}

function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
