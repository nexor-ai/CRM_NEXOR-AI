// SSRF guard for outbound webhook delivery.
//
// A target is accepted only when every resolved address is directly public.
// Callers must also pin the validated address into the socket (see
// pinned-request.ts), preventing DNS rebinding between validation and connect.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** True for non-public, special-use, malformed or reserved IPv4/IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((octet) => octet > 255)) return true
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && (b === 0 || b === 168)) return true
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
    if (a === 203 && b === 0) return true
    if (a >= 224) return true // multicast, reserved and broadcast
    return false
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mappedDecimal = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mappedDecimal) return isPrivateOrReservedIp(mappedDecimal[1])

  const value = parseIpv6(v6)
  if (value === null) return true

  // URL and DNS normalize mapped addresses such as ::ffff:127.0.0.1 to
  // ::ffff:7f00:1. Recover the embedded IPv4 before classifying it.
  if (value >> BigInt(32) === BigInt('0xffff')) {
    const embedded = Number(value & BigInt('0xffffffff'))
    return isPrivateOrReservedIp(
      `${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`,
    )
  }

  // Fail closed: only IPv6 global-unicast 2000::/3 is eligible.
  if (value < BigInt('0x20000000000000000000000000000000') || value > BigInt('0x3fffffffffffffffffffffffffffffff')) {
    return true
  }

  // Special transition/documentation ranges are not webhook destinations.
  const prefix32 = Number(value >> BigInt(96))
  const prefix16 = Number(value >> BigInt(112))
  if ([0x20010000, 0x20010002, 0x20010010, 0x20010db8].includes(prefix32)) return true
  if (prefix16 === 0x2002) return true // 6to4
  return false
}

function parseIpv6(raw: string): bigint | null {
  if (raw.includes('%') || raw.split('::').length > 2) return null
  const [leftRaw, rightRaw = ''] = raw.split('::')
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  const missing = 8 - left.length - right.length
  if ((raw.includes('::') && missing < 1) || (!raw.includes('::') && missing !== 0)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(`0x${group}`), BigInt(0))
}

/** True when a HTTP(S) URL resolves exclusively to public addresses. */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    host = url.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host)
  const lower = host.toLowerCase()
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) return false

  try {
    const results = await lookup(host, { all: true })
    return results.length > 0 && results.every(({ address }) => !isPrivateOrReservedIp(address))
  } catch {
    return false
  }
}
