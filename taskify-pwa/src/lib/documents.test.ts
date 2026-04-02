import { describe, test, expect } from "vitest";
import { normalizeDocumentList } from "./documents";

// ── normalizeDocumentList ─────────────────────────────────────────────────────

describe("normalizeDocumentList – legacy inline documents", () => {
  test("accepts document with dataUrl", () => {
    const raw = [
      {
        id: "abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        dataUrl: "data:application/pdf;base64,AAAA",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("report.pdf");
    expect(result![0].dataUrl).toBe("data:application/pdf;base64,AAAA");
    expect(result![0].remoteUrl).toBeUndefined();
    expect(result![0].encrypted).toBeUndefined();
  });

  test("drops document missing both dataUrl and remoteUrl", () => {
    const raw = [{ id: "x", name: "file.pdf", mimeType: "application/pdf", kind: "pdf" }];
    const result = normalizeDocumentList(raw);
    expect(result).toBeUndefined();
  });

  test("drops document missing name", () => {
    const raw = [{ id: "x", dataUrl: "data:application/pdf;base64,AAAA", kind: "pdf" }];
    const result = normalizeDocumentList(raw);
    expect(result).toBeUndefined();
  });
});

describe("normalizeDocumentList – remote-first documents", () => {
  test("accepts document with remoteUrl but no dataUrl", () => {
    const raw = [
      {
        id: "remote1",
        name: "contract.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        remoteUrl: "https://cdn.example.com/contract.enc",
        encrypted: true,
        createdAt: "2024-06-01T00:00:00.000Z",
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    const doc = result![0];
    expect(doc.name).toBe("contract.pdf");
    expect(doc.dataUrl).toBe("");
    expect(doc.remoteUrl).toBe("https://cdn.example.com/contract.enc");
    expect(doc.encrypted).toBe(true);
  });

  test("preserves remoteUrl and encrypted on inline-plus-remote document", () => {
    const raw = [
      {
        id: "r2",
        name: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "xlsx",
        dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,BBBB",
        remoteUrl: "https://cdn.example.com/sheet.enc",
        encrypted: true,
        createdAt: "2024-06-01T00:00:00.000Z",
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    expect(result![0].remoteUrl).toBe("https://cdn.example.com/sheet.enc");
    expect(result![0].encrypted).toBe(true);
  });

  test("does not set encrypted:true when encrypted field is absent", () => {
    const raw = [
      {
        id: "r3",
        name: "doc.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        kind: "docx",
        remoteUrl: "https://cdn.example.com/doc.enc",
        createdAt: "2024-06-01T00:00:00.000Z",
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    expect(result![0].encrypted).toBeUndefined();
  });

  test("drops remote-first document with empty remoteUrl string", () => {
    const raw = [
      {
        id: "r4",
        name: "empty.pdf",
        kind: "pdf",
        remoteUrl: "   ",
        encrypted: true,
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toBeUndefined();
  });

  test("handles mixed legacy and remote-first in same array", () => {
    const raw = [
      {
        id: "legacy",
        name: "local.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        dataUrl: "data:application/pdf;base64,CCCC",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "remote",
        name: "remote.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        remoteUrl: "https://cdn.example.com/remote.enc",
        encrypted: true,
        createdAt: "2024-06-01T00:00:00.000Z",
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(2);
    const [legacy, remote] = result!;
    expect(legacy.dataUrl).toBe("data:application/pdf;base64,CCCC");
    expect(legacy.remoteUrl).toBeUndefined();
    expect(remote.dataUrl).toBe("");
    expect(remote.remoteUrl).toBe("https://cdn.example.com/remote.enc");
    expect(remote.encrypted).toBe(true);
  });
});

describe("normalizeDocumentList – edge cases", () => {
  test("returns undefined for non-array input", () => {
    expect(normalizeDocumentList(null)).toBeUndefined();
    expect(normalizeDocumentList({})).toBeUndefined();
    expect(normalizeDocumentList("string")).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(normalizeDocumentList([])).toBeUndefined();
  });

  test("assigns generated id when id field missing", () => {
    const raw = [
      {
        name: "noid.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        remoteUrl: "https://cdn.example.com/noid.enc",
        encrypted: true,
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    expect(typeof result![0].id).toBe("string");
    expect(result![0].id.length).toBeGreaterThan(0);
  });

  test("infers kind from mimeType when kind field missing", () => {
    const raw = [
      {
        id: "infer",
        name: "infer.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        remoteUrl: "https://cdn.example.com/infer.enc",
        encrypted: true,
      },
    ];
    const result = normalizeDocumentList(raw);
    expect(result).toHaveLength(1);
    expect(result![0].kind).toBe("xlsx");
  });
});
