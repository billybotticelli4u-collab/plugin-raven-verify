import { logger } from '@elizaos/core';
import type { Action, ActionExample, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { verifyReceiptV1, type TrustedKeysResolver } from '../verify/verifyReceiptV1.ts';

const DEFAULT_VERIFIER_URL = 'https://raven-hosted-verifier.onrender.com';
const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Solana base58 mint candidates can appear anywhere in free text ("check CA ...").
// We pick the LONGEST candidate (CEX deposit addresses and mints are both base58;
// the longer string is more specific and typically the mint in mixed content).
export function extractMint(text: string): string | null {
  const candidates = text.match(MINT_RE) ?? [];
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

let pubkeyCache: { keys: ReadonlySet<string>; fetchedAt: number; verifierUrl: string } | null = null;
const PUBKEY_CACHE_TTL_MS = 10 * 60_000;

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

export async function loadTrustedKeys(
  runtime: IAgentRuntime,
  verifierUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlySet<string>> {
  const pinned = runtime.getSetting('RAVEN_TRUSTED_KEYS') as string | undefined;
  if (pinned && pinned.trim().length > 0) {
    return new Set(
      pinned
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
  // The cache is keyed BY VERIFIER URL: switching RAVEN_VERIFIER_URL at runtime
  // must not keep serving the previous host's key set.
  if (
    pubkeyCache &&
    pubkeyCache.verifierUrl === verifierUrl &&
    Date.now() - pubkeyCache.fetchedAt < PUBKEY_CACHE_TTL_MS
  ) {
    return pubkeyCache.keys;
  }
  try {
    const res = await fetchImpl(`${verifierUrl.replace(/\/+$/, '')}/pubkey`, {
      signal: AbortSignal.timeout(fetchTimeoutMs(runtime)),
    });
    if (!res.ok) return new Set();
    const body = (await res.json()) as { keys?: Array<{ publicKeyBase64?: unknown }> };
    const keys = new Set(
      (body?.keys ?? [])
        .map((k) => k?.publicKeyBase64)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    );
    if (keys.size > 0) pubkeyCache = { keys, fetchedAt: Date.now(), verifierUrl };
    return keys;
  } catch {
    return new Set();
  }
}

const RECEIPT_INSTRUCTIONS =
  'Present the receipt as evidence, not a verdict. Lead with what was checked, ' +
  'what was found, and what was NOT checked (coverage gaps). Never say or imply ' +
  'safe/unsafe/legit/approved/guaranteed; the receipt is signed on-chain state ' +
  'within a scope at a slot.';

export const verifyTokenAction: Action = {
  name: 'VERIFY_TOKEN_RAVEN',
  similes: ['CHECK_TOKEN', 'RAVEN_VERIFY', 'VERIFY_MINT', 'TOKEN_EVIDENCE'],
  description:
    'Fetches a signed, scope-bounded Raven receipt for a Solana token and presents it as evidence (never as a safe/unsafe verdict).',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const apiKey = runtime.getSetting('RAVEN_API_KEY');
    if (!apiKey) return false;
    const text = typeof message?.content?.text === 'string' ? message.content.text : '';
    return extractMint(text) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: { fetchImpl?: typeof fetch } | undefined,
    callback: HandlerCallback | undefined,
  ) => {
    const apiKey = runtime.getSetting('RAVEN_API_KEY') as string;
    const verifierUrl = ((runtime.getSetting('RAVEN_VERIFIER_URL') as string) || DEFAULT_VERIFIER_URL).replace(/\/+$/, '');
    const text = typeof message?.content?.text === 'string' ? message.content.text : '';
    const mint = extractMint(text);
    if (!mint) {
      callback?.({ text: 'No Solana mint address found in your message.' });
      return { success: false, error: 'no_mint_found' };
    }

    const fetchImpl = options?.fetchImpl ?? fetch;

    let receipt: unknown;
    try {
      const res = await fetchImpl(`${verifierUrl.replace(/\/+$/, '')}/receipt/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ mintAddress: mint }),
        signal: AbortSignal.timeout(fetchTimeoutMs(runtime)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.warn(`raven receipt request failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
        callback?.({
          text: `Raven's verifier returned HTTP ${res.status}. No receipt was issued — nothing was verified.`,
        });
        return { success: false, error: `http_${res.status}` };
      }
      receipt = await res.json();
    } catch (err) {
      logger.warn(`raven receipt request error: ${String(err)}`);
      callback?.({ text: 'Could not reach Raven\'s verifier. No receipt was issued — nothing was verified.' });
      return { success: false, error: 'network_error' };
    }

    // Verify LOCALLY — never trust transport. Key trust comes from pinned
    // RAVEN_TRUSTED_KEYS when set (strongest), else the verifier's published
    // /pubkey registry (TOFU, cached 10 min).
    const trustedKeys = await loadTrustedKeys(runtime, verifierUrl, fetchImpl);
    const resolveTrustedKeys: TrustedKeysResolver = async () => trustedKeys;
    const result = verifyReceiptV1(receipt, { resolveTrustedKeys });

    // Fail-closed on the mint-binding: the receipt must be about the mint that
    // was asked about. A receipt for a different mint is NOT evidence for this one.
    const receiptMint =
      receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? (receipt as Record<string, unknown>).mintAddress
        : undefined;
    if (receiptMint !== mint) {
      callback?.({
        text: `Raven returned a receipt for a different mint (${String(receiptMint)}), not ${mint}. Discarding it.`,
      });
      return { success: false, error: 'mint_mismatch' };
    }

    if (!result.valid) {
      callback?.({
        text: `Raven returned a receipt, but local verification FAILED (${result.reasons.join(', ')}). ` +
          'Treat it as no evidence at all. ' +
          RECEIPT_INSTRUCTIONS,
      });
      return { success: false, error: 'receipt_invalid', data: { reasons: result.reasons } };
    }

    const r = receipt as Record<string, unknown>;
    const lines: string[] = [];
    lines.push(`Raven receipt for ${mint} — verified locally (signature, payload hash, disclaimer, scope all check out).`);
    if (result.keyTrusted === true) lines.push('Signer key: trusted (matches Raven\'s published/pinned key).');
    else if (result.keyTrusted === false) lines.push('Signer key: NOT in the trusted set — treat with caution.');
    if (result.stale) lines.push('Note: the receipt is STALE (older than its own maxAgeSeconds).');
    lines.push(`Scope checked: ${(r.scopeChecksPerformed as string[]).join(', ') || 'none'}.`);
    lines.push(`NOT checked: ${(r.scopeChecksNotPerformed as string[]).join(', ') || 'none'}.`);
    lines.push(`Coverage gaps: ${(r.coverageGaps as string[]).join(', ') || 'none'}.`);
    const findings = r.findings as Array<{ code: string }>;
    lines.push(findings.length > 0 ? `Findings: ${findings.map((f) => f.code).join(', ')}.` : 'Findings: none within scope.');
    lines.push(RECEIPT_INSTRUCTIONS);

    callback?.({ text: lines.join('\n') });
    return {
      success: true,
      data: {
        receipt,
        verification: { valid: result.valid, stale: result.stale, keyTrusted: result.keyTrusted, reasons: result.reasons },
      },
    };
  },

  examples: [
    [
      { name: 'user', content: { text: 'Is EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v legit?' } },
      {
        name: 'agent',
        content: {
          text: 'I can fetch Raven\'s signed evidence for that mint. Note Raven reports what was checked and found — it does not declare tokens legit or safe.',
          actions: ['VERIFY_TOKEN_RAVEN'],
        },
      },
    ] as ActionExample[],
  ],
};
