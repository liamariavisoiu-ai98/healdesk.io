import { describe, expect, it } from "vitest";

import {
  exportTarget,
  putObjectInput,
  storeBundle,
  type PutObjectSender,
} from "@/lib/patient-rights/export-store";

const CLINIC = "0b5f3c1e-7a2d-4c8e-9f10-123456789abc";
const BUCKET = "healdesk-production-exports-865780386982";
const KEY = `clinic-${CLINIC}-20261012T101500Z.json`;

describe("the export bucket target", () => {
  it("takes clinic-<the clinic's id>-<UTC time>.json in a bucket", () => {
    expect(exportTarget(CLINIC, BUCKET, KEY)).toEqual({ bucket: BUCKET, key: KEY });
    expect(exportTarget(CLINIC.toUpperCase(), BUCKET, KEY)).toEqual({ bucket: BUCKET, key: KEY });
  });

  it("refuses a key naming another clinic, or anything but the clinic and a time", () => {
    const other = "1c5f3c1e-7a2d-4c8e-9f10-123456789abc";
    expect(() => exportTarget(other, BUCKET, KEY)).toThrow(/another clinic/);
    for (const key of [
      "",
      `clinic-${CLINIC}.json`,
      `clinic-${CLINIC}-20261012T101500Z.json.gz`,
      `patient-${CLINIC}-20261012T101500Z.json`,
      `clinic-${CLINIC}-+15551234567.json`,
      `../clinic-${CLINIC}-20261012T101500Z.json`,
      `exports/clinic-${CLINIC}-20261012T101500Z.json`,
    ]) {
      expect(() => exportTarget(CLINIC, BUCKET, key), key).toThrow(/HEALDESK_EXPORT_KEY/);
    }
  });

  it("refuses something that is not a bucket name", () => {
    expect(() => exportTarget(CLINIC, "s3://bucket", KEY)).toThrow(/bucket name/);
    expect(() => exportTarget(CLINIC, "", KEY)).toThrow(/bucket name/);
  });
});

describe("the upload", () => {
  it("names our key's encryption and never overwrites", () => {
    expect(putObjectInput({ bucket: BUCKET, key: KEY }, "{}")).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      Body: "{}",
      ContentType: "application/json",
      ServerSideEncryption: "aws:kms",
      IfNoneMatch: "*",
    });
  });

  it("sends exactly one PutObject with that input", async () => {
    const sent: unknown[] = [];
    const client: PutObjectSender = {
      send: async (command) => {
        sent.push(command);
        return {};
      },
    };
    await storeBundle({ bucket: BUCKET, key: KEY }, '{"contacts":[]}', client);
    expect(sent).toHaveLength(1);
    const command = sent[0] as { constructor: { name: string }; input: unknown };
    expect(command.constructor.name).toBe("PutObjectCommand");
    expect(command.input).toEqual(putObjectInput({ bucket: BUCKET, key: KEY }, '{"contacts":[]}'));
  });

  it("lets a refused upload fail the run", async () => {
    const client: PutObjectSender = {
      send: async () => {
        throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
          name: "PreconditionFailed",
        });
      },
    };
    await expect(storeBundle({ bucket: BUCKET, key: KEY }, "{}", client)).rejects.toThrow(/pre-conditions/);
  });
});
