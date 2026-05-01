import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

export function logo() {
  console.log(chalk.cyan.bold(`
  ╔═══════════════════════════════╗
  ║   💸  Nepali Wallet CLI  💸  ║
  ║   eSewa  •  Khalti           ║
  ╚═══════════════════════════════╝
`));
}

export function spinner(text) {
  return ora({ text, color: 'cyan', spinner: 'dots' }).start();
}

export function success(msg) {
  console.log(chalk.green('✔ ') + msg);
}

export function error(msg) {
  console.log(chalk.red('✖ ') + msg);
}

export function info(msg) {
  console.log(chalk.cyan('ℹ ') + msg);
}

export function warn(msg) {
  console.log(chalk.yellow('⚠ ') + msg);
}

export function balanceCard(provider, name, balance, phone) {
  const providerColor = provider === 'esewa' ? chalk.green : chalk.magenta;
  const label = provider === 'esewa' ? 'eSewa' : 'Khalti';

  console.log();
  console.log(providerColor.bold(`  ┌─────────────────────────────┐`));
  console.log(providerColor.bold(`  │  ${label.padEnd(27)} │`));
  console.log(providerColor(`  │  ${chalk.white(name || phone || '').padEnd(27)} │`));
  console.log(providerColor(`  │                             │`));
  console.log(providerColor(`  │  Balance:  `) + chalk.white.bold(`Rs. ${balance}`.padEnd(18)) + providerColor(` │`));
  console.log(providerColor.bold(`  └─────────────────────────────┘`));
  console.log();
}

export function transactionTable(transactions) {
  if (!transactions || transactions.length === 0) {
    warn('No transactions found.');
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Date'),
      chalk.cyan('Description'),
      chalk.cyan('Via'),
      chalk.cyan('Amount'),
      chalk.cyan('Balance'),
    ],
    colWidths: [26, 42, 7, 14, 14],
    style: { border: ['grey'], head: [] },
    wordWrap: false,
  });

  for (const tx of transactions) {
    const amount = tx.type === 'credit'
      ? chalk.green(`+ Rs. ${tx.amount}`)
      : chalk.red(`- Rs. ${tx.amount}`);
    table.push([
      tx.date || '—',
      tx.description || '—',
      chalk.grey(tx.channel || '—'),
      amount,
      tx.balance ? `Rs. ${tx.balance}` : '—',
    ]);
  }

  console.log(table.toString());
}
