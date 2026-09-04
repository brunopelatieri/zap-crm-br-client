/**
 * Teto absoluto de destinatários por disparo do painel.
 *
 * Casa com o teto de linhas do parser de planilha: uma audiência maior
 * do que isto não consegue nem ser importada, então este número é uma
 * rede de segurança contra um cliente adulterado, não uma regra de
 * produto.
 *
 * Vive num arquivo próprio — sem nenhum outro import — porque
 * `parse-audience.ts` (validação de `AudienceConfig`, CLIENT-SAFE:
 * roda no navegador em `loadBroadcastDraft`/`saveBroadcastDraft`,
 * SPEC 070 §3.1) precisa deste número sem herdar as dependências
 * server-only de `broadcast-dispatch.ts` (`next/server`, nodemailer
 * via a cadeia de notificações). `broadcast-dispatch.ts` reexporta
 * daqui para não quebrar quem já importava de lá.
 */
export const MAX_DASHBOARD_RECIPIENTS = 50_000;
