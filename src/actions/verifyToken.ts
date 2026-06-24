import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
} from '@elizaos/core';

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

/**
 * Resolve the owning token program (SPL Token or Token-2022) for a mint via
 * getAccountInfo. Raven needs the token program; we resolve it rather than
 * assume it. Returns null on any failure (the action then declines — never guesses).
 */
export async function resolveTokenProgram(
  rpcUrl: string,
  mint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'base64', commitment: 'finalized' }],
      }),
    });
    const json: any = await res.json();
    const owner = json?.result?.value?.owner;
    return typeof owner === 'string' && owner.length >= 32 ? owner : null;
  } catch {
    return null;
  }
}

export const verifyTokenAction: Action = {
  name: 'VERIFY_TOKEN',
  similes: ['CHECK_TOKEN', 'VERIFY_MINT', 'RAVEN_VERIFY', 'TOKEN_EVIDENCE', 'TOKEN_RECEIPT'],
  description:
    'Fetch a signed, scope-bounded Raven receipt of on-chain evidence for a Solana token mint before a token-touching action. Reports the checks performed, the checks NOT performed, coverage gaps, the observed slot, and an ed25519 signature. Does NOT give a safe/unsafe verdict, trading advice, or a price prediction; reports observed on-chain state only.',

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
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const apiKey = runtime.getSetting('RAVEN_API_KEY') as string;
    const rpcUrl = runtime.getSetting('SOLANA_RPC_URL') as string | undefined;
    const verifierUrl =
      (runtime.getSetting('RAVEN_VERIFIER_URL') as string | undefined) || DEFAULT_VERIFIER_URL;

    const fail = async (
      text: string,
      data?: Record<string, unknown>,
    ): Promise<ActionResult> => {
      if (callback) await callback({ text, actions: ['VERIFY_TOKEN'] });
      return { text, success: false, ...(data ? { data } : {}) };
    };

    const mint = extractMint(message?.content?.text);
    if (!mint) {
      return fail('No Solana mint address found. Provide a base58 mint to fetch a Raven receipt.');
    }
    if (!rpcUrl) {
      return fail('SOLANA_RPC_URL is not configured; it is required to resolve the token program for a mint.');
    }

    const tokenProgram = await resolveTokenProgram(rpcUrl, mint);
    if (!tokenProgram) {
      return fail(
        `Could not resolve the token program for ${mint} (mint not found or RPC unavailable). Raven returns no receipt rather than guessing.`,
      );
    }

    let body: any;
    try {
      const res = await fetch(`${verifierUrl.replace(/\/+$/, '')}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          mintAddress: mint,
          tokenProgramAddress: tokenProgram,
          commitment: 'finalized',
        }),
      });
      if (!res.ok) {
        return fail(
          `Raven verifier returned HTTP ${res.status}; no receipt produced (fail-closed).`,
          { status: res.status },
        );
      }
      body = await res.json();
    } catch (err) {
      logger.error(
        '[plugin-raven-verify] verify request failed',
        err instanceof Error ? err.message : String(err),
      );
      return fail('Raven verifier request failed; no receipt produced.');
    }

    // Honest, scope-bounded summary. Raven reports EVIDENCE, never a safe/unsafe call.
    const verdict: string = body?.verdict ?? 'unknowable';
    const reason: string = body?.reason ?? '';
    const findingCodes: string[] = Array.isArray(body?.findingCodes) ? body.findingCodes : [];
    const coverageGaps: string[] = Array.isArray(body?.coverageGaps) ? body.coverageGaps : [];
    const keyId: string = body?.keyId ?? '';
    const replayHash: string = body?.replayHash ?? '';
    const slot = body?.rpc?.observedSlot ?? null;

    const text = [
      `Raven receipt — ${mint}`,
      `Outcome (scope-bounded, not a safety verdict): ${verdict}${reason ? ` (${reason})` : ''}`,
      `Checks that fired: ${findingCodes.length ? findingCodes.join(', ') : 'none'}`,
      `NOT evaluated / coverage gaps: ${coverageGaps.length ? coverageGaps.join(', ') : 'none reported'}`,
      slot != null ? `Observed slot: ${slot}` : '',
      `Signed: keyId ${keyId}; replayHash ${replayHash} — verify against ${verifierUrl}/pubkey.`,
      'This reports observed on-chain state within a stated scope at the stated slot. It is not a prediction, recommendation, or declaration of safety — apply your own policy.',
    ]
      .filter(Boolean)
      .join('\n');

    if (callback) await callback({ text, actions: ['VERIFY_TOKEN'] });
    return { text, success: true, data: body };
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
        content: { text: 'Fetching a signed Raven receipt for that mint…', actions: ['VERIFY_TOKEN'] },
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
