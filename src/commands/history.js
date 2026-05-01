import { writeFileSync } from 'fs';
import { getHistory, transactionsToCSV } from '../core/history.js';
import { spinner, error, info, transactionTable } from '../ui/display.js';
import chalk from 'chalk';

export async function historyCommand(provider, options) {
  const limit = parseInt(options.limit) || 10;
  const filter = {};
  if (options.type) {
    const t = options.type.toLowerCase();
    if (t === 'cr') filter.type = 'credit';
    else if (t === 'dr') filter.type = 'debit';
  }
  if (options.from) filter.from = new Date(options.from);
  if (options.to) filter.to = new Date(options.to + 'T23:59:59');

  const exportPath = options.export;
  const fetchLimit = exportPath ? 200 : limit;

  const spin = spinner(`Fetching ${provider} transactions...`);
  try {
    const transactions = await getHistory(provider, { limit: fetchLimit, filter });
    spin.succeed(`Fetched ${transactions.length} transactions`);

    if (exportPath) {
      const outPath = exportPath === true ? `${provider}-${Date.now()}.csv` : exportPath;
      writeFileSync(outPath, transactionsToCSV(transactions));
      info(`Exported to ${outPath}`);
      return;
    }

    console.log();
    console.log(chalk.bold(`  ${provider === 'esewa' ? chalk.green('eSewa') : chalk.magenta('Khalti')} — Transactions`));
    if (filter.type) info(`Filter: ${filter.type === 'credit' ? 'Credits only' : 'Debits only'}`);
    if (filter.from || filter.to) info(`Date range: ${options.from || '—'} → ${options.to || 'now'}`);
    console.log();
    transactionTable(transactions);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}
