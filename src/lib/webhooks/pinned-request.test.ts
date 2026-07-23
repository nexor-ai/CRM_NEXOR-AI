import { describe, expect, it, vi } from 'vitest'

import { resolvePinnedPublicTarget } from './pinned-request'

describe('resolvePinnedPublicTarget', () => {
  it('pins one public DNS answer and never asks the resolver twice', async () => {
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])

    const target = await resolvePinnedPublicTarget('https://example.test/hook', resolver)

    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledWith('example.test')
    expect(target.address).toBe('93.184.216.34')
    expect(target.family).toBe(4)
    expect(target.url.hostname).toBe('example.test')
  })

  it.each([
    '127.0.0.1',
    '10.0.0.2',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fc00::1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '224.0.0.1',
    '240.0.0.1',
  ])('rejects a private or reserved resolved address: %s', async (address) => {
    await expect(
      resolvePinnedPublicTarget('https://example.test/hook', async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]),
    ).rejects.toThrow(/not publicly routable/i)
  })

  it('rejects mixed public/private DNS answers instead of selecting the public one', async () => {
    await expect(
      resolvePinnedPublicTarget('https://example.test/hook', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow(/not publicly routable/i)
  })

  it('rejects URL credentials and non-http protocols', async () => {
    await expect(
      resolvePinnedPublicTarget('https://user:pass@example.test/hook'),
    ).rejects.toThrow(/credentials/i)
    await expect(resolvePinnedPublicTarget('file:///etc/passwd')).rejects.toThrow(/http or https/i)
  })
})
