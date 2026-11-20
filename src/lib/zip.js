/**
 * @file Zero-dependency PKZIP writer with OCF/EPUB 3 compliance.
 * Uses native CompressionStream('deflate-raw') with IEEE 802.3 CRC-32 checksums.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});
  const textEncoder = new TextEncoder();

  // Precomputed IEEE 802.3 CRC-32 lookup table
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
  }

  /**
   * Computes unsigned 32-bit CRC-32 for a Uint8Array.
   * @param {Uint8Array} bytes
   * @returns {number}
   */
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toDosDateTime(date = new Date()) {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { dosTime, dosDate };
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const bufferPromise = new Response(cs.readable).arrayBuffer();
    await writer.write(bytes);
    await writer.close();
    return new Uint8Array(await bufferPromise);
  }

  function hasNonAscii(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) return true;
    }
    return false;
  }

  /**
   * Builds PKZIP chunks (compatible with OCF/EPUB 3 when `mimetype` is entry 0 with `store: true`).
   * @param {Array<{ path: string, data: Uint8Array|string, store?: boolean, mtime?: Date }>} entries
   * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
   * @returns {Promise<Uint8Array[]>}
   */
  async function createZipParts(entries, options = {}) {
    const { signal, onProgress } = options;
    if (entries.length > 0xffff) {
      throw new Error(`ZIP archive exceeds 65,535 entries limit (${entries.length}).`);
    }
    const yieldCtrl = PD.async?.createYieldController
      ? PD.async.createYieldController(50)
      : null;

    const chunks = [];
    const centralRecords = [];
    let offset = 0;

    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      const entry = entries[i];
      const normalizedPath = String(entry.path).replace(/^\/+/, '');
      const nameBytes = textEncoder.encode(normalizedPath);
      const rawBytes =
        entry.data instanceof Uint8Array
          ? entry.data
          : textEncoder.encode(String(entry.data ?? ''));

      const checksum = crc32(rawBytes);
      const utf8Flag = hasNonAscii(nameBytes) ? 0x0800 : 0x0000;
      const { dosTime, dosDate } = toDosDateTime(entry.mtime);

      let method = 0;
      let payload = rawBytes;

      const canCompress =
        !entry.store &&
        rawBytes.byteLength >= 64 &&
        typeof CompressionStream !== 'undefined';

      if (canCompress) {
        const compressed = await deflateRaw(rawBytes);
        if (compressed.byteLength < rawBytes.byteLength) {
          method = 8;
          payload = compressed;
        }
      }

      // Local File Header: exactly 30 bytes + nameBytes.length (extra field length = 0)
      const localHeader = new Uint8Array(30);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // Version needed to extract (2.0)
      lv.setUint16(6, utf8Flag, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, payload.byteLength, true);
      lv.setUint32(22, rawBytes.byteLength, true);
      lv.setUint16(26, nameBytes.byteLength, true);
      lv.setUint16(28, 0, true); // Extra field length MUST be 0 (OCF requirement)

      chunks.push(localHeader, nameBytes, payload);

      // Central Directory File Header: 46 bytes + nameBytes.length
      const cdHeader = new Uint8Array(46);
      const cv = new DataView(cdHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); // Version made by
      cv.setUint16(6, 20, true); // Version needed to extract
      cv.setUint16(8, utf8Flag, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, payload.byteLength, true);
      cv.setUint32(24, rawBytes.byteLength, true);
      cv.setUint16(28, nameBytes.byteLength, true);
      cv.setUint16(30, 0, true); // Extra field length
      cv.setUint16(32, 0, true); // File comment length
      cv.setUint16(34, 0, true); // Disk number start
      cv.setUint16(36, 0, true); // Internal file attributes
      cv.setUint32(38, 0, true); // External file attributes
      cv.setUint32(42, offset, true); // Relative offset of local header

      centralRecords.push(cdHeader, nameBytes);
      offset += localHeader.byteLength + nameBytes.byteLength + payload.byteLength;

      if (typeof onProgress === 'function') {
        onProgress(i + 1, entries.length);
      }
      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const part of centralRecords) {
      chunks.push(part);
      centralDirSize += part.byteLength;
    }

    // End of Central Directory (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralDirSize, true);
    ev.setUint32(16, centralDirOffset, true);
    ev.setUint16(20, 0, true);
    chunks.push(eocd);

    return chunks;
  }

  /**
   * Builds a ZIP archive as a Blob without duplicating buffers in memory.
   * @param {Array<{ path: string, data: Uint8Array|string, store?: boolean, mtime?: Date }>} entries
   * @param {{ mimeType?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
   * @returns {Promise<Blob>}
   */
  async function createZip(entries, options = {}) {
    const parts = await createZipParts(entries, options);
    return new Blob(parts, { type: options.mimeType || 'application/zip' });
  }

  /**
   * Builds a ZIP archive as a contiguous Uint8Array (useful for tests/CLI verification).
   * @param {Array<{ path: string, data: Uint8Array|string, store?: boolean, mtime?: Date }>} entries
   * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
   * @returns {Promise<Uint8Array>}
   */
  async function createZipBytes(entries, options = {}) {
    const parts = await createZipParts(entries, options);
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.byteLength;
    }
    return out;
  }

  PD.zip = {
    crc32,
    createZipParts,
    createZip,
    createZipBytes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.zip;
  }
})();
