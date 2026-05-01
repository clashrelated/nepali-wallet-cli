import { hasCredentials, getCredentials } from '../auth/keystore.js';
import { hasSession } from '../auth/session.js';
import { PROVIDERS } from './session-helper.js';

// Returns [{ provider, loggedIn, hasSession, identifier }] for each provider.
// `identifier` is the saved phone/username (best-effort, may be null).
export async function getStatus() {
  const result = [];
  for (const provider of PROVIDERS) {
    const loggedIn = await hasCredentials(provider);
    const creds = loggedIn ? await getCredentials(provider) : null;
    result.push({
      provider,
      loggedIn,
      hasSession: hasSession(provider),
      identifier: creds?.phone || null,
    });
  }
  return result;
}
