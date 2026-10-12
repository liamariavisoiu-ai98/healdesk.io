/**
 * Where a clinic's return bundle lands on the AWS host: one object in the
 * export bucket (infra/aws/exports.tf), because a Fargate task's disk goes
 * with the task. Only scripts/patient-export.ts uses this, as the one-off
 * patient-export task; nothing in the web tier or the worker writes there,
 * and their task role cannot.
 *
 * The key names the clinic and a time, never a patient, and the run passes
 * it in (infra/aws/scripts/run-task.sh), so the operator knows where the
 * bundle went without reading the task's log. The upload names the bucket's
 * own encryption (the bucket refuses any other) and refuses to overwrite an
 * object already there, so a re-run under the same key fails instead of
 * replacing a bundle someone may be downloading.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXPORT_KEY = new RegExp(`^clinic-(${UUID})-(\\d{8}T\\d{6}Z)\\.json$`, "i");
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type ExportTarget = { bucket: string; key: string };

/** The parts of the S3 client this module uses, so a test can pass a fake. */
export type PutObjectSender = {
  send(command: unknown): Promise<unknown>;
};

export type PutObjectInput = {
  Bucket: string;
  Key: string;
  Body: string;
  ContentType: string;
  ServerSideEncryption: "aws:kms";
  IfNoneMatch: "*";
};

/**
 * The bucket and key a run asked for, checked: the key must be
 * clinic-<the clinic's id>-<UTC time>.json, so it can never carry anything
 * but the clinic it exports.
 */
export function exportTarget(clinicId: string, bucket: string, key: string): ExportTarget {
  if (!BUCKET.test(bucket)) throw new Error("HEALDESK_EXPORT_BUCKET is not a bucket name.");
  const match = EXPORT_KEY.exec(key);
  if (!match) {
    throw new Error("HEALDESK_EXPORT_KEY must be clinic-<clinic id>-<YYYYMMDDTHHMMSSZ>.json.");
  }
  if (match[1]!.toLowerCase() !== clinicId.toLowerCase()) {
    throw new Error("HEALDESK_EXPORT_KEY names another clinic than the one exported.");
  }
  return { bucket, key };
}

/** The PutObject request for a bundle: our key's encryption, never an overwrite. */
export function putObjectInput(target: ExportTarget, body: string): PutObjectInput {
  return {
    Bucket: target.bucket,
    Key: target.key,
    Body: body,
    ContentType: "application/json",
    ServerSideEncryption: "aws:kms",
    IfNoneMatch: "*",
  };
}

/**
 * Upload the bundle. The SDK is loaded here, by a literal specifier, so
 * nothing else in apps/app pays for it.
 */
export async function storeBundle(
  target: ExportTarget,
  body: string,
  client?: PutObjectSender,
): Promise<void> {
  const s3 = await import("@aws-sdk/client-s3");
  const sender: PutObjectSender = client ?? new s3.S3Client({});
  await sender.send(new s3.PutObjectCommand(putObjectInput(target, body)));
}
