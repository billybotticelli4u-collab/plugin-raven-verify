// Raven Receipt v1 — verify-only constants, types, and the forbidden-word check.
//
// This is the VERIFY subset of the producer's `receiptV1.ts`. It deliberately omits
// everything on the production side: no signer, no scanner, no scope-derivation, no
// interpretation layer, no `produceReceiptV1`. Producing evidence is the metered
// service; verifying it is free and permissionless (Constitution #4), so only the
// verify half lives in this open package.

// ---------------------------------------------------------------------------
// Domain / identity constants (SPEC §2, §3)
// ---------------------------------------------------------------------------

/** Signature domain — NEVER "raven-official-attestation" (that is the v2 path). */
export const RECEIPT_DOMAIN = "raven-receipt" as const;
/** Signature version — NEVER "v2". */
export const RECEIPT_VERSION = "v1" as const;
/** receiptId prefix (SPEC §3/§4). */
export const RECEIPT_ID_PREFIX = "raven-receipt-v1:" as const;

/**
 * The mandatory disclaimer (SPEC §5). MUST be byte-for-byte exact. Verifiers reject
 * any receipt whose disclaimer differs by even one character. Note it contains the
 * word "safety", which must NOT trip the "safe" forbidden-word rule (see below).
 */
export const RECEIPT_DISCLAIMER =
  "This attestation reports on-chain state within the defined scope at the stated slot. It is not a prediction, recommendation, or declaration of safety." as const;

// ---------------------------------------------------------------------------
// Forbidden words (SPEC §6) — deterministic, fail-closed
// ---------------------------------------------------------------------------

/** Raven never renders a verdict. These words must never appear in a signed field. */
export const FORBIDDEN_WORDS = [
  "safe",
  "unsafe",
  "legit",
  "scam-free",
  "approved",
  "guaranteed",
] as const;

// Whole-word, case-insensitive. Whole-word boundaries are ESSENTIAL: the mandatory
// disclaimer contains "safety", which must not match the "safe" rule.
const FORBIDDEN_RE = new RegExp(
  "\\b(?:" +
    FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\b",
  "gi",
);

/** Recursively collect every string value inside a JSON-like value. */
export const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const el of value) collectStrings(el, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
};

/** Return the unique, lower-cased forbidden words present across `strings`. */
export const findForbiddenWords = (strings: readonly string[]): string[] => {
  const hits = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(FORBIDDEN_RE)) {
      hits.add(m[0].toLowerCase());
    }
  }
  return [...hits].sort();
};

// ---------------------------------------------------------------------------
// Field sets (SPEC §4)
// ---------------------------------------------------------------------------

/** The 14 signed-preimage body fields, in documented form. */
export const RECEIPT_BODY_FIELDS = [
  "chain",
  "mintAddress",
  "tokenProgramAddress",
  "slot",
  "timestamp",
  "rulesVersion",
  "findingTaxonomyVersion",
  "scopeChecksPerformed",
  "scopeChecksNotPerformed",
  "coverageGaps",
  "findings",
  "interpretations",
  "maxAgeSeconds",
  "disclaimer",
] as const;

/** The full receipt field set (body + hash/id + signature pair) — 18 fields. */
export const RECEIPT_FIELDS = [
  ...RECEIPT_BODY_FIELDS,
  "payloadHash",
  "receiptId",
  "signature",
  "signerPublicKey",
] as const;

// ---------------------------------------------------------------------------
// Types (SPEC §4)
// ---------------------------------------------------------------------------

export interface ReceiptFinding {
  code: string;
  source: string;
  subject?: string;
  evidence?: Record<string, unknown>;
}

export interface ReceiptInterpretation {
  code: string;
  text: string;
  lang: string;
}

/** The 14 signed-preimage fields. */
export interface ReceiptV1Body {
  chain: string;
  mintAddress: string;
  tokenProgramAddress: string;
  slot: number;
  timestamp: string;
  rulesVersion: string;
  findingTaxonomyVersion: string;
  scopeChecksPerformed: string[];
  scopeChecksNotPerformed: string[];
  coverageGaps: string[];
  findings: ReceiptFinding[];
  interpretations: ReceiptInterpretation[];
  maxAgeSeconds: number;
  disclaimer: string;
}

/** Full receipt v1 = body + hash/id + signature pair. */
export interface ReceiptV1 extends ReceiptV1Body {
  payloadHash: string;
  receiptId: string;
  signature: string;
  signerPublicKey: string;
}
