import { describe, expect, it } from "vitest";
import { findCashuToken } from "./cashuTokenText";

const V4 = "cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb21hdWNzYXRhdIGiYWlIAJofKTJT5B5hcIGkYWEE";
const V3 = "cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludC5leGFtcGxlLmNvbSIsInByb29mcyI6W119XX0=";

describe("findCashuToken", () => {
  it("finds v3 and v4 tokens inside a message", () => {
    expect(findCashuToken(`Here you go: ${V4} thanks!`)).toBe(V4);
    expect(findCashuToken(`${V3}.`)).toBe(V3);
  });

  it("reads cashu: links and tokens wrapped across lines", () => {
    expect(findCashuToken(`cashu:${V4}`)).toBe(V4);
    expect(findCashuToken(`cashu:?token=${encodeURIComponent(V4)}`)).toBe(V4);
    expect(findCashuToken(`${V4.slice(0, 40)}\n${V4.slice(40)}`)).toBe(V4);
  });

  it("ignores text that only mentions cashu", () => {
    expect(findCashuToken("I like cashu a lot")).toBeNull();
    expect(findCashuToken("cashuB short")).toBeNull();
    expect(findCashuToken("")).toBeNull();
  });
});
