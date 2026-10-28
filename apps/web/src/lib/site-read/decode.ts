/**
 * windows-1252 decoded by the WHATWG index, the same on every Node.
 *
 * Node 22.22's TextDecoder takes a Latin-1 fast path for this label and reads
 * 0x80-0x9F as C1 control characters (an em dash, 0x97, comes back as U+0097,
 * curly quotes as controls), while Node 24 decodes them as the index says. A
 * scraped page declaring windows-1252 or iso-8859-1 (which browsers also treat
 * as windows-1252) would lose its dashes and quotes on one and not the other.
 * Bytes outside 0x80-0x9F are the Latin-1 code points; the five unassigned
 * bytes decode to the C1 controls of the same value, as the index says.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x9d, 0x017e, 0x0178,
];

/** The WHATWG labels that name windows-1252 (iso-8859-1 and us-ascii included). */
const WINDOWS_1252_LABELS = new Set([
  "ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819",
  "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1",
  "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252",
]);

export function isWindows1252(label: string): boolean {
  return WINDOWS_1252_LABELS.has(label.trim().toLowerCase());
}

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    const codes: number[] = [];
    for (const byte of bytes.subarray(i, i + 4096)) {
      codes.push(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte);
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}
