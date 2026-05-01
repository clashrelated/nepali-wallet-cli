import { getCredentials } from '../auth/keystore.js';
import { loadSession } from '../auth/session.js';
import { EsewaProvider } from '../providers/esewa.js';
import { KhaltiProvider } from '../providers/khalti.js';
import { error, info } from '../ui/display.js';
import chalk from 'chalk';

export async function watchCommand(provider, options) {
  const creds = await getCredentials(provider);
  const cookies = loadSession(provider);
  if (!creds || !cookies) {
    error(`Not logged in. Run: wallet login ${provider} --show-browser`);
    process.exit(1);
  }

  const interval = parseInt(options.interval) || 30;
  const label = provider === 'esewa' ? chalk.green.bold('eSewa') : chalk.magenta.bold('Khalti');
  const Client = provider === 'esewa' ? EsewaProvider : KhaltiProvider;

  console.log();
  info(`Watching ${provider} balance — refreshing every ${interval}s. Press Ctrl+C to stop.`);
  console.log();

  const client = new Client(true);

  try {
    const valid = await client.restoreSession(cookies);
    if (!valid) {
      error('Session expired. Run: wallet login ' + provider + ' --show-browser');
      await client.close();
      process.exit(1);
    }

    const poll = async () => {
      try {
        const { balance, name } = await client.getBalance();
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        process.stdout.write(`\r  ${label}  ${chalk.white.bold('Rs. ' + balance).padEnd(20)}  ${chalk.grey(time)}  `);
      } catch {
        process.stdout.write(`\r  ${label}  ${chalk.grey('fetch failed...')}  `);
      }
    };

    await poll();
    const timer = setInterval(poll, interval * 1000);

    process.on('SIGINT', async () => {
      clearInterval(timer);
      console.log('\n');
      info('Watch stopped.');
      await client.close();
      process.exit(0);
    });
  } catch (err) {
    error(err.message);
    await client.close();
  }
}
