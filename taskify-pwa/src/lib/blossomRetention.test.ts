// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import {
  DEFAULT_BLOSSOM_FALLBACK_PREFERENCE,
  getBlossomFallbackPreference,
  setBlossomFallbackPreference,
} from "./blossomRetention";

beforeEach(() => localStorage.clear());

test("defaults automatic fallback on and remembers changes separately for each account and server", () => {
  expect(getBlossomFallbackPreference("a".repeat(64), "https://one.example")).toEqual(
    DEFAULT_BLOSSOM_FALLBACK_PREFERENCE,
  );

  setBlossomFallbackPreference("a".repeat(64), "https://one.example", {
    automaticFallback: true,
    termsFingerprint: "terms-one",
  });

  expect(getBlossomFallbackPreference("a".repeat(64), "https://one.example")?.automaticFallback).toBe(true);
  expect(getBlossomFallbackPreference("b".repeat(64), "https://one.example")).toEqual(
    DEFAULT_BLOSSOM_FALLBACK_PREFERENCE,
  );
  expect(getBlossomFallbackPreference("a".repeat(64), "https://two.example")).toEqual(
    DEFAULT_BLOSSOM_FALLBACK_PREFERENCE,
  );

  setBlossomFallbackPreference("a".repeat(64), "https://one.example", {
    automaticFallback: false,
    termsFingerprint: "terms-two",
  });
  expect(getBlossomFallbackPreference("a".repeat(64), "https://one.example")).toMatchObject({
    automaticFallback: false,
    termsFingerprint: "terms-two",
  });
});
