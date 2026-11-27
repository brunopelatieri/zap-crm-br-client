/**
 * Encurtamento de nomes de membros da conta (owner, admin, agent, viewer)
 * para exibição em espaços estreitos — banner da caixa de entrada, seletor
 * "ver como", cabeçalho, sidebar, quadro Time, bolhas de mensagem etc.
 *
 * Só vale para NOMES DE EQUIPE. Nome de contato (cliente) não passa por
 * aqui. Campos editáveis (perfil, diálogo de identidade) também não: o
 * usuário precisa ver e editar o valor completo.
 *
 * O CSS (`truncate` + `min-w-0`) continua sendo a rede de proteção; este
 * helper garante o teto de caracteres pedido pelo produto e deixa o texto
 * previsível (inclusive em nomes todo em maiúsculas, que são mais largos).
 */

/** Teto de caracteres, contando a reticência. */
export const MEMBER_NAME_MAX = 22;

const ELLIPSIS = '…';

/**
 * Devolve `name` limitado a `max` caracteres (a reticência entra na
 * conta). Conta por pontos de código, não por unidades UTF-16, para não
 * partir emoji ou caractere fora do BMP ao meio. Espaços nas pontas e
 * repetidos são normalizados antes de medir.
 */
export function truncateMemberName(
  name: string | null | undefined,
  max: number = MEMBER_NAME_MAX
): string {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  if (max <= 1) return ELLIPSIS;
  return chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()
    .concat(ELLIPSIS);
}
