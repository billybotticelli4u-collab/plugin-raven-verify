import type { Plugin } from '@elizaos/core';
import { verifyTokenAction } from './actions/verifyToken.ts';

export const ravenVerifyPlugin: Plugin = {
  name: 'raven-verify',
  description:
    'Pre-action Solana token verification via Raven: fetches signed, scope-bounded on-chain evidence receipts (receipt-v1) and VERIFIES THEM LOCALLY against caller-supplied trusted keys (checks performed, checks NOT performed, coverage gaps, observed slot, ed25519 signature) before a token-touching action. Reports locally verified evidence — never a safe/unsafe verdict or trading advice.',
  actions: [verifyTokenAction],
  providers: [],
  evaluators: [],
  services: [],
};

export { verifyTokenAction } from './actions/verifyToken.ts';
export default ravenVerifyPlugin;
