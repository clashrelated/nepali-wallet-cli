import { clearCredentials, hasCredentials } from '../auth/keystore.js';
import { clearSession } from '../auth/session.js';
import { success, info } from '../ui/display.js';

export async function logoutCommand(provider) {
  if (provider === 'all') {
    await clearCredentials('esewa');
    await clearCredentials('khalti');
    clearSession('esewa');
    clearSession('khalti');
    success('Cleared credentials and sessions for all providers.');
    return;
  }

  const has = await hasCredentials(provider);
  if (!has) {
    info(`No saved credentials for ${provider}.`);
    return;
  }

  await clearCredentials(provider);
  clearSession(provider);
  success(`Logged out of ${provider}. Credentials and session removed.`);
}
