import { describe, it, expect } from "vitest";
import {
  parseSearchResults, parseSize, DEFAULT_PROFILE,
} from "../server/src/adapters/torrentsearch.js";

// A trimmed-down but structurally faithful KickassTorrents-style results page.
const KAT_HTML = `
<table class="data">
  <tr class="firstr"><th>name</th><th>size</th><th>seeders</th><th>leechers</th></tr>
  <tr class="odd">
    <td>
      <div class="iaconbox center floatright">
        <a title="Torrent magnet link" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Blade+Runner"></a>
      </div>
      <div class="torrentname">
        <a href="/blade-runner-2049-2160p-t123.html" class="cellMainLink">Blade Runner 2049 2160p</a>
      </div>
    </td>
    <td class="nobr center">7.3 <span>GB</span></td>
    <td class="green center">1,234</td>
    <td class="red center">56</td>
  </tr>
  <tr class="even">
    <td>
      <div class="iaconbox center floatright">
        <a title="Torrent magnet link" href="magnet:?xt=urn:btih:89abcdef89abcdef89abcdef89abcdef89abcdef&dn=Other"></a>
      </div>
      <div class="torrentname">
        <a href="https://evil.example/x" class="cellMainLink">Some Other Movie 1080p</a>
      </div>
    </td>
    <td class="nobr center">1.2 <span>GB</span></td>
    <td class="green center">42</td>
    <td class="red center">3</td>
  </tr>
  <tr class="odd">
    <td>
      <div class="torrentname"><a href="/no-magnet-t999.html" class="cellMainLink">No Magnet Here</a></div>
    </td>
    <td class="nobr center">500 MB</td>
    <td class="green center">1</td>
    <td class="red center">0</td>
  </tr>
</table>`;

const BASE = "https://kat.example/";

describe("parseSearchResults (KAT-style default profile)", () => {
  const rows = parseSearchResults(KAT_HTML, DEFAULT_PROFILE, BASE);

  it("extracts title, magnet, seeders, leechers, and size", () => {
    const first = rows[0]!;
    expect(first.title).toBe("Blade Runner 2049 2160p");
    expect(first.magnet).toMatch(/^magnet:\?xt=urn:btih:0123456789abcdef/);
    expect(first.seeders).toBe(1234); // comma stripped
    expect(first.leechers).toBe(56);
    expect(first.sizeBytes).toBe(Math.round(7.3 * 1024 ** 3));
  });

  it("resolves same-origin detail links and drops cross-origin ones (SSRF guard)", () => {
    expect(rows[0]!.detailUrl).toBe("https://kat.example/blade-runner-2049-2160p-t123.html");
    expect(rows[1]!.detailUrl).toBeNull(); // href pointed at evil.example
  });

  it("keeps rows without a magnet as magnet:'' so the caller can resolve from detail pages", () => {
    const noMagnet = rows.find((r) => r.title === "No Magnet Here")!;
    expect(noMagnet.magnet).toBe("");
    expect(noMagnet.detailUrl).toBe("https://kat.example/no-magnet-t999.html");
  });

  it("returns one row per result", () => {
    expect(rows).toHaveLength(3);
  });
});

describe("parseSize", () => {
  it("parses common unit spellings to bytes", () => {
    expect(parseSize("700 MB")).toBe(700 * 1024 ** 2);
    expect(parseSize("1.7 GB")).toBe(Math.round(1.7 * 1024 ** 3));
    expect(parseSize("1 TB")).toBe(1024 ** 4);
    expect(parseSize("1,024 KiB")).toBe(1024 * 1024); // commas + binary spelling
  });
  it("returns null for junk", () => {
    expect(parseSize(undefined)).toBeNull();
    expect(parseSize("")).toBeNull();
    expect(parseSize("lots")).toBeNull();
  });
});
