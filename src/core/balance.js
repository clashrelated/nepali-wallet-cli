import { withSession } from './session-helper.js';

// Returns { balance, name } from the authenticated wallet page.
// Throws NotLoggedIn / SessionExpired / ProviderError.
export async function getBalance(provider, { headless = true } = {}) {
  return withSession(provider, (client) => client.getBalance(), { headless });
}
