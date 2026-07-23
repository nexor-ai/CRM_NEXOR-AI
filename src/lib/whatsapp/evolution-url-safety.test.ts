import { describe, expect, it } from 'vitest'

import { assertSafeEvolutionBaseUrl, isPrivateOrReservedIp } from './evolution-url-safety'

describe('Evolution URL safety', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.10',
    '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '4000::1',
  ])('classifies private/reserved destination %s', (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true)
  })

  it('allows the operator-pinned private Evolution URL', async () => {
    await expect(assertSafeEvolutionBaseUrl('http://127.0.0.1:8080', {
      operatorBaseUrl: 'http://127.0.0.1:8080',
      resolveHost: async () => ['127.0.0.1'],
    })).resolves.toBe('http://127.0.0.1:8080')
  })

  it('rejects tenant-selected private, metadata and credentialed URLs', async () => {
    const resolveHost = async () => ['10.0.0.3']
    await expect(assertSafeEvolutionBaseUrl('https://internal.local:8080', {
      allowedBaseUrls: ['https://internal.local:8080'], resolveHost,
    }))
      .rejects.toThrow(/private|reserved/i)
    await expect(assertSafeEvolutionBaseUrl('http://169.254.169.254/latest/meta-data', {
      allowedBaseUrls: ['http://169.254.169.254/latest/meta-data'],
      resolveHost: async () => ['169.254.169.254'],
    })).rejects.toThrow()
    await expect(assertSafeEvolutionBaseUrl('https://user:pass@evo.example', {
      resolveHost: async () => ['203.0.113.10'],
    })).rejects.toThrow(/credentials/i)
  })

  it('rejects public HTTP and URLs with path/query fragments', async () => {
    const resolveHost = async () => ['8.8.8.8']
    await expect(assertSafeEvolutionBaseUrl('http://evo.example', {
      allowedBaseUrls: ['http://evo.example'], resolveHost,
    }))
      .rejects.toThrow(/https/i)
    await expect(assertSafeEvolutionBaseUrl('https://evo.example/api?x=1', { resolveHost }))
      .rejects.toThrow(/origin/i)
  })

  it('allows a public HTTPS origin only when every resolved address is public', async () => {
    await expect(assertSafeEvolutionBaseUrl('https://evo.example:8443', {
      allowedBaseUrls: ['https://evo.example:8443'],
      resolveHost: async () => ['8.8.8.8', '1.1.1.1'],
    })).resolves.toBe('https://evo.example:8443')

    await expect(assertSafeEvolutionBaseUrl('https://evo.example', {
      allowedBaseUrls: ['https://evo.example'],
      resolveHost: async () => ['8.8.8.8', '127.0.0.1'],
    })).rejects.toThrow(/private|reserved/i)
  })
})
