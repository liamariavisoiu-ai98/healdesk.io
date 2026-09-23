import { generateKeyPairSync, createVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FakeSheets, columnIndex, columnLetter, mintServiceAccountJwt, parseA1, parseServiceAccount } from "./client";
import { fromCell, toCell } from "./schema";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const keyFile = JSON.stringify({
  type: "service_account",
  client_email: "healdesk-sheets@example.iam.gserviceaccount.com",
  private_key: pem,
  token_uri: "https://oauth2.googleapis.com/token",
});

describe("parseServiceAccount", () => {
  it("accepts the key file as JSON or as base64 of it, and nothing else", () => {
    const json = parseServiceAccount(keyFile);
    expect(json?.clientEmail).toBe("healdesk-sheets@example.iam.gserviceaccount.com");
    const b64 = parseServiceAccount(Buffer.from(keyFile).toString("base64"));
    expect(b64).toEqual(json);
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount("")).toBeNull();
    expect(parseServiceAccount("not json")).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: "x@y" }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: "x@y", private_key: "nope" }))).toBeNull();
  });
});

describe("mintServiceAccountJwt", () => {
  it("signs the Sheets scope for the token endpoint with RS256, one hour long", () => {
    const account = parseServiceAccount(keyFile)!;
    const now = Date.UTC(2026, 8, 23, 10, 0, 0);
    const jwt = mintServiceAccountJwt(account, now);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: account.clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .end()
      .verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(verified).toBe(true);
  });
});

describe("A1 notation", () => {
  it("round-trips column letters", () => {
    for (const [n, letters] of [[1, "A"], [26, "Z"], [27, "AA"], [33, "AG"], [52, "AZ"], [53, "BA"]] as const) {
      expect(columnLetter(n)).toBe(letters);
      expect(columnIndex(letters)).toBe(n);
    }
  });

  it("parses the shapes the store writes", () => {
    expect(parseA1("leads!A2:AG")).toEqual({ tab: "leads", startRow: 2, endRow: null, startCol: 1, endCol: 33 });
    expect(parseA1("leads!A5:AG5")).toEqual({ tab: "leads", startRow: 5, endRow: 5, startCol: 1, endCol: 33 });
    expect(parseA1("call_consents!H7")).toEqual({ tab: "call_consents", startRow: 7, endRow: 7, startCol: 8, endCol: 8 });
    expect(parseA1("counters!1:1")).toEqual({ tab: "counters", startRow: 1, endRow: 1, startCol: 1, endCol: null });
    expect(parseA1("'My Tab'!A:D")).toEqual({ tab: "My Tab", startRow: 1, endRow: null, startCol: 1, endCol: 4 });
    expect(parseA1("leads")).toEqual({ tab: "leads", startRow: 1, endRow: null, startCol: 1, endCol: null });
  });
});

describe("the cell codec", () => {
  it("writes ISO timestamps, TRUE/FALSE, numbers and blanks, and reads them back", () => {
    const at = new Date("2026-09-23T10:15:00.000Z");
    expect(toCell("timestamp", at)).toBe("2026-09-23T10:15:00.000Z");
    expect(toCell("timestamp", null)).toBe("");
    expect(toCell("bool", true)).toBe(true);
    expect(toCell("int", 7.9)).toBe(7);
    expect(toCell("json", { a: 1 })).toBe('{"a":1}');
    expect(fromCell("timestamp", "2026-09-23T10:15:00.000Z")).toEqual(at);
    // A date someone typed by hand in the UI comes back as a serial number.
    expect(fromCell("timestamp", 46288.5)).toEqual(new Date("2026-09-23T12:00:00.000Z"));
    expect(fromCell("timestamp", "")).toBeNull();
    expect(fromCell("bool", "TRUE")).toBe(true);
    expect(fromCell("bool", false)).toBe(false);
    expect(fromCell("bool", "")).toBeNull();
    expect(fromCell("int", "12")).toBe(12);
    expect(fromCell("int", "x")).toBeNull();
    expect(fromCell("json", '{"a":1}')).toEqual({ a: 1 });
    expect(fromCell("json", "[1]")).toBeNull();
  });
});

describe("FakeSheets", () => {
  it("behaves like the API at the edges the store relies on", async () => {
    const sheets = new FakeSheets();
    await expect(sheets.getValues("leads!A2:D")).rejects.toThrow(/400/);
    await sheets.batchUpdate([{ addSheet: { properties: { title: "leads" } } }]);
    await expect(sheets.batchUpdate([{ addSheet: { properties: { title: "leads" } } }])).rejects.toThrow(/400/);
    expect(await sheets.getValues("leads!A1:D")).toEqual([]);
    await sheets.updateRange("leads!A1:C1", [["a", "b", "c"]]);
    expect(await sheets.appendRows("leads", [["1", "", "x"], ["2", "y"]])).toEqual({ firstRow: 2 });
    // Trailing empties are trimmed per row and trailing empty rows dropped.
    expect(await sheets.getValues("leads!A2:C")).toEqual([["1", "", "x"], ["2", "y"]]);
    expect(await sheets.getValues("leads!B2:B")).toEqual([[], ["y"]]);
    const id = await sheets.getSheetId("leads");
    await sheets.batchUpdate([{ deleteDimension: { range: { sheetId: id!, dimension: "ROWS", startIndex: 1, endIndex: 2 } } }]);
    expect(sheets.records("leads")).toEqual([{ a: "2", b: "y", c: "" }]);
    expect(await sheets.getSheetId("nope")).toBeNull();
  });
});
