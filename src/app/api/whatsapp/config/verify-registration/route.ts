import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getSubscribedApps,
  isMetaCredentialError,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import {
  identifierFromDisplayPhone,
  reconcileCloudChannel,
} from '@/lib/whatsapp/cloud-channel-crud';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';

// Reconciliação com service_role, pelo mesmo motivo de `config/route.ts`:
// `channels_update` é admin+, mas este diagnóstico é aberto a qualquer
// membro da conta. A escrita é derivada da resposta da própria Meta
// sobre um número desta conta, e sempre casa `account_id`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * GET /api/whatsapp/config/verify-registration[?channel_id=...]
 *
 * Diagnostic endpoint — confirms the saved phone number is actually
 * reachable on Meta's side. Solves the failure mode that surfaced the
 * multi-number bug originally: "UI says Connected but Meta isn't
 * delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * SPEC 064 F4: o diagnóstico é **por canal** (`?channel_id=`; sem ele,
 * o canal Cloud padrão) e **reconcilia** a linha de `channels` com o
 * que a Meta responde — `identifier` recebe o telefone (D-9) e `status`
 * passa a refletir o resultado da verificação. É o segundo dos dois
 * pontos que o D-9 nomeia; o outro é o `POST` de salvamento.
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve o `account_id` do chamador para que um colega que entrou
  // numa conta existente veja o mesmo estado de registro que o admin
  // que a configurou.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    });
  }

  // `''` não é ausência de id por acidente: `?channel_id=` viraria uma
  // consulta por `id = ''` em vez de cair no canal padrão.
  const wantedChannelId =
    new URL(request.url).searchParams.get('channel_id')?.trim() || null;

  let channel;
  let config;
  try {
    ({ channel, config } = await resolveCloudConfig(
      supabase,
      accountId,
      wantedChannelId
    ));
  } catch (err) {
    if (err instanceof ChannelNotConfiguredError) {
      // Falha de LEITURA não é ausência de configuração. Dizer "você
      // ainda não salvou nada" durante uma indisponibilidade do banco
      // convida o operador a recadastrar tudo — a ação exatamente
      // errada. `config_exists` fica fora do objeto: o painel mostra
      // "desconhecido", não "não existe".
      if (err.reason === 'read_failed') {
        console.error('[verify-registration] read failed:', err.message);
        return NextResponse.json({
          live: false,
          channel_id: wantedChannelId,
          checks: {},
          message:
            'Could not read the configuration right now. Try again in a moment.',
        });
      }
      return NextResponse.json({
        live: false,
        channel_id: wantedChannelId,
        checks: { config_exists: false },
        message:
          err.reason === 'disabled'
            ? 'This number is disabled. Save its credentials again to reconnect it.'
            : 'No WhatsApp configuration saved yet.',
      });
    }
    throw err;
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch {
    return NextResponse.json({
      live: false,
      channel_id: channel.id,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
    });
  }

  const checks: {
    config_exists: boolean;
    token_decryptable: boolean;
    phone_metadata_ok: boolean;
    waba_subscribed_to_app: boolean | null;
    locally_marked_registered: boolean;
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  };
  const errors: string[] = [];

  // 1. Phone metadata
  let metadataError: string | null = null;
  /** A Meta REPROVOU a credencial (4xx) — não caiu (5xx/timeout). */
  let credentialRejected = false;
  let identifier: string | null = null;
  try {
    const phoneInfo = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });
    checks.phone_metadata_ok = true;
    identifier = identifierFromDisplayPhone(phoneInfo.display_phone_number);
  } catch (err) {
    metadataError = err instanceof Error ? err.message : String(err);
    credentialRejected = isMetaCredentialError(err);
    errors.push(`Phone metadata check failed: ${metadataError}`);
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      });
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0;
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.'
        );
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    errors.push(
      "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save."
    );
  }

  // D-9 + status: o que a Meta acabou de dizer vira o estado do canal.
  // A assinatura do WABA de propósito NÃO entra no `status`: ela
  // governa a ENTRADA de eventos, e um número com assinatura pendente
  // continua enviando. Marcar `error` ali tiraria do ar um número que
  // funciona (mesma razão do `POST`).
  //
  // ⚠️ `error` só quando a Meta REPROVOU (4xx). Uma indisponibilidade
  // passageira não pode tirar o número da API pública e do diálogo de
  // transferência — o mesmo cuidado do `GET` de saúde.
  const needsIdentifier =
    identifier !== null && identifier !== channel.identifier;
  if (metadataError) {
    if (
      credentialRejected &&
      (channel.status !== 'error' || channel.status_detail !== metadataError)
    ) {
      await reconcileCloudChannel(supabaseAdmin(), accountId, channel.id, {
        status: 'error',
        statusDetail: metadataError,
      });
    }
  } else if (needsIdentifier || channel.status !== 'connected') {
    await reconcileCloudChannel(supabaseAdmin(), accountId, channel.id, {
      ...(needsIdentifier ? { identifier } : {}),
      status: 'connected',
      statusDetail: null,
      connectedAt: channel.connected_at ?? new Date().toISOString(),
    });
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered;

  return NextResponse.json({
    live,
    channel_id: channel.id,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  });
}
