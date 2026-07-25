import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseSearchResults, parseSize, solverEndpoint, TorrentSearchAdapter, DEFAULT_PROFILE,
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

describe("solverEndpoint", () => {
  // The solver URL is typed by hand into a config field, so both forms turn up.
  // Joining them wrongly POSTs to the wrong path and reads as "solver broken".
  it("appends /v1 whether or not the base URL ends in a slash", () => {
    expect(solverEndpoint("http://192.168.10.144:8191")).toBe("http://192.168.10.144:8191/v1");
    expect(solverEndpoint("http://192.168.10.144:8191/")).toBe("http://192.168.10.144:8191/v1");
  });

  it("keeps a path prefix, for a solver behind a reverse proxy", () => {
    expect(solverEndpoint("https://solver.example.com/byparr/")).toBe("https://solver.example.com/byparr/v1");
  });
});

describe("health is cheap when a solver is configured", () => {
  // Regression, and an expensive one: health() used to fetch the mirror, which
  // with a solver means launching a browser for 15-45s. The sources page polls
  // it every 60s, so an open tab started a browser a minute until the solver's
  // host fell over. It must talk to the solver, never through it.
  it("never asks the solver to fetch the mirror", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessions: [] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const adapter = new TorrentSearchAdapter({
      baseUrl: "https://example.invalid",
      secret: "",
      extra: { flaresolverrUrl: `http://127.0.0.1:${port}` },
    });
    const h = await adapter.health();
    server.close();

    expect(h.healthy).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toBe("sessions.list"); // not request.get
    expect(JSON.stringify(seen[0])).not.toContain("example.invalid");
  });

  it("reports the source down when the solver is unreachable", async () => {
    const adapter = new TorrentSearchAdapter({
      baseUrl: "https://example.invalid",
      secret: "",
      // Port 1 is reserved and refuses instantly, so this stays fast.
      extra: { flaresolverrUrl: "http://127.0.0.1:1" },
    });
    const h = await adapter.health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toContain("solver unreachable");
  });
});
