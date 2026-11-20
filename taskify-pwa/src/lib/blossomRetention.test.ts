// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import {
  getBlossomFallbackPreference,
  setBlossomFallbackPreference,
} from "./blossomRetention";

beforeEach(() => localStorage.clear());

test("remembers automatic fallback separately for each account and server", () => {
  setBlossomFallbackPreference("a".repeat(64), "https://one.example", {
    automaticFallback: true,
    termsFingerprint: "terms-one",
  });

  expect(getBlossomFallbackPreference("a".repeat(64), "https://one.example")?.automaticFallback).toBe(true);
  expect(getBlossomFallbackPreference("b".repeat(64), "https://one.example")).toBeNull();
  expect(getBlossomFallbackPreference("a".repeat(64), "https://two.example")).toBeNull();

  setBlossomFallbackPreference("a".repeat(64), "https://one.example", {
    automaticFallback: false,
    termsFingerprint: "terms-two",
  });
  expect(getBlossomFallbackPreference("a".repeat(64), "https://one.example")).toMatchObject({
    automaticFallback: false,
    termsFingerprint: "terms-two",
  });
});
