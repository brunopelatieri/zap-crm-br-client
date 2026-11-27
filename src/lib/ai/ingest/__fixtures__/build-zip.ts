import { deflateRawSync } from 'node:zlib';

// Monta um ZIP mínimo em memória, para os testes de ZIP bomba e de ZIP
// malformado. Não calcula CRC (a guarda e o `mammoth` não dependem dele aqui).

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** 8 (deflate, padrão) ou 0 (armazenado). */
  method?: 0 | 8;
  /** Bits gerais (bit 0 = cifrada). */
  flags?: number;
  /** Tamanho "descompactado" declarado (mentira possível). */
  declaredSize?: number;
  /** Método escrito no diretório central (para simular método desconhecido). */
  centralMethod?: number;
}

export function buildZip(
  entries: ZipEntry[],
  opts: { comment?: Buffer; zip64Marker?: boolean } = {}
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.declaredSize ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(e.centralMethod ?? method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.declaredSize ?? e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64Marker ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(opts.zip64Marker ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd, comment]));
}
