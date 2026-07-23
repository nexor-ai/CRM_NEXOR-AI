import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

type SafetyOptions = {
  operatorBaseUrl?: string
  allowedBaseUrls?: string[]
  resolveHost?: (hostname: string) => Promise<string[]>
}

export type SafeEvolutionTarget = {
  origin: string
  addresses: string[]
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('Evolution URL must not contain credentials')
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Evolution URL must be an origin without path, query, or fragment')
  }
  return url.origin
}

function defaultAllowedOrigins(): string[] {
  return [
    process.env.EVOLUTION_API_URL,
    ...(process.env.EVOLUTION_ALLOWED_BASE_URLS || '').split(','),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(normalizeOrigin)
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((result, part) => (result << 8) + Number(part), 0) >>> 0
}

function inCidr4(address: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask)
}

export function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  const version = isIP(normalized)
  if (version === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
      ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, prefix]) => inCidr4(normalized, String(network), Number(prefix)))
  }
  if (version === 6) {
    if (normalized.startsWith('::ffff:')) {
      return isPrivateOrReservedIp(normalized.slice('::ffff:'.length))
    }
    const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16)
    const isGlobalUnicast = firstHextet >= 0x2000 && firstHextet <= 0x3fff
    return !isGlobalUnicast || normalized.startsWith('2001:db8:')
  }
  return true
}

async function resolveAll(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export async function resolveSafeEvolutionTarget(
  rawValue: string,
  options: SafetyOptions = {}
): Promise<SafeEvolutionTarget> {
  const origin = normalizeOrigin(rawValue)
  const url = new URL(origin)
  const allowed = new Set([
    ...defaultAllowedOrigins(),
    ...(options.allowedBaseUrls ?? []).map(normalizeOrigin),
    ...(options.operatorBaseUrl ? [normalizeOrigin(options.operatorBaseUrl)] : []),
  ])

  if (!allowed.has(origin)) {
    throw new Error('Evolution URL is not in the operator allowlist')
  }

  const explicitlyPinnedPrivate = options.operatorBaseUrl
    ? normalizeOrigin(options.operatorBaseUrl) === origin
    : normalizeOrigin(process.env.EVOLUTION_API_URL || 'https://invalid.invalid') === origin

  if (url.protocol !== 'https:' && !explicitlyPinnedPrivate) {
    throw new Error('Public Evolution URL must use HTTPS')
  }

  const addresses = await (options.resolveHost ?? resolveAll)(url.hostname)
  if (addresses.length === 0) throw new Error('Evolution hostname did not resolve')
  if (!explicitlyPinnedPrivate && addresses.some(isPrivateOrReservedIp)) {
    throw new Error('Evolution hostname resolves to a private or reserved address')
  }
  return { origin, addresses }
}

export async function assertSafeEvolutionBaseUrl(
  rawValue: string,
  options: SafetyOptions = {}
): Promise<string> {
  return (await resolveSafeEvolutionTarget(rawValue, options)).origin
}
