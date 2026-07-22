import { describe, it, expect } from "vitest";
import { parseNetworkMounts } from "../server/src/lib/mounts.js";

// Representative /proc/self/mountinfo: a mix of local and network filesystems.
const MOUNTINFO = [
  "23 28 0:21 / /proc rw,nosuid,nodev,noexec - proc proc rw",
  "24 28 0:22 / /sys rw,nosuid - sysfs sysfs rw",
  "28 1 0:24 / / rw,relatime - ext4 /dev/sda1 rw",
  "99 28 0:55 / /mnt/media rw,relatime - nfs4 192.168.1.10:/volume1/media rw,vers=4.1",
  "100 28 0:56 / /mnt/backups rw,relatime shared:1 - cifs //192.168.1.10/backups rw,vers=3.0",
  "101 28 0:57 / /mnt/with\\040space rw - nfs 192.168.1.11:/exp rw",
  "102 28 0:58 / /var/lib/docker rw - overlay overlay rw",
].join("\n");

describe("parseNetworkMounts", () => {
  const mounts = parseNetworkMounts(MOUNTINFO);

  it("returns only NFS/SMB mounts, ignoring local filesystems", () => {
    expect(mounts.map((m) => m.fstype).sort()).toEqual(["cifs", "nfs", "nfs4"]);
    expect(mounts.some((m) => m.target === "/")).toBe(false);
    expect(mounts.some((m) => m.fstype === "overlay")).toBe(false);
  });

  it("captures target, source and fstype", () => {
    const nfs = mounts.find((m) => m.target === "/mnt/media")!;
    expect(nfs.fstype).toBe("nfs4");
    expect(nfs.source).toBe("192.168.1.10:/volume1/media");
    const cifs = mounts.find((m) => m.target === "/mnt/backups")!;
    expect(cifs.fstype).toBe("cifs");
    expect(cifs.source).toBe("//192.168.1.10/backups");
  });

  it("decodes mountinfo octal escapes in paths", () => {
    expect(mounts.some((m) => m.target === "/mnt/with space")).toBe(true);
  });

  it("ignores malformed lines without a separator", () => {
    expect(parseNetworkMounts("garbage line with no dash sep\n")).toEqual([]);
  });
});
