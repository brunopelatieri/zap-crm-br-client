// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors. It is NOT a defense against DNS rebinding (a
// host that resolves public here but flips to private before connect) —
// that needs pinning the resolved IP into the socket, which fetch
// doesn't expose; documented as a residual risk.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Four octets of a strict dotted-decimal IPv4, or `null`. */
function parseIPv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

/**
 * Eight 16-bit groups of an IPv6 address, or `null`. Parses the address
 * for real instead of pattern-matching its text: `new URL()` rewrites
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a guard that only knows
 * the dotted form is bypassed by the very URL it is checking.
 */
function parseIPv6(input: string): number[] | null {
  const ip = input.replace(/%.*$/, ''); // zone id (fe80::1%eth0)
  if (isIP(ip) !== 6) return null;

  let text = ip.toLowerCase();
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]);
    if (!v4) return null;
    text =
      dotted[1] +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map(
    (g) => parseInt(g, 16)
  );
  if (groups.length !== 8) return null;
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/** True when the IPv4 is not publicly routable (RFC 6890 and friends). */
function isReservedIPv4([a, b, c]: number[]): boolean {
  if (a === 0) return true; // 0/8 "this" network
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + broadcast
  return false;
}

/** IPv4 of the two low groups `[hi, lo]`, as four octets. */
function v4From(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isReservedIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  const firstFiveZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::/128 unspecified, ::1/128 loopback, ::/96 IPv4-compatible (deprecated).
  if (firstFiveZero && g5 === 0) {
    if (g6 === 0) return true; // ::, ::1 and everything in ::/112
    return isReservedIPv4(v4From(g6, g7));
  }
  // ::ffff:0:0/96 IPv4-mapped — the bypass this parser exists to close.
  if (firstFiveZero && g5 === 0xffff) return isReservedIPv4(v4From(g6, g7));
  // ::ffff:0:0:0/96 IPv4-translated (RFC 2765).
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0xffff &&
    g5 === 0
  ) {
    return isReservedIPv4(v4From(g6, g7));
  }
  // 64:ff9b::/96 NAT64 well-known prefix.
  if (
    g0 === 0x64 &&
    g1 === 0xff9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0
  ) {
    return isReservedIPv4(v4From(g6, g7));
  }
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): translates to anything.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 2002::/16 6to4: the IPv4 sits in groups 1-2.
  if (g0 === 0x2002) return isReservedIPv4(v4From(g1, g2));
  // 2001::/32 Teredo: server IPv4 in groups 2-3, client IPv4 obfuscated in
  // 6-7. Never a legitimate webhook target — block the whole prefix.
  // The rest of 2001::/23 is IANA special-purpose (benchmarking, ORCHID,
  // AMT, …): block the whole /23, Teredo included.
  if (g0 === 0x2001 && g1 < 0x200) return true;
  // 3fff::/20 documentation (RFC 9637), 5f00::/16 SRv6 SIDs.
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true;
  if (g0 === 0x5f00) return true;
  // 2001:db8::/32 documentation.
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True for loopback / private / link-local / reserved IPv4 or IPv6,
 * including IPv6 forms that embed an IPv4 (mapped, compatible,
 * translated, NAT64, 6to4) in either dotted or hex notation. Anything
 * that does not parse as an IP is treated as reserved (fail-closed).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(bare);
  if (v4) return isReservedIPv4(v4);
  const v6 = parseIPv6(bare);
  if (v6) return isReservedIPv6(v6);
  return true;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, an obvious internal
 * name (`localhost`, `*.local`, `*.internal`), a literal private IP, or
 * a hostname that resolves to any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}
