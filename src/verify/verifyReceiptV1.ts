// Raven Receipt v1 — open verification library (SPEC §8).
//
// Byte-for-byte port of `apps/launchguard-acp/src/receipt/verifyReceiptV1.ts`, with
// imports rewired to this package's local canonicalJson + constants. It depends on
// NOTHING proprietary and NOTHING networked: only `node:crypto`. The closed signer
// GENERATES receipts; this library VERIFIES them.
//
// Result contract (matches the production verifier):
//   { valid, stale, reasons, keyTrusted? }
// `valid` is gated ONLY by checks 1–5 (shape, disclaimer, forbidden words, payload
// hash + receiptId, signature). Key trust (6) and freshness (7) are reported but
// NON-FATAL — a self-consistent signature from an untrusted key is still a valid
// signature, and a stale receipt is still an authentic one.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { canonicalJson } from "./canonicalJson.ts";
import {
  RECEIPT_DOMAIN,
  RECEIPT_VERSION,
  RECEIPT_ID_PREFIX,
  RECEIPT_DISCLAIMER,
  RECEIPT_BODY_FIELDS,
  RECEIPT_FIELDS,
  collectStrings,
  findForbiddenWords,
  type ReceiptV1Body,
} from "./receiptV1.ts";

const PUBLIC_KEY_CACHE_MAX = 64;
const publicKeyCache = new Map<string, ReturnType<typeof createPublicKey>>();

const cachePublicKey = (
  signerPublicKey: string,
  publicKey: ReturnType<typeof createPublicKey>,
): void => {
  if (publicKeyCache.size >= PUBLIC_KEY_CACHE_MAX) {
    const oldest = publicKeyCache.keys().next().value;
    if (oldest !== undefined) publicKeyCache.delete(oldest);
  }
  publicKeyCache.set(signerPublicKey, publicKey);
};

export interface VerifyReceiptOptions {
  /** "Now" for freshness; ISO string or Date. Defaults to the current time. */
  now?: string | Date;
  /**
   * Trusted signer public keys (base64 SPKI DER). When provided, key trust is
   * reported via `keyTrusted`. Trust is NON-FATAL — it never gates `valid`.
   */
  trustedKeys?: ReadonlySet<string>;
}

export interface VerifyReceiptResult {
  valid: boolean;
  stale: boolean;
  reasons: string[];
  /** Present only when `trustedKeys` was supplied. */
  keyTrusted?: boolean;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isFindingArray = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every(
    (f) =>
      f !== null &&
      typeof f === "object" &&
      typeof (f as Record<string, unknown>).code === "string" &&
      typeof (f as Record<string, unknown>).source === "string",
  );

const isInterpretationArray = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every(
    (i) =>
      i !== null &&
      typeof i === "object" &&
      typeof (i as Record<string, unknown>).code === "string" &&
      typeof (i as Record<string, unknown>).text === "string" &&
      typeof (i as Record<string, unknown>).lang === "string",
  );

// Step 1 (SPEC §8): exact §4 field set with correct types. Returns shape problems.
const checkShape = (receipt: Record<string, unknown>): string[] => {
  const reasons: string[] = [];
  const keys = Object.keys(receipt);
  const expected = new Set<string>(RECEIPT_FIELDS);
  for (const k of keys) {
    if (!expected.has(k)) reasons.push(`shape_unexpected_field:${k}`);
  }
  for (const f of RECEIPT_FIELDS) {
    if (!(f in receipt)) reasons.push(`shape_missing_field:${f}`);
  }
  if (reasons.length > 0) return reasons;

  const r = receipt;
  const str = (k: string): void => {
    if (typeof r[k] !== "string") reasons.push(`shape_type:${k}`);
  };
  str("chain");
  str("mintAddress");
  str("tokenProgramAddress");
  if (!Number.isInteger(r.slot)) reasons.push("shape_type:slot");
  str("timestamp");
  str("rulesVersion");
  str("findingTaxonomyVersion");
  if (!isStringArray(r.scopeChecksPerformed)) reasons.push("shape_type:scopeChecksPerformed");
  if (!isStringArray(r.scopeChecksNotPerformed)) reasons.push("shape_type:scopeChecksNotPerformed");
  if (!isStringArray(r.coverageGaps)) reasons.push("shape_type:coverageGaps");
  if (!isFindingArray(r.findings)) reasons.push("shape_type:findings");
  if (!isInterpretationArray(r.interpretations)) reasons.push("shape_type:interpretations");
  if (!Number.isInteger(r.maxAgeSeconds)) reasons.push("shape_type:maxAgeSeconds");
  str("disclaimer");
  str("payloadHash");
  str("receiptId");
  str("signature");
  str("signerPublicKey");
  return reasons;
};

/** Extract the 14 signed-preimage body fields from a full receipt. */
const extractBody = (receipt: Record<string, unknown>): ReceiptV1Body => {
  const body = {} as Record<string, unknown>;
  for (const f of RECEIPT_BODY_FIELDS) body[f] = receipt[f];
  return body as unknown as ReceiptV1Body;
};

const recomputePayloadHash = (body: ReceiptV1Body): string =>
  "sha256:" + createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");

const toIso = (now: string | Date | undefined): string =>
  now === undefined ? new Date().toISOString() : typeof now === "string" ? now : now.toISOString();

/**
 * Verify a receipt v1 (SPEC §8). All of steps 1–5 must hold for `valid: true`.
 * Step 6 (key trust) and step 7 (freshness) are reported but NON-FATAL.
 *
 * Reasons are accumulated (not short-circuited) so a tampered receipt surfaces
 * every failed check — e.g. an altered disclaimer reports both the disclaimer
 * mismatch and the resulting payload-hash mismatch.
 */
export const verifyReceiptV1 = (
  receipt: unknown,
  opts: VerifyReceiptOptions = {},
): VerifyReceiptResult => {
  const reasons: string[] = [];

  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, stale: false, reasons: ["shape_not_an_object"] };
  }
  const r = receipt as Record<string, unknown>;

  // 1. Shape. If the shape is wrong we cannot trust any other check.
  const shapeReasons = checkShape(r);
  if (shapeReasons.length > 0) {
    return { valid: false, stale: false, reasons: shapeReasons };
  }

  // 2. Disclaimer byte-for-byte (SPEC §5).
  if (r.disclaimer !== RECEIPT_DISCLAIMER) reasons.push("disclaimer_mismatch");

  // 3+4. Forbidden words (SPEC §6) + payload hash. Both walks recurse through
  // attacker-shaped structures (findings[].evidence may nest arbitrarily), so
  // any failure there — e.g. stack exhaustion from hostile nesting — is
  // CONTAINED as an invalid-receipt reason. Hostile input must produce an
  // outcome, never an exception.
  const body = extractBody(r);
  let recomputed: string | null = null;
  try {
    const forbidden = findForbiddenWords(collectStrings(body));
    for (const w of forbidden) reasons.push(`forbidden_word:${w}`);
    recomputed = recomputePayloadHash(body);
  } catch {
    reasons.push("canonicalization_failed");
  }
  if (recomputed !== null && recomputed !== r.payloadHash) {
    reasons.push("payload_hash_mismatch");
  }

  // 4b. receiptId = "raven-receipt-v1:" + payloadHash.
  if (r.receiptId !== RECEIPT_ID_PREFIX + (r.payloadHash as string)) {
    reasons.push("receipt_id_mismatch");
  }

  // 5. Signature over the domain-separated envelope (SPEC §3/§8).
  const signedBytes = canonicalJson({
    domain: RECEIPT_DOMAIN,
    version: RECEIPT_VERSION,
    payloadHash: r.payloadHash,
  });
  let signatureOk = false;
  try {
    const signerPublicKey = r.signerPublicKey as string;
    let pub = publicKeyCache.get(signerPublicKey);
    if (!pub) {
      pub = createPublicKey({
        key: Buffer.from(signerPublicKey, "base64"),
        format: "der",
        type: "spki",
      });
      cachePublicKey(signerPublicKey, pub);
    }
    if (pub.asymmetricKeyType !== "ed25519") {
      throw new Error("signer key must be Ed25519");
    }
    signatureOk = cryptoVerify(
      null,
      Buffer.from(signedBytes, "utf8"),
      pub,
      Buffer.from(r.signature as string, "base64"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) reasons.push("signature_invalid");

  // valid is gated ONLY by steps 1–5.
  const valid = reasons.length === 0;

  // 6. Key trust (optional, NON-FATAL). Reported separately from `valid`.
  let keyTrusted: boolean | undefined;
  if (opts.trustedKeys) {
    keyTrusted = opts.trustedKeys.has(r.signerPublicKey as string);
    if (!keyTrusted) reasons.push("key_untrusted");
  }

  // 7. Freshness (reported, NON-FATAL — SPEC §7). Staleness ≠ tampered. An
  // unparseable timestamp makes freshness UNPROVABLE — fail closed and report
  // stale with a dedicated reason, never fresh-forever.
  const ageSeconds =
    (Date.parse(toIso(opts.now)) - Date.parse(r.timestamp as string)) / 1000;
  let stale: boolean;
  if (Number.isFinite(ageSeconds)) {
    stale = ageSeconds > (r.maxAgeSeconds as number);
    if (stale) reasons.push("stale");
  } else {
    stale = true;
    reasons.push("timestamp_unparseable");
  }

  return { valid, stale, reasons, ...(keyTrusted === undefined ? {} : { keyTrusted }) };
};
