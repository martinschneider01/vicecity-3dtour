import fs from 'node:fs';

const SECTOR = 2048;

export interface ImgEntry {
  /** Original name, with extension (e.g. "od_bphq.dff"). */
  name: string;
  /** Byte offset in the .img. */
  offset: number;
  /** Size in bytes (multiple of 2048). */
  size: number;
}

/**
 * IMG archive version 1 (GTA III / Vice City): a .dir file listing 32-byte
 * entries (offset and size in 2048-byte sectors, then a zero-terminated
 * 24-character name) and an .img file holding the raw data. The archive is
 * opened read-only.
 */
export class ImgArchive {
  /** Entries indexed by lowercase name. */
  readonly entries = new Map<string, ImgEntry>();
  private readonly fd: number;

  constructor(imgPath: string, dirPath: string) {
    const dir = fs.readFileSync(dirPath);
    if (dir.length % 32 !== 0) {
      throw new Error(`${dirPath}: size ${dir.length} is not a multiple of 32`);
    }
    for (let p = 0; p < dir.length; p += 32) {
      const offset = dir.readUInt32LE(p) * SECTOR;
      const size = dir.readUInt32LE(p + 4) * SECTOR;
      let end = dir.indexOf(0, p + 8);
      if (end < 0 || end > p + 32) end = p + 32;
      const name = dir.toString('latin1', p + 8, end);
      this.entries.set(name.toLowerCase(), { name, offset, size });
    }
    this.fd = fs.openSync(imgPath, 'r');
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  read(name: string): Buffer | null {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    const buf = Buffer.allocUnsafe(e.size);
    const n = fs.readSync(this.fd, buf, 0, e.size, e.offset);
    return n === e.size ? buf : buf.subarray(0, n);
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
