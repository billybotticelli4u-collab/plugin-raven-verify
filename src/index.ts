import type { Plugin } from '@elizaos/core';
import { verifyTokenAction } from './actions/verifyToken.js';

export const ravenVerifyPlugin: Plugin = {
  name: 'raven-verify',
  description:
    'Pre-action Solana token verification via Raven: fetches signed, scope-bounded on-chain evidence receipts (checks performed, checks NOT performed, coverage gaps, observed slot, ed25519 signature) before a token-touching action. Reports evidence the agent can independently re-derive and verify — never a safe/unsafe verdict or trading advice.',
  actions: [verifyTokenAction],
  providers: [],
  evaluators: [],
  services: [],
};

export { verifyTokenAction } from './actions/verifyToken.js';
export default ravenVerifyPlugin;
