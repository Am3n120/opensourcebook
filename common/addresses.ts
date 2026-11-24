/**
 * Which addresses Open Sourcebook opens when a source or a model names one: the one check the scenes toolbox, its headless Chrome,
 * the programs it hands an address to (ffmpeg, yt-dlp) and the engine's link reader all use. Open Sourcebook's own programs (the
 * connector, the scenes service, the voice) are called at the addresses Open Sourcebook is set up with and never pass through here.
 *
 * Only global unicast addresses are opened. Everything else is refused: this computer (loopback, unspecified), the
 * person's own networks (private, link-local, unique-local, carrier-grade NAT), multicast, broadcast, the cloud
 * metadata addresses, and every range set aside for documentation, benchmarks, protocols or later use. An IPv6
 * address that carries an IPv4 one (IPv4-mapped, the old IPv4-compatible form, NAT64, 6to4, Teredo) is judged by the
 * IPv4 address it reaches, or refused outright when its form is only ever used inside a network.
 *
 * Addresses are read into their bytes and judged by those, never by how they are written, so every spelling a URL
 * parser or a resolver accepts (2130706433, 0x7f.1, 0177.0.0.1, 127.1, [::ffff:7f00:1], [::ffff:127.0.0.1]) is judged
 * the same as 127.0.0.1. This file needs nothing from Node or the engine, so both import it as it is.
 */

/**
 * The four bytes of an IPv4 address written any way a URL parser or a resolver reads one: one to four parts, each in
 * decimal, octal (a leading 0) or hex (a leading 0x), the last part filling the bytes that are left (127.1 is
 * 127.0.0.1, 2130706433 is 127.0.0.1). Undefined when the text is not such an address.
 */
export function parseIPv4(text: string): Uint8Array | undefined {
  const parts = (text.endsWith(".") ? text.slice(0, -1) : text).split(".");
  if (parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) value = parseInt(part, 10);
    else return undefined;
    if (!Number.isSafeInteger(value)) return undefined;
    values.push(value);
  }
  const last = values.pop()!;
  if (values.some((v) => v > 255) || last >= 256 ** (4 - values.length)) return undefined;
  const bytes = new Uint8Array(4);
  values.forEach((v, i) => (bytes[i] = v));
  for (let i = 3, rest = last; i >= values.length; i--, rest = Math.floor(rest / 256)) bytes[i] = rest % 256;
  return bytes;
}

/** The sixteen bytes of an IPv6 address, with or without its brackets, a dotted IPv4 tail allowed. Undefined otherwise, a zone (%en0) included. */
export function parseIPv6(text: string): Uint8Array | undefined {
  const s = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (!s.includes(":") || s.includes("%")) return undefined;
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  // A dotted IPv4 tail is allowed only as the address's last part.
  const groups = (half: string, last: boolean): number[] | undefined => {
    if (half === "") return [];
    const out: number[] = [];
    const pieces = half.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (last && i === pieces.length - 1 && piece.includes(".")) {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) return undefined;
        const v4 = piece.split(".").map(Number);
        if (v4.some((n) => n > 255)) return undefined;
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) out.push(parseInt(piece, 16));
      else return undefined;
    }
    return out;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((g, i) => ((bytes[i * 2] = g >> 8), (bytes[i * 2 + 1] = g & 255)));
  return bytes;
}

/** The bytes of an address as a URL or a resolver writes it (IPv6 with or without brackets), or undefined for a name. */
export function parseAddress(text: string): Uint8Array | undefined {
  return text.includes(":") ? parseIPv6(text) : parseIPv4(text);
}

/** [first bytes, prefix length in bits] for each IPv4 range that is not the public internet. */
const IPV4_REFUSED: [number[], number][] = [
  [[0], 8], // "this network", 0.0.0.0 included
  [[10], 8], // private
  [[100, 64], 10], // carrier-grade NAT
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, 169.254.169.254 (cloud metadata) included
  [[172, 16], 12], // private
  [[192, 0, 0], 24], // protocol assignments
  [[192, 0, 2], 24], // documentation
  [[192, 88, 99], 24], // old 6to4 relays
  [[192, 168], 16], // private
  [[198, 18], 15], // benchmarks
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved, 255.255.255.255 included
];

function inRange(bytes: Uint8Array, offset: number, [first, bits]: [number[], number]): boolean {
  for (let i = 0; i * 8 < bits; i++) {
    const mask = bits - i * 8 >= 8 ? 255 : (255 << (8 - (bits - i * 8))) & 255;
    if ((bytes[offset + i]! & mask) !== ((first[i] ?? 0) & mask)) return false;
  }
  return true;
}

const publicIPv4 = (bytes: Uint8Array, offset = 0) => !IPV4_REFUSED.some((r) => inRange(bytes, offset, r));

const zeros = (bytes: Uint8Array, from: number, to: number) => bytes.subarray(from, to).every((b) => b === 0);

/**
 * True only for an address on the public internet. IPv6 must be global unicast (2000::/3) outside the ranges set
 * aside in it (2001::/23 with Teredo, 2001:db8::/32, 2002::/16 6to4, 3fff::/20), or an IPv4-mapped or NAT64
 * (64:ff9b::/96) address whose IPv4 address is public. Anything that is not four or sixteen bytes is refused.
 */
export function isPublicAddress(bytes: Uint8Array): boolean {
  if (bytes.length === 4) return publicIPv4(bytes);
  if (bytes.length !== 16) return false;
  // ::ffff:a.b.c.d reaches a.b.c.d itself.
  if (zeros(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return publicIPv4(bytes, 12);
  // 64:ff9b::a.b.c.d is a network's NAT64 gateway reaching a.b.c.d (a phone hotspot or an IPv6-only network).
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(bytes, 4, 12)) return publicIPv4(bytes, 12);
  if ((bytes[0]! & 0xe0) !== 0x20) return false; // outside 2000::/3: ::1, ::, ::a.b.c.d, fc00::/7, fe80::/10, ff00::/8, 64:ff9b:1::/48 ...
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2]! < 0x02) return false; // 2001::/23, Teredo (2001::/32) included
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0) return false; // documentation
  return true;
}

/** The address as text a socket connects to: dotted IPv4 (an IPv4-mapped IPv6 address becomes its IPv4 address), else full IPv6. */
export function addressText(bytes: Uint8Array): { address: string; family: 4 | 6 } {
  if (bytes.length === 16 && zeros(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return addressText(bytes.subarray(12));
  if (bytes.length === 4) return { address: [...bytes].join("."), family: 4 };
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return { address: groups.join(":"), family: 6 };
}

/** Names that are this computer or its own network by what they are called, before any resolver is asked. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h);
}

/** An address Open Sourcebook may open, read: the URL, its host, and the host's bytes when the host is an address and not a name. */
export interface Target {
  url: URL;
  host: string;
  literal?: Uint8Array;
}

/**
 * Reads an address before anything is fetched: only http and https, no user name or password, no name that is this
 * computer's, and a host written as an address must be public. A name still has to be resolved and each of its
 * addresses checked with `isPublicAddress` by the caller, which also connects to one of those checked addresses.
 * Returns the reason in plain words when the address is refused. `allows` is `isPublicAddress` unless the caller
 * knows more (this computer's own addresses) or is a test standing a local server in for the internet.
 */
export function readTarget(raw: string, allows: (address: Uint8Array) => boolean = isPublicAddress): Target | { refused: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { refused: `"${raw.slice(0, 200)}" is not a web address.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: `Only http and https addresses can be opened, not ${url.protocol}` };
  if (url.username || url.password) return { refused: "Addresses with a user name or password are not opened." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || isLocalName(host)) return { refused: `${host || "That address"} is on this computer or its network, which is never opened for a source or a tool.` };
  const literal = parseAddress(host);
  if (!literal && host.includes(":")) return { refused: `${host} is not an address that can be opened.` };
  if (literal && !allows(literal)) return { refused: refusedHost(host) };
  return { url, host, ...(literal ? { literal } : {}) };
}

/** The plain reason a host whose address is not public is refused. */
export const refusedHost = (host: string) => `${host} is on this computer or a private network, which is never opened for a source or a tool.`;
