import { getCredentials } from '../auth/keystore.js';
import { getBalance } from '../core/balance.js';
import { spinner, error, balanceCard } from '../ui/display.js';

export async function balanceCommand(provider, options) {
  const spin = spinner(`Fetching ${provider} balance...`);
  try {
    const { balance, name } = await getBalance(provider, { headless: !options.showBrowser });
    spin.succeed('Done');
    const creds = await getCredentials(provider);
    balanceCard(provider, name, balance, creds?.phone);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}
