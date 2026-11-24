/**
 * Open Sourcebook's one address check (`common/addresses.ts`) as the toolbox uses it: every way of writing an address on this
 * computer or a private network is refused, however it is spelled, in IPv4 and in every IPv6 form that carries an
 * IPv4 address; public addresses still pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressText, isPublicAddress, parseAddress, parseIPv4, parseIPv6 } from "../../../common/addresses.ts";
import { allowsAddress, checkUrl, ownAddresses, Refused } from "../src/toolbox/net.ts";

/** A resolver that calls everything public: a host written as an address must be judged without it. */
const publicDns = async () => ["93.184.216.34"];

const refused = async (url: string) => assert.rejects(checkUrl(url, publicDns), Refused, url);

test("every spelling of an address on this computer or a private network is refused", async () => {
  for (const url of [
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0x7f000001/", "http://127.0.0.1./",
    "http://0.0.0.0/", "http://0/", "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.1.1/", "http://100.64.0.1/", "http://169.254.169.254/latest/meta-data/",
    "http://224.0.0.1/", "http://255.255.255.255/", "http://240.0.0.1/", "http://192.0.2.1/", "http://198.18.0.1/", "http://198.51.100.7/", "http://203.0.113.9/", "http://192.0.0.8/",
    "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]:14004/api/v1/projects", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://[::7f00:1]/",
    "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::127.0.0.1]/", "http://[64:ff9b:1::7f00:1]/", "http://[2002:7f00:1::]/", "http://[2002:5db8:d822::]/", "http://[::ffff:a9fe:a9fe]/",
    "http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/", "http://[2001:db8::1]/", "http://[3fff::1]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00:ec2::254]/", "http://[ff02::1]/",
    "http://[::ffff:0:7f00:1]/", "http://[100::1]/", "http://localhost:8650/", "http://api.localhost/", "http://printer.local/", "http://metadata.google.internal/", "http://router.home.arpa/",
  ]) await refused(url);
});

test("public addresses pass, IPv4-mapped and NAT64 forms of them included", async () => {
  for (const [url, address] of [
    ["https://93.184.216.34/", "93.184.216.34"],
    ["https://[::ffff:93.184.216.34]/", "93.184.216.34"],
    ["https://[64:ff9b::5db8:d822]/", "64:ff9b:0:0:0:0:5db8:d822"],
    ["https://[2606:4700::1111]/", "2606:4700:0:0:0:0:0:1111"],
    ["https://example.org/", "93.184.216.34"],
  ] as const) assert.equal((await checkUrl(url, publicDns)).address, address, url);
});

test("a name is refused when any address it has is private, or it has none, or one the check can't read", async () => {
  await assert.rejects(checkUrl("https://two-faced.example/", async () => ["93.184.216.34", "::ffff:7f00:1"]), /private network/);
  await assert.rejects(checkUrl("https://nowhere.example/", async () => []), /could not be found/);
  await assert.rejects(checkUrl("https://down.example/", async () => Promise.reject(new Error("dns down"))), /could not be found/);
  await assert.rejects(checkUrl("https://odd.example/", async () => ["not-an-address"]), /private network/);
});

test("this computer's own addresses are refused even when they are public", () => {
  const own = [...ownAddresses()];
  assert.ok(own.includes("127.0.0.1"));
  for (const a of own) assert.equal(allowsAddress(parseAddress(a)!), false, a);
});

test("addresses are read into bytes the way a URL parser and a resolver read them", () => {
  for (const s of ["127.0.0.1", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "0x7f.0.0.1", "0x7F000001", "127.0.1", "017700000001"]) assert.deepEqual([...parseIPv4(s)!], [127, 0, 0, 1], s);
  for (const s of ["256.0.0.1", "1.2.3.4.5", "0x1.0x2.0x3.0x4.0x5", "08.0.0.1", "1..2", "", "a.b.c.d", "4294967296"]) assert.equal(parseIPv4(s), undefined, s);
  // WHATWG URL already writes these as dotted IPv4; the check reads the bytes either way.
  for (const s of ["2130706433", "0x7f.1", "0177.0.0.1", "127.1"]) assert.equal(new URL(`http://${s}/`).hostname, "127.0.0.1");
  assert.deepEqual([...parseIPv6("::ffff:127.0.0.1")!], [...parseIPv6("[::ffff:7f00:1]")!]);
  for (const s of ["1::2::3", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "fe80::1%en0", "1.2.3.4::", "::12345", "1:2:3:4:5:6:7"]) assert.equal(parseIPv6(s), undefined, s);
  assert.equal(addressText(parseAddress("::ffff:7f00:1")!).address, "127.0.0.1");
});

/** Every way to write `v4` that a URL or a resolver reads as that address, in IPv4 and in IPv6 that carries it. */
function spellings([a, b, c, d]: number[]): string[] {
  const n = ((a! << 24) >>> 0) + (b! << 16) + (c! << 8) + d!;
  const hex = (x: number, w = 0) => x.toString(16).padStart(w, "0");
  const hi = hex((a! << 8) | b!);
  const lo = hex((c! << 8) | d!);
  const v4 = [
    `${a}.${b}.${c}.${d}`, String(n), `0x${hex(n)}`, `0x${hex(n, 8).toUpperCase()}`, `0${n.toString(8)}`,
    [a, b, c, d].map((x) => `0${x!.toString(8)}`).join("."), [a, b, c, d].map((x) => `0x${hex(x!)}`).join("."),
    `${a}.${(b! << 16) + (c! << 8) + d!}`, `${a}.${b}.${(c! << 8) + d!}`, `0x${hex(a!)}.${b}.0${c!.toString(8)}.${d}`, `${a}.${b}.${c}.${d}.`,
  ];
  // Teredo: the client's IPv4 address is the last 32 bits, each bit flipped.
  const teredo = `2001:0:4136:e378:8000:63bf:${hex(~((a! << 8) | b!) & 0xffff)}:${hex(~((c! << 8) | d!) & 0xffff)}`;
  const v6 = [
    `::ffff:${a}.${b}.${c}.${d}`, `::ffff:${hi}:${lo}`, `0:0:0:0:0:ffff:${hi}:${lo}`, `0000:0000:0000:0000:0000:FFFF:${hi}:${lo}`, `::${hi}:${lo}`, `::${a}.${b}.${c}.${d}`,
    `64:ff9b::${hi}:${lo}`, `64:ff9b::${a}.${b}.${c}.${d}`, `64:ff9b:1::${hi}:${lo}`, `2002:${hi}:${lo}::`, `2002:${hi}:${lo}::1`, teredo, `::ffff:0:${hi}:${lo}`,
  ];
  return [...v4, ...v6.map((s) => `[${s}]`)];
}

/** A few addresses from each IPv4 range that is not the internet: its edges and some inside. */
function privateSamples(): number[][] {
  const ranges: [number[], number][] = [[[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24], [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4]];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: number[][] = [];
  for (const [first, bits] of ranges) {
    const base = first.concat([0, 0, 0, 0]).slice(0, 4).reduce((s, x) => s * 256 + x, 0);
    const size = 2 ** (32 - bits);
    for (const offset of [0, size - 1, 1, ...Array.from({ length: 6 }, () => Math.floor(random() * size))]) {
      const v = base + offset;
      out.push([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    }
  }
  return out;
}

test("every spelling of every private IPv4 address sampled is refused, in IPv4 and IPv6", async () => {
  let tried = 0;
  for (const v4 of privateSamples()) {
    for (const s of spellings(v4)) {
      let url: string;
      try {
        url = new URL(`http://${s}/`).href;
      } catch {
        continue; // not an address any URL can hold, so nothing can be opened with it
      }
      tried++;
      await assert.rejects(checkUrl(url, publicDns), Refused, `${v4.join(".")} as ${s}`);
      // A resolver hands back addresses as text; the same bytes are refused that way too.
      const bytes = parseAddress(s.replace(/^\[|\]$/g, ""));
      if (bytes) assert.equal(isPublicAddress(bytes), false, s);
    }
  }
  assert.ok(tried > 2000, `${tried} spellings tried`);
});

test("public IPv4 addresses pass in the forms that reach them, and 6to4 or Teredo forms never do", async () => {
  for (const v4 of [[93, 184, 216, 34], [8, 8, 8, 8], [1, 1, 1, 1], [151, 101, 1, 69]]) {
    for (const s of spellings(v4)) {
      const reaches = !/^\[(::(?!ffff:)[0-9a-f]+:|::\d|64:ff9b:1:|2002:|2001:0:|::ffff:0:)/i.test(s);
      const url = new URL(`http://${s}/`).href;
      if (reaches) assert.ok(await checkUrl(url, publicDns), s);
      else await assert.rejects(checkUrl(url, publicDns), Refused, s);
    }
  }
});
