import { loadSession, saveSession, hasSession } from '../auth/session.js';
import { EsewaProvider } from '../providers/esewa.js';
import { KhaltiProvider } from '../providers/khalti.js';
import { NotLoggedInError, SessionExpiredError } from './errors.js';

export const PROVIDERS = ['esewa', 'khalti'];

export function providerClass(provider) {
  if (provider === 'esewa') return EsewaProvider;
  if (provider === 'khalti') return KhaltiProvider;
  throw new Error(`Unknown provider: ${provider}`);
}

export function loadProviderSession(provider) {
  const session = loadSession(provider);
  if (!session) throw new NotLoggedInError(provider);
  return session;
}

// Run `fn(client, session)` with a logged-in browser client; closes the
// browser even on error. Throws SessionExpiredError if the saved session
// no longer authenticates.
export async function withSession(provider, fn, { headless = true } = {}) {
  const session = loadProviderSession(provider);
  const Client = providerClass(provider);
  const client = new Client(headless);
  try {
    const valid = await client.restoreSession(session);
    if (!valid) throw new SessionExpiredError(provider);
    return await fn(client, session);
  } finally {
    await client.close().catch(() => {});
  }
}

export { hasSession, saveSession };
