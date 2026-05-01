import { getStatus } from '../core/status.js';
import chalk from 'chalk';

export async function statusCommand() {
  const rows = await getStatus();
  console.log();
  console.log(chalk.bold('  Saved Sessions'));
  console.log();

  for (const row of rows) {
    const label = row.provider === 'esewa' ? chalk.green.bold('eSewa ') : chalk.magenta.bold('Khalti');
    if (row.loggedIn) {
      console.log(`  ${label}  ${chalk.green('●')} logged in  ${chalk.grey(row.identifier || '')}`);
    } else {
      console.log(`  ${label}  ${chalk.grey('○')} not logged in`);
    }
  }
  console.log();
}
