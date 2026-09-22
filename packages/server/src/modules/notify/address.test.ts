/**
 * Whether the hub may call a URL a person typed. These are the rules that stop "add a
 * webhook" from meaning "knock on any door this hub can reach".
 */
import { describe, expect, it } from 'vitest';
import { checkAddress, isPrivateAddress } from './address.js';

const resolves = (map: Record<string, string[]>) => async (host: string) => {
  const found = map[host];
  if (!found) throw new Error('nxdomain');
  return found;
};

describe('addresses nobody should be able to make the hub call', () => {
  it('knows the private IPv4 ranges', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('lets the public ones through', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '203.0.113.5']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('judges IPv6 and an IPv4 mapped into it', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});

describe('checking a webhook URL', () => {
  const dns = resolves({ 'example.com': ['93.184.216.34'], 'sneaky.example': ['127.0.0.1'] });

  it('accepts a public https URL', async () => {
    await expect(checkAddress('https://example.com/hook', false, dns)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses anything that is not http or https', async () => {
    await expect(checkAddress('file:///etc/passwd', true, dns)).resolves.toMatchObject({
      ok: false,
      reason: 'scheme',
    });
  });

  it('refuses a public name that resolves somewhere private', async () => {
    // The whole point of checking addresses and not hostnames.
    await expect(checkAddress('https://sneaky.example/hook', false, dns)).resolves.toMatchObject({
      ok: false,
      reason: 'private',
      detail: '127.0.0.1',
    });
  });

  it('allows the private one when the webhook says so on purpose', async () => {
    await expect(checkAddress('https://sneaky.example/hook', true, dns)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses a name that resolves to nothing, instead of trying anyway', async () => {
    await expect(checkAddress('https://nowhere.invalid/hook', false, dns)).resolves.toMatchObject({
      ok: false,
      reason: 'unresolvable',
    });
  });

  it('judges a literal address without asking DNS', async () => {
    await expect(checkAddress('http://192.168.0.5/hook', false, dns)).resolves.toMatchObject({
      ok: false,
      reason: 'private',
    });
  });
});
