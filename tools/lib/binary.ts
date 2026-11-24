/** Minimal little-endian binary reader on top of a Node Buffer. */
export class Reader {
  pos: number;
  readonly buf: Buffer;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    return this.buf.readUInt8(this.pos++);
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  /** Fixed-size ASCII string, cut at the first zero byte. */
  fixedString(n: number): string {
    const b = this.bytes(n);
    let end = b.indexOf(0);
    if (end < 0) end = n;
    return b.toString('latin1', 0, end);
  }
  f32Array(count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.buf.readFloatLE(this.pos + i * 4);
    this.pos += count * 4;
    return out;
  }
}
