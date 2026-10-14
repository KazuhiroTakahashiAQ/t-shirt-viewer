// Tagged value stream used inside many records.
// Each value starts with a one-byte tag (all tags are multiples of 5):
//   0x05 begin list   0x0a end list
//   0x0f u32 length + raw bytes
//   0x14 u8   0x19 i16   0x1e i32   0x2d f64

export type Tagged = number | Uint8Array | Tagged[]

export class TaggedError extends Error {}

/** Decode a tagged stream. With `lenient`, decoding stops quietly at the first unknown tag. */
export function decodeTagged(b: Uint8Array, lenient = false): Tagged[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const root: Tagged[] = []
  const stack: Tagged[][] = [root]
  let p = 0
  const need = (n: number) => {
    if (p + n > b.length) throw new TaggedError(`tagged stream truncated at ${p}`)
  }
  while (p < b.length) {
    const top = stack[stack.length - 1]
    const t = b[p++]
    switch (t) {
      case 0x05: {
        const l: Tagged[] = []
        top.push(l)
        stack.push(l)
        break
      }
      case 0x0a:
        if (stack.length === 1) throw new TaggedError(`unbalanced list end at ${p - 1}`)
        stack.pop()
        break
      case 0x0f: {
        need(4)
        const n = v.getUint32(p, true)
        p += 4
        need(n)
        top.push(b.subarray(p, p + n))
        p += n
        break
      }
      case 0x14:
        need(1)
        top.push(b[p])
        p += 1
        break
      case 0x19:
        need(2)
        top.push(v.getInt16(p, true))
        p += 2
        break
      case 0x1e:
        need(4)
        top.push(v.getInt32(p, true))
        p += 4
        break
      case 0x2d:
        need(8)
        top.push(v.getFloat64(p, true))
        p += 8
        break
      default:
        if (lenient) return root
        throw new TaggedError(`unknown tag 0x${t.toString(16)} at ${p - 1}`)
    }
  }
  return root
}

export function isBytes(x: Tagged | undefined): x is Uint8Array {
  return x instanceof Uint8Array
}

export function isList(x: Tagged | undefined): x is Tagged[] {
  return Array.isArray(x)
}
