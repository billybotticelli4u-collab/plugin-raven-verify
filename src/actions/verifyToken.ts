import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
} from '@elizaos/core';

import { verifyReceiptV1 } from '../verify/verifyReceiptV1.ts';

const DEFAULT_VERIFIER_URL = 'https://raven-hosted-verifier.onrender.com';

// Solana base58 addresses are 32–44 chars from the base58 alphabet (no 0OIl).
const BASE58_TOKEN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Pull the most likely mint address (longest base58 token) out of free text. */
export function extractMint(text: string | undefined | null): string | null {
  if (!text) return null;
  const matches = text.match(BASE58_TOKEN);
  if (!matches) return null;
  const candidates = matches.filter((m) => m.length >= 32 && m.length <= 44);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/** HTTP statuses that mean "try again later", not "no". */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Hard ceiling for any single outbound call. A hung verifier (cold starts,
 * network partitions) must never hang the action forever. Overridable via
 * RAVEN_FETCH_TIMEOUT_MS for operators with slower links.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const fetchTimeoutMs = (runtime: IAgentRuntime): number => {
  const raw = Number(runtime.getSetting('RAVEN_FETCH_TIMEOUT_MS'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
};

/**
 * Trusted signer keys for LOCAL verification.
 *
 * CASE A: valid RAVEN_TRUSTED_KEYS → use ONLY those independently obtained pins.
 * CASE B: absent / empty → return empty set (NO /pubkey trust bootstrap).
 * CASE C: malformed pin config (non-string, or present-but-zero-keys) → empty set.
 *
 * `/pubkey` must NEVER populate the trusted set. Discovery/cross-check is out of
 * scope for trust elevation; the action already fails closed when
 * keyTrusted !== true.
 *
 * Ancestry: based on PR #10 head (canonical Base64 / total trustedKeys); this
 * change adds the fail-closed bootstrap that #10 explicitly deferred.
 */
export async function loadTrustedKeys(
  runtime: IAgentRuntime,
  _verifierUrl: string,
  _fetchImpl: typeof fetch = fetch,
): Promise<ReadonlySet<string>> {
  const pinned = runtime.getSetting('RAVEN_TRUSTED_KEYS');
  if (pinned === undefined || pinned === null) {
    return new Set();
  }
  if (typeof pinned !== 'string') {
    // CASE C: malformed pin config — fail closed (empty ⇒ keyTrusted false).
    return new Set();
  }
  const trimmed = pinned.trim();
  if (trimmed.length === 0) {
    // CASE B: unset-equivalent whitespace — no discovery bootstrap.
    return new Set();
  }
  const keys = new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  // CASE C: present but yields zero pins (e.g. ",,,") — fail closed.
  return keys;
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export const verifyTokenAction: Action = {
  name: 'VERIFY_TOKEN',
  similes: ['CHECK_TOKEN', 'VERIFY_MINT', 'RAVEN_VERIFY', 'TOKEN_EVIDENCE', 'TOKEN_RECEIPT'],
  description:
    'Fetch a signed Raven receipt (receipt-v1) of on-chain evidence for a Solana token ' +
    'mint and VERIFY IT LOCALLY against caller-supplied trusted keys before reporting. Reports ' +
    'the checks performed, the checks NOT performed, coverage gaps, the observed ' +
    'slot/timestamp, freshness, and local verification status. Does NOT give a ' +
    'safe/unsafe verdict, trading advice, or a price prediction; reports locally ' +
    'verified, observed on-chain state only — the agent applies its own policy.',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!runtime.getSetting('RAVEN_API_KEY')) {
      logger.warn('[plugin-raven-verify] RAVEN_API_KEY not set; VERIFY_TOKEN disabled.');
      return false;
    }
    return Boolean(extractMint(message?.content?.text));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // Deterministic-test hooks (fetchImpl/now); production uses global fetch + wall clock.
    const hooks = (options ?? {}) as { fetchImpl?: typeof fetch; now?: string };
    const apiKey = runtime.getSetting('RAVEN_API_KEY') as string;
    const verifierUrl =
      (runtime.getSetting('RAVEN_VERIFIER_URL') as string | undefined) || DEFAULT_VERIFIER_URL;
    const fetchImpl = hooks.fetchImpl ?? fetch;

    const fail = async (text: string, data?: Record<string, unknown>): Promise<ActionResult> => {
      if (callback) await callback({ text, actions: ['VERIFY_TOKEN'] });
      return { text, success: false, ...(data ? { data } : {}) };
    };

    const mint = extractMint(message?.content?.text);
    if (!mint) {
      return fail('No Solana mint address found. Provide a base58 mint to fetch a Raven receipt.');
    }

    // 1. Request the receipt. The receipt itself carries the resolved token
    //    program as a SIGNED field, so no client-side RPC lookup is needed.
    let receipt: Record<string, unknown>;
    try {
      const res = await fetchImpl(`${verifierUrl.replace(/\/+$/, '')}/receipt/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ mintAddress: mint }),
        signal: AbortSignal.timeout(fetchTimeoutMs(runtime)),
      });
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        if (TRANSIENT_STATUSES.has(res.status)) {
          return fail(
            `Raven is temporarily unavailable (HTTP ${res.status}); no receipt produced — retry later` +
              (retryAfter ? ` (suggested wait ~${retryAfter}s).` : '.'),
            { status: res.status, transient: true },
          );
        }
        return fail(`Raven returned HTTP ${res.status}; no receipt produced (fail-closed).`, {
          status: res.status,
        });
      }
      receipt = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      logger.error(
        '[plugin-raven-verify] receipt request failed',
        err instanceof Error ? err.message : String(err),
      );
      return fail('Raven request failed; no receipt produced — retry later.', { transient: true });
    }

    // 2. VERIFY LOCALLY — the agent never trusts transport. Shape, disclaimer,
    //    forbidden words, payload hash, receiptId, ed25519 signature; key trust
    //    and freshness reported independently.
    const trustedKeys = await loadTrustedKeys(runtime, verifierUrl, fetchImpl);
    const verification = verifyReceiptV1(receipt, { now: hooks.now, trustedKeys });
    if (!verification.valid) {
      return fail(
        `Raven receipt FAILED local verification (${verification.reasons.join(', ')}); ` +
          'not usable evidence (fail-closed).',
        { verification },
      );
    }
    if (verification.keyTrusted !== true) {
      return fail(
        'Raven receipt signer is not in the trusted key set; not usable evidence (fail-closed).',
        { verification },
      );
    }

    // 2b. BIND the receipt to the request. A valid signature proves the
    //     receipt is authentic Raven evidence — it does NOT prove it is
    //     evidence about THIS mint. Without this check, a valid receipt for
    //     token A could be presented as evidence for token B. `mintAddress`
    //     is inside the signed payload, so comparing after local
    //     verification is sound (fail-closed).
    if (receipt.mintAddress !== mint) {
      return fail(
        `Raven receipt is bound to a different mint (${String(receipt.mintAddress)}) than requested (${mint}); ` +
          'not usable evidence (fail-closed).',
        { verification, receiptMintAddress: receipt.mintAddress },
      );
    }

    // 3. Report facts only. What was NOT checked gets the same standing as findings.
    const findings = Array.isArray(receipt.findings)
      ? (receipt.findings as Array<{ code?: unknown }>)
          .map((f) => f?.code)
          .filter((c): c is string => typeof c === 'string')
      : [];
    const notChecked = [
      ...new Set([...strArray(receipt.scopeChecksNotPerformed), ...strArray(receipt.coverageGaps)]),
    ];
    const keyLine = 'signature verified locally against a pinned trusted key';

    const text = [
      `Raven receipt — ${mint}`,
      `Local verification: ${keyLine}.` + (verification.stale ? ' STALE — older than its freshness budget; request a fresh receipt before relying on it.' : ''),
      `Observed at slot ${receipt.slot} (${receipt.timestamp}); token program ${receipt.tokenProgramAddress}.`,
      `Findings: ${findings.length ? findings.join(', ') : 'none within the performed scope'}`,
      `NOT checked (unknown, not clear): ${notChecked.length ? notChecked.join(', ') : 'nothing — all catalogued checks ran'}`,
      `Receipt: ${receipt.receiptId}`,
      String(receipt.disclaimer ?? ''),
    ]
      .filter(Boolean)
      .join('\n');

    if (callback) await callback({ text, actions: ['VERIFY_TOKEN'] });
    return { text, success: true, data: { receipt, verification } };
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Before I touch this, get a Raven receipt for 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
        },
      },
      {
        name: '{{name2}}',
        content: { text: 'Fetching a signed Raven receipt and verifying it locally…', actions: ['VERIFY_TOKEN'] },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'verify token So11111111111111111111111111111111111111112' },
      },
      {
        name: '{{name2}}',
        content: { text: 'Pulling the on-chain evidence receipt…', actions: ['VERIFY_TOKEN'] },
      },
    ],
  ],
};
