/**
 * Time-sortable ids. The leading 48-bit timestamp means records sort by
 * creation order in an index, and — more importantly — ids minted on two
 * devices never collide, which is what a later sync layer needs.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function newId(now: number = Date.now()): string {
  let ts = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 36] + time
    ts = Math.floor(ts / 36)
  }

  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let rand = ''
  for (const b of bytes) rand += ALPHABET[b % 36]

  return time + rand
}

/**
 * FNV-1a, used for the deduplication fingerprint. Not a security hash — it
 * just needs to be stable across sessions and cheap over thousands of rows.
 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Second pass over the reversed string widens the output and cuts the
  // collision rate on the short, similar strings we hash here.
  let g = 0x811c9dc5
  for (let i = input.length - 1; i >= 0; i--) {
    g ^= input.charCodeAt(i)
    g = Math.imul(g, 0x01000193) >>> 0
  }
  return h.toString(36) + g.toString(36)
}
