// Canonical JSON — the ONE hashing discipline for Raven receipts.
//
// This is a byte-for-byte port of `canonicalJsonStringify` from the producer app
// (`apps/launchguard-acp/src/acp/attestation.ts`). It is duplicated here on purpose:
// this package is the OPEN, dependency-free trust kernel and must not import from the
// app. Both copies are pinned to the same golden vectors, so any divergence is a test
// failure, not a silent fork.
//
// Rules (RAVEN_RECEIPT_V1_SPEC §"canonical JSON"):
//   1. Object keys sorted, recursively.
//   2. No insignificant whitespace; UTF-8 bytes are what gets hashed/signed.
//   3. Arrays preserve order (producers emit deterministic order).
//   4. No floating-point / non-finite numbers; no bigint.
//   5. `undefined` object properties are omitted (as standard JSON does).
//
// CROSS-LANGUAGE INVARIANT (important for future Rust/Go/Python verifiers):
// key sorting here uses JavaScript's default `Array.prototype.sort()`, i.e. ordering
// by UTF-16 code unit. Receipt object KEYS are a fixed set of ASCII field names
// (see RECEIPT_FIELDS), so UTF-8-byte order, Unicode code-point order, and UTF-16
// code-unit order all coincide. A verifier in another language may therefore use its
// native string sort and stay conformant FOR THIS SCHEMA. Do not introduce non-ASCII
// object keys without revisiting this.

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** Deterministic, whitespace-free JSON with recursively sorted object keys. */
export const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();

  const enc = (v: unknown): string => {
    if (v === null) return "null";

    const t = typeof v;
    if (t === "string") return JSON.stringify(v);
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") {
      if (!Number.isFinite(v as number)) {
        throw new CanonicalJsonError("non-finite number is not canonicalizable");
      }
      return JSON.stringify(v);
    }
    if (t === "bigint") {
      throw new CanonicalJsonError("bigint is not canonicalizable");
    }
    if (t === "undefined" || t === "function" || t === "symbol") {
      throw new CanonicalJsonError(`unsupported value of type ${t}`);
    }

    if (Array.isArray(v)) {
      if (seen.has(v)) throw new CanonicalJsonError("cycle detected");
      seen.add(v);
      const body = v.map((el) => enc(el)).join(",");
      seen.delete(v);
      return "[" + body + "]";
    }

    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) throw new CanonicalJsonError("cycle detected");
    seen.add(obj);
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      if (val === undefined) continue; // omit undefined props, like JSON objects
      parts.push(JSON.stringify(key) + ":" + enc(val));
    }
    seen.delete(obj);
    return "{" + parts.join(",") + "}";
  };

  return enc(value);
};

/** Alias matching the producer-app name, for readers cross-referencing the source. */
export const canonicalJsonStringify = canonicalJson;
