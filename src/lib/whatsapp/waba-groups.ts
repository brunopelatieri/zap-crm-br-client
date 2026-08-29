/**
 * Agrupa os números oficiais de uma conta por WABA distinto
 * (SPEC 064 D-2/F5).
 *
 * Por que agrupar por WABA e não listar por canal
 *
 *   Na Meta, template pertence ao WABA, não ao número: dois canais do
 *   mesmo WABA compartilham a mesma lista de templates aprovados.
 *   Mostrá-los como duas entradas separadas no seletor "Conta do
 *   WhatsApp Business" inventaria uma distinção que não existe do lado
 *   da Meta.
 *
 * Por que isto é uma função pura em `src/lib/`, não inline no componente
 *
 *   É regra de negócio testável sem browser (a mesma razão que já vale
 *   para `cloud-channels.ts`/`template-waba.ts`, ao lado): decide qual
 *   rótulo o seletor mostra e qual canal fala pela conta na Meta quando
 *   dois números compartilham o WABA. Um bug aqui (por exemplo, um
 *   critério de desempate diferente do que `listCloudChannels` usa)
 *   fica invisível sem um teste que o pegue puro, sem rede.
 */

export interface WabaGroupChannelInput {
  channelId: string;
  name: string;
  isDefault: boolean;
  /** `null` = canal ainda sem WABA reconciliado — fica de fora do grupo. */
  wabaId: string | null;
}

export interface WabaGroup {
  wabaId: string;
  /** Nomes dos canais deste WABA, unidos por "/" quando há mais de um. */
  label: string;
  /** Um canal deste WABA — usado para falar com a Meta em nome do grupo. */
  channelId: string;
  isDefault: boolean;
}

/**
 * Um grupo por `wabaId` distinto, padrão primeiro. Canais sem WABA
 * (ainda não reconciliado) não entram em grupo nenhum — o selo "sem
 * WABA" na lista de templates é o que cobre esse caso, não o seletor.
 */
export function buildWabaGroups(
  channels: WabaGroupChannelInput[]
): WabaGroup[] {
  const groups = new Map<string, WabaGroup>();

  for (const c of channels) {
    if (!c.wabaId) continue;
    const existing = groups.get(c.wabaId);
    if (existing) {
      existing.label = `${existing.label} / ${c.name}`;
      existing.isDefault = existing.isDefault || c.isDefault;
    } else {
      groups.set(c.wabaId, {
        wabaId: c.wabaId,
        label: c.name,
        channelId: c.channelId,
        isDefault: c.isDefault,
      });
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault)
  );
}
