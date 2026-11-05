import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api';
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { resolveMediaUrlForServer } from '@/lib/storage/sign-media';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import {
  resolveCloudConfig,
  type WhatsappConfigRow,
} from '@/lib/whatsapp/cloud-channels';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';

// Header-image submits chain a media download + resumable upload (2
// round trips) + template create against the Meta Graph API before
// this handler can respond. Give it headroom beyond the platform
// default so a slow-but-successful chain doesn't get cut off by a
// gateway timeout (which would return an HTML error page instead of
// this handler's JSON).
export const maxDuration = 60;

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows; dropping the shared
 * fields here means adding a column later only touches one spot.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string;
    metaTemplateId: string | null;
    submissionError: string | null;
    /**
     * WABA that owns this template (SPEC 064 D-2). Part of the conflict
     * target as of migration 072, so it MUST be written on every upsert:
     * an upsert writes every column in the row, and omitting this would
     * blank out the value migration 072 backfilled — silently, on the
     * next re-submit. `null` only in DRY_RUN, where no config is loaded.
     */
    wabaId: string | null;
  }
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // WABA tenancy — half of the conflict target since migration 072.
    waba_id: extras.wabaId,
    // Original author — kept as audit only since migration 072 moved
    // the unique index off (user_id, name, language).
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: extras.submissionError ? null : null,
    last_submitted_at: new Date().toISOString(),
  };
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>
) {
  // Conflict target follows migration 072 (SPEC 064 §3.4 / D-2), which
  // dropped the legacy `message_templates_user_name_language_key` and
  // created `(account_id, waba_id, name, language) NULLS NOT DISTINCT`.
  // Two consequences, both intended:
  //   - teammates on the same account can no longer shadow each other's
  //     same-named template (the old TODO here);
  //   - the same template name may exist once per WABA, which is how
  //     Meta scopes templates — a second official number on a different
  //     WABA gets its own row instead of overwriting the first one's.
  // These four column names must stay in sync with that index: PostgREST
  // builds `ON CONFLICT (<columns>)` from this string, and a mismatch is
  // a 42P10 on the first save, not a silent fallback.
  return supabase
    .from('message_templates')
    .upsert(row, { onConflict: 'account_id,waba_id,name,language' })
    .select()
    .single();
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (account_id, waba_id, name,
 * language) with status, meta_template_id, sample_values,
 * last_submitted_at.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve the caller's account_id — whatsapp_config + the
    // message_templates row are account-scoped post-multi-user.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    let payload: TemplatePayload;
    // `channel_id` picks which official number's WABA gets this template
    // (SPEC 064 D-2/F5) — a sibling field of the template content, not
    // part of it, so it rides along on the same body without touching
    // `TemplatePayload`/`validateTemplatePayload`.
    let channelId: string | null = null;
    try {
      const body = (await request.json()) as TemplatePayload & {
        channel_id?: unknown;
      };
      if (typeof body.channel_id === 'string') channelId = body.channel_id;
      payload = body;
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 }
      );
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 }
      );
    }

    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 }
      );
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1';

    let metaTemplateId: string;
    let metaStatus: string;
    // Half of the upsert conflict target since migration 072. Hoisted
    // because both call sites (Meta failure and Meta success) write it.
    let wabaId: string | null = null;

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`;
      metaStatus = 'PENDING';

      // DRY_RUN still has to resolve the WABA, even though it never
      // talks to Meta: leaving it null would put the row outside the
      // conflict target of every real template, so a dry-run re-submit
      // would INSERT a duplicate next to the row migration 072
      // backfilled instead of updating it. `channelId` (explicit
      // selection) or the default Cloud channel — never "the first
      // config that shows up" — and a dev without any config simply
      // gets null, which is the honest answer there.
      //
      // ⚠️ Só `no_channel` ("a conta não tem número nenhum") vira
      // `wabaId: null` de propósito — é o caso legítimo do dev sem
      // config. Um `channelId` explícito inválido (de outra conta,
      // desativado, ou id inexistente) é erro do CHAMADOR, não "sem
      // config": engolir em silêncio gravaria a linha no alvo de
      // conflito legado (`waba_id NULL`) por um motivo diferente do
      // que o comentário acima existe para prevenir.
      try {
        const { config: cfg } = await resolveCloudConfig(
          supabase,
          accountId,
          channelId
        );
        wabaId = cfg.waba_id ?? null;
      } catch (e) {
        if (
          e instanceof ChannelNotConfiguredError &&
          e.reason === 'no_channel'
        ) {
          wabaId = null;
        } else if (
          e instanceof ChannelNotConfiguredError &&
          e.reason === 'read_failed'
        ) {
          return NextResponse.json(
            { error: 'Failed to resolve the WhatsApp channel. Try again.' },
            { status: 500 }
          );
        } else if (e instanceof ChannelNotConfiguredError) {
          return NextResponse.json({ error: e.message }, { status: 400 });
        } else {
          throw e;
        }
      }
    } else {
      let config: WhatsappConfigRow;
      try {
        ({ config } = await resolveCloudConfig(supabase, accountId, channelId));
      } catch (e) {
        if (e instanceof ChannelNotConfiguredError) {
          return NextResponse.json(
            {
              error:
                'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
            },
            { status: 400 }
          );
        }
        throw e;
      }
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
          },
          { status: 400 }
        );
      }

      wabaId = config.waba_id as string;

      const accessToken = decrypt(config.access_token);

      // Image headers need a Resumable-Upload handle (Meta rejects a
      // plain URL at creation). Derive it from header_media_url before
      // building the payload. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
      try {
        // A URL é baixada para virar o handle. Se ela apontar para o
        // nosso bucket — privado desde a migração 040 — o fetch anônimo
        // do helper receberia 400; por isso assinamos antes e passamos
        // a URL efêmera. URL externa colada pelo usuário volta
        // inalterada de `resolveMediaUrlForServer` e segue o caminho
        // antigo.
        const headerFetchUrl = await resolveMediaUrlForServer(
          supabase,
          payload.header_media_url
        );
        await ensureImageHeaderHandle(
          payload,
          accessToken,
          headerFetchUrl,
          config.app_id
        );
      } catch (e) {
        return NextResponse.json(
          {
            error:
              e instanceof Error ? e.message : 'Header image upload failed.',
          },
          { status: 400 }
        );
      }

      const metaPayload = buildMetaTemplatePayload(payload);
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        });
        metaTemplateId = meta.id;
        metaStatus = meta.status;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.';
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        await upsertTemplateRow(
          supabase,
          buildUpsertRow(accountId, user.id, payload, {
            status: 'DRAFT',
            metaTemplateId: null,
            submissionError: message,
            wabaId,
          })
        );
        const isRateLimit = /\b429\b/.test(message);
        // 422, not 502: this IS the app's own response (valid JSON,
        // same-origin) reporting that Meta rejected the template — not a
        // real gateway failure. A literal 502 here gets intercepted by
        // reverse proxies in front of self-hosted deployments (nginx/
        // Traefik/Coolify default to swapping their own generic error
        // page for any 502/503/504), which silently replaces this JSON
        // body with an opaque "Unexpected response (HTTP 502)" on the
        // client — confirmed in production against the rs project,
        // where the real Meta error (#100 subcode 2388023) was
        // correctly persisted to submission_error but never reached
        // the browser.
        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 422 }
        );
      }
    }

    const { data: row, error: upsertErr } = await upsertTemplateRow(
      supabase,
      buildUpsertRow(accountId, user.id, payload, {
        status: normalizeStatus(metaStatus),
        metaTemplateId,
        submissionError: null,
        wabaId,
      })
    );

    if (upsertErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    });
  } catch (error) {
    console.error('Error submitting template:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 }
    );
  }
}
