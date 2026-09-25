import { describe, expect, it } from "vitest";
import { mintBackupIsCurrent } from "./mintBackup";

describe("mintBackupIsCurrent", () => {
  const now = 1_790_000_000;
  it("is current when the same mints were backed up recently, in any order", () => {
    expect(mintBackupIsCurrent({ mints: ["https://b", "https://a"], timestamp: now - 3600 }, ["https://a", "https://b"], now)).toBe(true);
  });
  it("is stale when the mint list changed, the backup is old, or none exists", () => {
    expect(mintBackupIsCurrent({ mints: ["https://a"], timestamp: now - 60 }, ["https://a", "https://c"], now)).toBe(false);
    expect(mintBackupIsCurrent({ mints: ["https://a"], timestamp: now - 31 * 86400 }, ["https://a"], now)).toBe(false);
    expect(mintBackupIsCurrent(null, ["https://a"], now)).toBe(false);
  });
});
