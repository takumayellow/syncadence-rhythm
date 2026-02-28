function u32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function findEocd(bytes: Uint8Array): number {
  const sig = 0x06054b50;
  const min = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (u32LE(bytes, i) === sig) return i;
  }
  return -1;
}

function parseCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error("ZIP EOCD not found");
  const total = bytes[eocd + 10] | (bytes[eocd + 11] << 8);
  const centralOffset = u32LE(bytes, eocd + 16);
  let ptr = centralOffset;
  const entries: ZipEntry[] = [];

  for (let i = 0; i < total; i += 1) {
    if (u32LE(bytes, ptr) !== 0x02014b50) throw new Error("ZIP central header invalid");
    const method = bytes[ptr + 10] | (bytes[ptr + 11] << 8);
    const compressedSize = u32LE(bytes, ptr + 20);
    const uncompressedSize = u32LE(bytes, ptr + 24);
    const nameLen = bytes[ptr + 28] | (bytes[ptr + 29] << 8);
    const extraLen = bytes[ptr + 30] | (bytes[ptr + 31] << 8);
    const commentLen = bytes[ptr + 32] | (bytes[ptr + 33] << 8);
    const localHeaderOffset = u32LE(bytes, ptr + 42);
    const name = new TextDecoder("utf-8").decode(bytes.slice(ptr + 46, ptr + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function getCompressedData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const base = entry.localHeaderOffset;
  if (u32LE(bytes, base) !== 0x04034b50) throw new Error("ZIP local header invalid");
  const nameLen = bytes[base + 26] | (bytes[base + 27] << 8);
  const extraLen = bytes[base + 28] | (bytes[base + 29] << 8);
  const start = base + 30 + nameLen + extraLen;
  return bytes.slice(start, start + entry.compressedSize);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const comp = getCompressedData(bytes, entry);
  if (entry.method === 0) return comp;
  if (entry.method === 8) {
    const out = await inflateRaw(comp);
    if (entry.uncompressedSize > 0 && out.length !== entry.uncompressedSize) {
      return out;
    }
    return out;
  }
  throw new Error(`Unsupported ZIP method: ${entry.method}`);
}

function resolveContainerPath(containerXml: string): string | null {
  const doc = new DOMParser().parseFromString(containerXml, "application/xml");
  const root = doc.querySelector("rootfile");
  return root?.getAttribute("full-path") ?? null;
}

export async function extractMusicXmlFromMxl(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const entries = parseCentralDirectory(bytes);
  const lowerMap = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const decoder = new TextDecoder("utf-8");

  let xmlEntry: ZipEntry | undefined;
  const containerEntry = lowerMap.get("meta-inf/container.xml");
  if (containerEntry) {
    const containerBytes = await readEntry(bytes, containerEntry);
    const path = resolveContainerPath(decoder.decode(containerBytes));
    if (path) xmlEntry = lowerMap.get(path.toLowerCase());
  }
  if (!xmlEntry) {
    xmlEntry = entries.find((e) => /\.(musicxml|xml)$/i.test(e.name));
  }
  if (!xmlEntry) throw new Error("MusicXML entry not found in MXL");

  const xmlBytes = await readEntry(bytes, xmlEntry);
  return decoder.decode(xmlBytes);
}
