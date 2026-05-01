#!/usr/bin/env node
import { Command, Option } from 'commander';
import { logo } from './ui/display.js';
import { loginCommand } from './commands/login.js';
import { balanceCommand } from './commands/balance.js';
import { historyCommand } from './commands/history.js';
import { logoutCommand } from './commands/logout.js';
import { statusCommand } from './commands/status.js';
import { sendCommand } from './commands/send.js';
import { topupCommand } from './commands/topup.js';
import { loadCommand } from './commands/load.js';
import { watchCommand } from './commands/watch.js';
import { txCommand } from './commands/tx.js';
import { bankTransferCommand } from './commands/bank-transfer.js';
import { billCommand } from './commands/bill.js';
import { keepAliveCommand, keepAliveStatusCommand } from './commands/keep-alive.js';

const program = new Command();

program
  .name('wallet')
  .description('Nepali Wallet CLI — eSewa & Khalti from your terminal')
  .version('1.0.0');

const browserOpt = ['-b, --show-browser', 'Show the browser window'];

// login
program
  .command('login <provider>')
  .description('Login to esewa or khalti')
  .option(...browserOpt)
  .option('-r, --relogin', 'Prompt for new credentials even if saved ones exist')
  .action((provider, opts) => { logo(); validateProvider(provider); loginCommand(provider, opts); });

// balance
program
  .command('balance <provider>')
  .description('Show wallet balance')
  .option(...browserOpt)
  .action((provider, opts) => { logo(); validateProvider(provider); balanceCommand(provider, opts); });

// history
program
  .command('history <provider>')
  .description('Show recent transactions')
  .option('-n, --limit <number>', 'Number of transactions', '10')
  .option('--from <date>', 'Filter from date (YYYY-MM-DD)')
  .option('--to <date>', 'Filter to date (YYYY-MM-DD)')
  .option('--type <type>', 'Filter by type: cr (credits) or dr (debits)')
  .option('--export [file]', 'Export to CSV file')
  .action((provider, opts) => { logo(); validateProvider(provider); historyCommand(provider, opts); });

// send
program
  .command('send <provider>')
  .description('Send money to another user')
  .action((provider, opts) => { logo(); validateProvider(provider); sendCommand(provider, opts); });

// topup
program
  .command('topup <provider>')
  .description('Mobile top up / recharge')
  .action((provider, opts) => { logo(); validateProvider(provider); topupCommand(provider, opts); });

// load
program
  .command('load <provider>')
  .description('Load funds from bank account')
  .action((provider, opts) => { logo(); validateProvider(provider); loadCommand(provider, opts); });

// watch
program
  .command('watch <provider>')
  .description('Live balance ticker (refreshes automatically)')
  .option('-i, --interval <seconds>', 'Refresh interval in seconds', '30')
  .action((provider, opts) => { logo(); validateProvider(provider); watchCommand(provider, opts); });

// bank-transfer
program
  .command('bank-transfer <provider>')
  .description('Transfer from eSewa wallet to a bank account')
  .action((provider, opts) => { logo(); validateProvider(provider); bankTransferCommand(provider, opts); });

// bill payment
program
  .command('bill <provider>')
  .description('Pay utility bills (NEA, internet, water, etc.)')
  .addOption(new Option(...browserOpt))
  .action((provider, opts) => { logo(); validateProvider(provider); billCommand(provider, opts); });

// tx — full transaction detail
program
  .command('tx <provider>')
  .description('Show full detail for a transaction (by row number in history)')
  .option('-r, --row <number>', 'Row number in the statement list (1 = latest)', '1')
  .action((provider, opts) => { logo(); validateProvider(provider); txCommand(provider, opts); });

// logout
program
  .command('logout [provider]')
  .description('Remove saved credentials (esewa, khalti, or all)')
  .action((provider = 'all') => {
    if (provider !== 'all') validateProvider(provider);
    logoutCommand(provider);
  });

// keep-alive
program
  .command('keep-alive <provider>')
  .description('Probe the saved session on an interval to keep it from expiring')
  .option('-i, --interval <minutes>', 'Probe interval in minutes (1–60)', '12')
  .action((provider, opts) => { logo(); validateProvider(provider); keepAliveCommand(provider, opts); });

// keep-alive-status
program
  .command('keep-alive-status')
  .description('Show last keep-alive probe time and result for each provider')
  .action(() => { logo(); keepAliveStatusCommand(); });

// status
program
  .command('status')
  .description('Show which accounts are logged in')
  .action(() => { logo(); statusCommand(); });

function validateProvider(p) {
  if (!['esewa', 'khalti'].includes(p)) {
    console.error(`Unknown provider: "${p}". Use "esewa" or "khalti".`);
    process.exit(1);
  }
}

program.parse(process.argv);
