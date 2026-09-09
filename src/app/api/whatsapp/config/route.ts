import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import {
  isMetaCredentialError,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import {
  listCloudChannels,
  resolveCloudConfig,
} from '@/lib/whatsapp/cloud-channels';
import {
  CloudChannelError,
  createCloudChannel,
  createsChannel,
  identifierFromDisplayPhone,
  nextCloudChannelName,
  reconcileCloudChannel,
  removeCloudChannel,
  resolveSaveTarget,
  saveCloudConfigRow,
  updateCloudChannelOnSave,
} from '@/lib/whatsapp/cloud-channel-crud';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { channelIdentifierIsPhone } from '@/lib/channels/identifier';
import { parseQuotaError } from '@/lib/plans/errors';

/**
 * CRUD dos números oficiais (SPEC 064 F4).
 *
 * O que mudou nesta fase
 *
 *   Até aqui esta rota tratava a conta como dona de UM número: `GET`
 *   devolvia um objeto, `POST` fazia upsert por `account_id` e `DELETE`
 *   apagava a linha da conta. Com a migração 072 a pergunta certa passa
 *   a ser sempre "qual canal", e as três operações passam a receber
 *   `channel_id`.
 *
 *   E, principalmente: o `POST` **passa a criar e manter a linha de
 *   `channels`**. Ele nunca tocou essa tabela (§1.1.E.1) — todo canal
 *   Cloud em produção veio do backfill da 055, e uma conta criada
 *   depois dele conectava o número mas não ganhava canal, o que fazia
 *   `resolveDefaultChannelId` lançar e o número não aparecer no inbox.
 *
 * Segredo não sai daqui
 *
 *   O `GET` de lista devolve rótulo, telefone, status e ids — nunca
 *   `access_token` nem `verify_token`. Antes desta fase o componente
 *   lia `whatsapp_config` direto do navegador (`select('*')`, com a
 *   policy `is_account_member`), o que entregava o token cifrado a
 *   qualquer membro, `viewer` inclusive. Com N números, entregaria N.
 *
 * Onde o segredo é lido
 *
 *   Só nos caminhos que precisam falar com a Meta — a sondagem de saúde
 *   (`?channel_id=`) e o `POST`. Os dois decriptam no servidor e não
 *   devolvem nada além do que a Meta respondeu.
 */

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.account_id) return null;
  return data.account_id as string;
}

/**
 * `?channel_id=` vazio é ausência, não um id.
 *
 * `URLSearchParams.get` devolve `''` para `?channel_id=`, e `''` não é
 * nullish: passado adiante, ele vira uma consulta por `id = ''` e um
 * erro "canal não existe" onde a resposta certa era o canal padrão.
 */
function channelIdParam(url: string): string | null {
  return new URL(url).searchParams.get('channel_id')?.trim() || null;
}

// Lazy-initialised service-role client. Two jobs here:
//
//   1. detect a phone_number_id already claimed by a *different*
//      account — under RLS the caller can't see other accounts' rows,
//      so the conflict would be invisible;
//   2. reconcile `channels` from the diagnostic GET. `channels_update`
//      is admin+, but the health check runs for any member (the
//      settings overview tile calls it) — with the caller's client the
//      reconciliation would silently no-op for a `viewer`, and the
//      status column would stay frozen for exactly the accounts that
//      never open the settings tab as an admin. The write is derived
//      from Meta's own answer about a number this account owns, and is
//      always scoped by `account_id`.
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

interface ProbeResult {
  channel_id: string | null;
  connected: boolean;
  reason?: string;
  message?: string;
  needs_reset?: boolean;
  phone_info?: unknown;
}

/**
 * Diagnóstico de UM número: decripta a credencial e pergunta à Meta.
 *
 * É o único lugar do `GET` que custa uma chamada externa, e por isso
 * roda para um canal só — o explícito, ou o padrão da conta. Ele também
 * **reconcilia** a linha de `channels` com o que a Meta respondeu:
 * `status` (que passa a ter escritor nesta fase) e `identifier` (o
 * telefone do D-9, que o backfill da 055 não tinha como preencher).
 */
async function probeChannel(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  channelId: string | null
): Promise<ProbeResult> {
  let channel;
  let config;
  try {
    ({ channel, config } = await resolveCloudConfig(
      supabase,
      accountId,
      channelId
    ));
  } catch (err) {
    if (err instanceof ChannelNotConfiguredError) {
      if (err.reason === 'read_failed') {
        console.error('[whatsapp/config GET] read failed:', err.message);
        return {
          channel_id: channelId,
          connected: false,
          reason: 'db_error',
          message: 'Failed to fetch configuration',
        };
      }
      if (err.reason === 'disabled') {
        return {
          channel_id: channelId,
          connected: false,
          reason: 'disabled',
          message:
            'This number is disabled. Save its credentials again to reconnect it.',
        };
      }
      return {
        channel_id: channelId,
        connected: false,
        reason: 'no_config',
        message:
          'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
      };
    }
    throw err;
  }

  // Try to decrypt the stored token with the current ENCRYPTION_KEY.
  // If this fails, the key changed (or was never consistent across envs).
  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch (err) {
    console.error('[whatsapp/config GET] Token decryption failed:', err);
    return {
      channel_id: channel.id,
      connected: false,
      reason: 'token_corrupted',
      needs_reset: true,
      message:
        'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
    };
  }

  // Validate credentials against Meta
  try {
    const phoneInfo = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });

    // D-9: o telefone que a Meta acabou de devolver vira o
    // `identifier` do canal, substituindo o `phone_number_id` que o
    // backfill da 055 deixou ali. Só escreve quando difere — o `GET`
    // roda a cada abertura da aba de configuração.
    const identifier = identifierFromDisplayPhone(
      phoneInfo.display_phone_number
    );
    const needsIdentifier =
      identifier !== null && identifier !== channel.identifier;
    if (needsIdentifier || channel.status !== 'connected') {
      await reconcileCloudChannel(supabaseAdmin(), accountId, channel.id, {
        ...(needsIdentifier ? { identifier } : {}),
        status: 'connected',
        statusDetail: null,
        connectedAt: channel.connected_at ?? new Date().toISOString(),
      });
    }

    return { channel_id: channel.id, connected: true, phone_info: phoneInfo };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error(
      '[whatsapp/config GET] Meta API verification failed:',
      message
    );

    // Diagnóstico REPROVADO pela Meta → o canal fica `error` com o
    // motivo à vista. É o outro lado da mesma moeda: a coluna só é
    // confiável porque ambos os desfechos a escrevem.
    //
    // ⚠️ Só para 4xx (token expirado, número inexistente, app sem
    // permissão). Um 5xx da Graph API, um 429 ou um timeout de rede
    // NÃO tocam a coluna: agora que `channelSendBlock` barra canal
    // Cloud fora de `connected`, latir uma indisponibilidade de dez
    // segundos como erro de credencial tiraria o número da API pública
    // e do diálogo de transferência — e ele ficaria assim até alguém
    // reabrir esta aba, porque nenhum caminho de envio re-sonda. A
    // resposta HTTP continua dizendo `meta_api_error` nos dois casos:
    // o operador vê o problema sem que o canal seja punido por ele.
    if (
      isMetaCredentialError(err) &&
      (channel.status !== 'error' || channel.status_detail !== message)
    ) {
      await reconcileCloudChannel(supabaseAdmin(), accountId, channel.id, {
        status: 'error',
        statusDetail: message,
      });
    }

    return {
      channel_id: channel.id,
      connected: false,
      reason: 'meta_api_error',
      message: `Meta API rejected the credentials: ${message}`,
    };
  }
}

/**
 * GET /api/whatsapp/config
 *
 * Sem parâmetro: **a lista de números da conta** (§5), sem segredo
 * nenhum, mais a sondagem do canal padrão nos campos de topo — que é
 * exatamente uma chamada à Meta, o mesmo custo de antes.
 *
 * Com `?channel_id=`: só a sondagem daquele número.
 *
 * Returns 200 in all non-auth cases so the UI can render an appropriate
 * message rather than show a 500.
 *
 * Response shape (topo, mantido para a UI atual — a F7 passa a ler
 * `channels[]`):
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
          channels: [],
        },
        { status: 200 }
      );
    }

    const wantedChannelId = channelIdParam(request.url);

    if (wantedChannelId) {
      const probe = await probeChannel(supabase, accountId, wantedChannelId);
      return NextResponse.json(probe, { status: 200 });
    }

    let channels;
    try {
      channels = await listCloudChannels(supabase, accountId);
    } catch (err) {
      console.error('Error fetching cloud channels:', err);
      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message: 'Failed to fetch configuration',
          channels: [],
        },
        { status: 200 }
      );
    }

    const payload = channels.map((c) => ({
      channel_id: c.channelId,
      name: c.name,
      identifier: c.identifier,
      // D-9: a tela só formata como telefone o que sabidamente é um.
      // Canal ainda não reconciliado carrega o `phone_number_id` do
      // backfill da 055 — a rota tem as duas informações e resolve a
      // dúvida aqui, para nenhum componente ter de adivinhar.
      identifier_is_phone: channelIdentifierIsPhone(
        { type: 'whatsapp_cloud', identifier: c.identifier },
        { phoneNumberId: c.phoneNumberId }
      ),
      status: c.status,
      is_default: c.isDefault,
      phone_number_id: c.phoneNumberId,
      waba_id: c.wabaId,
      registered_at: c.registeredAt,
      last_registration_error: c.lastRegistrationError,
      subscribed_apps_at: c.subscribedAppsAt,
      broadcast_cooldown_days: c.broadcastCooldownDays,
      messaging_limit_tier: c.messagingLimitTier,
      created_at: c.createdAt,
    }));

    if (channels.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          channels: payload,
          default_channel_id: null,
        },
        { status: 200 }
      );
    }

    // `listCloudChannels` devolve o padrão primeiro (D-11).
    const probe = await probeChannel(supabase, accountId, null);
    return NextResponse.json(
      {
        ...probe,
        channels: payload,
        default_channel_id: probe.channel_id ?? channels[0].channelId,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error);
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Salva ou atualiza UM número. Verifica as credenciais com a Meta
 * antes, cifra, e mantém canal e configuração alinhados.
 *
 * Qual número é decidido por `resolveSaveTarget` (§5):
 *
 *   - `channel_id` no corpo → aquele canal;
 *   - sem ele, `phone_number_id` já conhecido da conta → aquele canal
 *     (idempotência: duplo clique e bundle antigo em cache POSTam sem
 *     id, e criariam um canal novo a cada salvamento);
 *   - canal existente `disabled` → readota, preservando histórico,
 *     cooldown e tier (D-12);
 *   - nada disso → cria canal + configuração.
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

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      channel_id,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      app_secret,
      pin,
      name,
    } = body;

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      );
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        );
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    //
    // SPEC 064 D-8 mantém a regra: um número, uma conta. O que mudou é
    // que a mesma CONTA pode ter vários números — daí o `.neq`.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError);
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      );
    }

    // Antes da Meta, de propósito: é o alvo que decide se a quota do
    // plano sequer precisa ser consultada.
    let target;
    try {
      target = await resolveSaveTarget(supabase, accountId, {
        channelId: typeof channel_id === 'string' ? channel_id : null,
        phoneNumberId: phone_number_id,
      });
    } catch (err) {
      if (err instanceof CloudChannelError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        );
      }
      throw err;
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo;
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('Meta API verification failed during save:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      );
    }

    // App Secret já salvo neste canal (se houver) — lido ANTES do bloco de
    // criptografia, para o `encryptedAppSecret` abaixo poder preservá-lo.
    //
    // Achado de code review: sem isto, todo resave de rotina (rotacionar
    // o access token, atualizar o PIN) que não reenviasse `app_secret`
    // apagava a coluna de volta para `null` — a tela nunca pré-preenche
    // este campo (mesmo padrão do `access_token`/`verify_token`, que
    // também exigem redigitação), então "salvar sem mexer no App
    // Secret" era o caminho comum, não a exceção. Diferente do
    // `verify_token` (cujo erro aparece NA HORA, no "Verificar e salvar"
    // da Meta), um `app_secret` apagado não dá sinal nenhum — o canal
    // segue "conectado" e só as mensagens recebidas do App não-padrão
    // voltam a ser rejeitadas em silêncio, reabrindo exatamente o bug
    // que a migração 073 fecha.
    let existingAppSecretCipher: string | null = null;
    if (
      !(typeof app_secret === 'string' && app_secret.trim()) &&
      target.config?.id
    ) {
      const { data: secretRow, error: secretError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('app_secret')
        .eq('id', target.config.id)
        .maybeSingle();
      if (secretError) {
        console.error(
          'Failed to read existing app_secret before save:',
          secretError.message
        );
      } else {
        existingAppSecretCipher =
          (secretRow?.app_secret as string | null) ?? null;
      }
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string;
    let encryptedVerifyToken: string | null;
    let encryptedAppSecret: string | null;
    try {
      encryptedAccessToken = encrypt(access_token);
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null;
      // Migração 073: só precisa quando este número está sob um App da
      // Meta diferente do App padrão (`META_APP_SECRET`) — ver o
      // cabeçalho de `resolveWebhookAppSecrets`. Ausente/vazio preserva
      // o que já estava salvo (ver leitura acima) — nunca `null` só
      // porque este resave não tratava do App Secret.
      encryptedAppSecret =
        typeof app_secret === 'string' && app_secret.trim()
          ? encrypt(app_secret.trim())
          : existingAppSecretCipher;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown encryption error';
      console.error('Encryption failed:', message);
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      );
    }

    const existingConfig = target.config;
    // Já registrado na Meta E é o mesmo número: dá para pular o
    // /register quando o usuário não mandou PIN desta vez.
    const sameNumber =
      existingConfig?.phone_number_id === phone_number_id &&
      existingConfig?.registered_at != null;

    // D-12: desativar um número PRESERVA a linha, `waba_id` incluído —
    // mas a tela não consegue exibir um canal desativado para
    // pré-preencher o campo, então o formulário de reconexão volta com
    // ele em branco. Sobrescrever com `null` aqui apagaria justamente o
    // que a desativação guardou: sem `waba_id` a rota pula
    // `subscribeWabaToApp` e a entrada de eventos para, com o
    // diagnóstico dizendo "No WABA ID on file". Campo ausente ou vazio
    // = "não mexa"; trocar de WABA continua sendo mandar o novo valor.
    const wabaId =
      typeof waba_id === 'string' && waba_id.trim()
        ? waba_id.trim()
        : (existingConfig?.waba_id ?? null);

    // SPEC 059 F6 / D-7: só checa ao CRIAR um número. Atualizar
    // credenciais de um número já conectado (rotação de token, novo
    // PIN) nunca pode ser bloqueado pela quota.
    //
    // A recusa de verdade é a trigger `enforce_channel_quota` (072
    // §3.7), que vale para os dois tipos de canal e roda no `INSERT`.
    // Esta checagem antecipa só o caso "o plano não inclui número
    // oficial", que merece uma frase melhor que a da trigger. A
    // mensagem legível para o teto atingido é a F8.
    if (createsChannel(target.mode)) {
      // plan_limit() confia cegamente em p_account_id (sem checar
      // is_account_member) — por isso EXECUTE é só de service_role
      // (migração 067), nunca de authenticated. accountId já foi
      // resolvido para o USUÁRIO LOGADO acima; não é um parâmetro
      // vindo do cliente.
      const { data: cloudLimit } = await supabaseAdmin().rpc('plan_limit', {
        p_account_id: accountId,
        p_key: 'channels_whatsapp_cloud',
      });
      if (cloudLimit === 0) {
        return NextResponse.json(
          {
            error:
              'Your plan does not include an official WhatsApp number. Upgrade your plan to connect one.',
            code: 'quota_exceeded',
          },
          { status: 403 }
        );
      }
    }

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existingConfig?.registered_at ?? null;
    let registrationError: string | null = null;
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false;

    const needsRegistration =
      !sameNumber || (typeof pin === 'string' && pin.length > 0);
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true;
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          });
          registeredAt = new Date().toISOString();
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error';
          console.error('Phone number /register failed:', registrationError);
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null;
    if (wabaId) {
      try {
        await subscribeWabaToApp({
          wabaId,
          accessToken: access_token,
        });
        subscribedAppsAt = new Date().toISOString();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('WABA subscribed_apps failed (non-fatal):', message);
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    const now = new Date().toISOString();
    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: wabaId,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      app_secret: encryptedAppSecret,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : now,
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: now,
    };

    // É esta escrita que faz `channels.status` do tipo `whatsapp_cloud`
    // passar a ter dono (`lib/channels/status.ts`).
    //
    // ⚠️ O canal fica `connected` mesmo quando o `/register` falhou. O
    // que `channels.status` responde é "dá para enviar por aqui?", e a
    // resposta é sim: `verifyPhoneNumber` acabou de aceitar a
    // credencial, e o `/register` só governa o ROTEAMENTO DE ENTRADA
    // dos eventos. Marcar `error` aqui tiraria do ar um número que
    // envia — a API pública o recusaria e o diálogo de transferência o
    // esconderia — por causa de um PIN vencido. O problema fica visível
    // onde deve: `status_detail` no canal,
    // `whatsapp_config.last_registration_error` e o aviso de registro
    // na tela. `error` fica reservado para o diagnóstico que a Meta
    // reprova (`probeChannel`).
    const identifier = identifierFromDisplayPhone(
      phoneInfo.display_phone_number
    );
    const explicitName =
      typeof name === 'string' && name.trim() ? name.trim() : undefined;

    let channelId: string;
    /** Credencial salva, mas a linha do canal não acompanhou. */
    let channelError: string | null = null;

    if (createsChannel(target.mode)) {
      const channelName =
        explicitName ?? (await nextCloudChannelName(supabase, accountId));

      try {
        ({ channelId } = await createCloudChannel(supabase, {
          accountId,
          userId: user.id,
          name: channelName,
          identifier,
          status: 'connected',
          statusDetail: registrationError,
          connectedAt: now,
          configRow: {
            account_id: accountId,
            // `user_id` é a coluna de auditoria: quem, dentro da conta,
            // salvou a configuração.
            user_id: user.id,
            ...baseRow,
          },
          // Modo `adopt`: a credencial já existe sem canal (§1.1.E.1).
          // Adotar a linha em vez de inserir outra é o que evita a
          // colisão com o `UNIQUE` global de `phone_number_id` — que
          // devolveria 500 em toda tentativa de salvar.
          adoptConfigId: target.mode === 'adopt' ? target.config.id : null,
        }));
      } catch (err) {
        const quota = parseQuotaError(err);
        if (quota) {
          // A trigger recusou. A frase legível é a F8; aqui a resposta
          // carrega a métrica crua para a UI não ter de adivinhar.
          return NextResponse.json(
            {
              error: `Channel quota exceeded: ${quota.metric} (${quota.used}/${quota.limit}).`,
              code: 'quota_exceeded',
              quota,
            },
            { status: 403 }
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error creating cloud channel:', message);
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        );
      }
    } else {
      channelId = target.channel.id;

      // `saveCloudConfigRow` insere quando o `UPDATE` não casa linha
      // nenhuma — o caso do canal ÓRFÃO, que a lista mostra de
      // propósito para o operador poder consertá-lo. Um `UPDATE` de
      // zero linhas não é erro no PostgREST, então sem esse ramo a
      // rota responderia "salvo" sobre um canal que continua sem
      // credencial, e todo envio por ele morreria em
      // `resolveCloudConfig` com `no_credentials`.
      try {
        await saveCloudConfigRow(supabase, {
          accountId,
          userId: user.id,
          channelId,
          row: baseRow,
        });
      } catch (err) {
        console.error('Error updating whatsapp_config:', err);
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        );
      }

      try {
        await updateCloudChannelOnSave(
          supabase,
          accountId,
          channelId,
          {
            identifier,
            status: 'connected',
            statusDetail: registrationError,
            connectedAt: now,
            name: explicitName,
          },
          user.id
        );
      } catch (err) {
        const quota = parseQuotaError(err);
        channelError = quota
          ? `Channel quota exceeded: ${quota.metric} (${quota.used}/${quota.limit}).`
          : err instanceof Error
            ? err.message
            : String(err);
        // Não é 500: a credencial FOI gravada. Reativar um número com o
        // plano no teto cai aqui (a trigger de reativação recusa), e o
        // operador precisa da frase, não de um erro genérico.
        console.error('Error updating channel row:', channelError);
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        channel_error: channelError,
        channel_id: channelId,
        phone_info: phoneInfo,
      });
    }

    return NextResponse.json({
      success: channelError === null,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      channel_error: channelError,
      channel_id: channelId,
      phone_info: phoneInfo,
    });
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/whatsapp/config?channel_id=...
 *
 * "Remover número" (D-12) — e o mesmo caminho que o botão "Reset
 * Configuration" usa para se recuperar de um token cifrado com uma
 * `ENCRYPTION_KEY` que mudou.
 *
 * Exige `channel_id`: sem ele não há resposta certa numa conta com
 * dois números, e adivinhar apagaria o errado.
 *
 * Canal com conversas → credenciais apagadas e canal `disabled`,
 * preservando histórico, cooldown e tier. Sem conversas → apagado de
 * verdade, liberando o `phone_number_id`. O porquê está em
 * `removeCloudChannel`.
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    // Aceita na query ou no corpo: a query é o contrato, o corpo existe
    // porque `fetch(..., { method: 'DELETE', body })` é o formato mais
    // natural para quem já monta um JSON.
    let channelId = channelIdParam(request.url);
    if (!channelId) {
      try {
        const body = await request.json();
        if (typeof body?.channel_id === 'string') {
          channelId = body.channel_id.trim() || null;
        }
      } catch {
        // Sem corpo, ou corpo não-JSON. O 400 abaixo explica.
      }
    }

    if (!channelId) {
      return NextResponse.json(
        {
          error:
            'channel_id is required — an account can have more than one official number.',
          code: 'channel_id_required',
        },
        { status: 400 }
      );
    }

    let outcome;
    try {
      outcome = await removeCloudChannel(
        supabase,
        accountId,
        channelId,
        'Número removido pelo operador — credenciais apagadas, histórico preservado.',
        user.id
      );
    } catch (err) {
      if (err instanceof CloudChannelError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      channel_id: channelId,
      // 'deleted' = canal e credencial saíram do banco.
      // 'disabled' = credencial zerada, canal preservado com o
      // histórico (D-12). A UI usa isto para escolher a frase.
      outcome,
    });
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
