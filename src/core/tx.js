import { withSession } from './session-helper.js';

// Returns the per-transaction detail object (provider-specific shape).
// `row` is 1-indexed, where 1 = most recent.
// Returns null if the row doesn't exist.
export async function getTransactionDetail(provider, { row = 1, headless = true } = {}) {
  return withSession(provider, (client) => client.getTransactionDetail(row), { headless });
}
