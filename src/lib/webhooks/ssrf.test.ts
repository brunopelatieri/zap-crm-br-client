import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of [
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12::34',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  // Revisão de segurança SPEC 088, achado 2: `new URL()` normaliza o IPv4
  // mapeado para hex, e a guarda antiga só reconhecia a forma com pontos.
  it('flags IPv4-mapped IPv6 in hex form (as new URL() normalizes it)', () => {
    for (const ip of [
      '::ffff:7f00:1', // 127.0.0.1
      '::ffff:ac11:1', // 172.17.0.1 (docker0)
      '::ffff:a9fe:a9fe', // 169.254.169.254 (metadata)
      '::ffff:a00:5', // 10.0.0.5
      '::ffff:c0a8:101', // 192.168.1.1
      '0:0:0:0:0:ffff:7f00:1',
      '[::ffff:7f00:1]',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('flags private IPv4 embedded in compat / translated / NAT64 / 6to4', () => {
    for (const ip of [
      '::7f00:1', // ::/96 compat → 127.0.0.1
      '::127.0.0.1',
      '::ffff:0:7f00:1', // translated → 127.0.0.1
      '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
      '64:ff9b::a9fe:a9fe', // NAT64 → metadata
      '64:ff9b:1::1', // local-use NAT64
      '2002:7f00:1::', // 6to4 → 127.0.0.1
      '2002:c0a8:101::1', // 6to4 → 192.168.1.1
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '2001:2::1', // benchmarking (2001::/23)
      '2001:10::1', // ORCHID (2001::/23)
      '3fff::1', // documentation (RFC 9637)
      '5f00::1', // SRv6
      '2001:db8::1', // documentation
      'fec0::1', // site-local
      'ff02::1', // multicast
      'fe80::1%eth0',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('allows a public IPv4 embedded in IPv6', () => {
    for (const ip of [
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it('flags multicast, reserved, benchmark and IETF IPv4 ranges', () => {
    for (const ip of [
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.8',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    expect(isPrivateOrReservedIp('198.20.0.1')).toBe(false);
    expect(isPrivateOrReservedIp('223.255.255.255')).toBe(false);
  });

  it('treats anything that is not an IP as reserved (fail-closed)', () => {
    for (const ip of ['', 'example.com', '1.2.3', '::ffff:zz', '1:2:3']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(
      await isDeliverableUrl('https://169.254.169.254/latest/meta-data')
    ).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 literals in any notation', async () => {
    for (const url of [
      'https://[::ffff:127.0.0.1]:8443/x',
      'https://[::ffff:7f00:1]/hook',
      'https://[::ffff:172.17.0.1]/hook',
      'https://[::ffff:169.254.169.254]/hook',
      'https://[::ffff:a9fe:a9fe]/hook',
      'https://[64:ff9b::7f00:1]/hook',
      'https://[::1]/hook',
    ]) {
      expect(await isDeliverableUrl(url), url).toBe(false);
    }
  });

  it('allows an IPv4-mapped public address', async () => {
    expect(await isDeliverableUrl('https://[::ffff:8.8.8.8]/hook')).toBe(true);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
