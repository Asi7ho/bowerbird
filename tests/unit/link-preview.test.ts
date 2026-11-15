// Unit tests for the link-preview parsers and the private-host
// gate (electron/link-preview.ts): the SSRF boundary, tested
// without launching the app. No DOM, no Electron, so these run
// in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  isPrivateHost,
  linkHref,
  metaContent,
  tagContent,
} from "../../electron/link-preview";

// The callers pass new URL(input).hostname, so the gate sees
// the hostname after WHATWG normalisation — test it that way
// for the forms a URL can smuggle in.
function hostOf(input: string): string {
  return new URL(input).hostname;
}

describe("isPrivateHost", () => {
  it.each([
    ["localhost", true],
    ["localhost.", true],
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["example.com", false],
    ["foo.local", true],
    ["", true],
  ])("%s -> %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it("rejects IPv6 localhost and private ranges, bracketed or not", () => {
    for (const host of ["::1", "[::1]", "fe80::1", "[fe80::1]", "fc00::1", "fd12:3456::1"]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost("2001:db8::1")).toBe(false);
    expect(isPrivateHost("[2001:db8::1]")).toBe(false);
  });

  it("decodes IPv4-mapped IPv6, where the embedded address is hex", () => {
    // WHATWG URL returns the mapped form as "::ffff:7f00:1" for
    // 127.0.0.1 — the dotted checks never see it.
    expect(isPrivateHost(hostOf("http://[::ffff:7f00:1]/"))).toBe(true);
    expect(isPrivateHost(hostOf("http://[::ffff:0a00:1]/"))).toBe(true);
    expect(isPrivateHost(hostOf("http://[::ffff:c0a8:101]/"))).toBe(true);
    expect(isPrivateHost(hostOf("http://[::ffff:808:808]/"))).toBe(false);
  });

  it("catches hex, octal and decimal IPv4, which the URL parser normalises", () => {
    expect(hostOf("http://0x7f000001/")).toBe("127.0.0.1");
    expect(hostOf("http://0177.0.0.1/")).toBe("127.0.0.1");
    expect(hostOf("http://2130706433/")).toBe("127.0.0.1");
    for (const input of ["http://0x7f000001/", "http://0177.0.0.1/", "http://2130706433/"]) {
      expect(isPrivateHost(hostOf(input))).toBe(true);
    }
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;q&quot; &#39;s&#39; &nbsp;x")).toBe(
      "a & b <c> \"q\" 's'  x",
    );
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("no entities")).toBe("no entities");
  });
});

describe("metaContent", () => {
  it("finds og/twitter/description content in either quote style", () => {
    const html = `<meta property="og:title" content="Hello &amp; bye"><meta name='description' content='plain'>`;
    expect(metaContent(html, "og:title")).toBe("Hello & bye");
    expect(metaContent(html, "description")).toBe("plain");
    expect(metaContent(html, "og:image")).toBeNull();
  });
});

describe("tagContent", () => {
  it("reads a tag's text, decoded", () => {
    expect(tagContent("<title>Fish &amp; Chips</title>", "title")).toBe("Fish & Chips");
    expect(tagContent("<title></title>", "title")).toBeNull();
    expect(tagContent("<p>no title here</p>", "title")).toBeNull();
  });
});

describe("linkHref", () => {
  it("finds icon and apple-touch-icon links, nothing else", () => {
    const html = `<link rel="stylesheet" href="/a.css"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/touch.png">`;
    expect(linkHref(html, ["icon", "apple-touch-icon"])).toBe("/favicon.ico");
    expect(linkHref(html, ["apple-touch-icon"])).toBe("/touch.png");
    expect(linkHref(html, ["manifest"])).toBeNull();
  });
});
