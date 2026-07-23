import { lookup as dnsLookup } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch } from 'undici'

import { isPrivateOrReservedIp } from './ssrf'

const REQUEST_TIMEOUT_MS = 5_000

export interface PinnedTarget {
  url: URL
  address: string
  family: 4 | 6
}

type Resolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>

/**
 * Resolves once, rejects every non-public answer and returns the exact address
 * that the connector must use. The HTTP client must not resolve the hostname a
 * second time, otherwise DNS rebinding reopens the SSRF window.
 */
export async function resolvePinnedPublicTarget(
  rawUrl: string,
  resolver: Resolver = (hostname) => lookup(hostname, { all: true }),
): Promise<PinnedTarget> {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('webhook URL must use http or https')
  }
  if (url.username || url.password) {
    throw new Error('webhook URL must not contain credentials')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname)

  if (addresses.length === 0) throw new Error('webhook hostname did not resolve')
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error('webhook target is not publicly routable')
  }

  const selected = addresses[0]
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error('webhook hostname resolved to an unsupported address')
  }
  return { url, address: selected.address, family: selected.family }
}

export async function postJsonToPinnedPublicUrl(
  rawUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const target = await resolvePinnedPublicTarget(rawUrl)
  const pinnedLookup = ((
    _hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => callback(null, target.address, target.family)) as typeof dnsLookup

  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } })
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      dispatcher,
    })
    await response.body?.cancel()
    return response.status
  } finally {
    await dispatcher.close()
  }
}
