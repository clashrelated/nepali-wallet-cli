import { getTransactionDetail } from '../core/tx.js';
import { spinner, error } from '../ui/display.js';
import chalk from 'chalk';

export async function txCommand(provider, options) {
  const rowNum = parseInt(options.row) || 1;
  const spin = spinner(`Fetching transaction #${rowNum} detail...`);

  try {
    const detail = await getTransactionDetail(provider, { row: rowNum });
    if (!detail) {
      spin.fail(`Transaction #${rowNum} not found`);
      return;
    }
    spin.succeed('Loaded');
    if (provider === 'khalti') printKhaltiDetail(detail);
    else printDetail(detail, provider);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}

function printKhaltiDetail(d) {
  const accent = chalk.magenta;
  const line = chalk.grey('  ' + '─'.repeat(50));

  console.log();
  console.log(accent.bold(`  ${d.title || 'Khalti Transaction Detail'}`));
  console.log(line);

  const fields = [
    ['Reference',    d.reference],
    ['Date/Time',    d.date],
    ['Status',       d.status],
    ['Type',         d.type],
    ['Transaction',  d.transaction],
    ['Amount',       d.amount ? chalk.white.bold(`NPR ${d.amount}`) : null],
    ['Balance',      d.balance ? `NPR ${d.balance}` : null],
    ['From',         d.senderName],
    ['To',           d.receiverName],
    ['Original Tx',  d.originalTransaction],
  ];

  for (const [label, value] of fields.filter(([, v]) => v)) {
    console.log(`  ${chalk.grey(label.padEnd(14))} ${value}`);
  }

  console.log(line);
  console.log();
}

function printDetail(d, provider) {
  const accent = provider === 'esewa' ? chalk.green : chalk.magenta;
  const line = chalk.grey('  ' + '─'.repeat(50));

  console.log();
  console.log(accent.bold(`  ${d.title || 'Transaction Detail'}`));
  console.log(line);

  const statusVal = d.status
    ? (d.status.toUpperCase() === 'COMPLETE'
        ? chalk.green('COMPLETE ✔')
        : chalk.yellow(d.status))
    : null;

  const fields = [
    ['Reference',    d.reference],
    ['Date/Time',    d.date],
    ['Status',       statusVal],
    ['Amount',       d.amount ? chalk.white.bold(`NPR ${d.amount}`) : null],
    ['Channel',      d.channel],
    ['Purpose',      d.purpose],
    ['Processed By', d.processedBy],
    ['Sender',       d.senderName],
    ['Receiver',     d.receiverName],
    ['Bank',         d.bankName],
    ['Method',       d.paymentMethod],
    ['Remarks',      d.remarks],
    ['Request ID',   d.requestId],
  ];

  const named = fields.filter(([, v]) => v);
  if (named.length === 0 && d._raw && Object.keys(d._raw).length > 0) {
    for (const [k, v] of Object.entries(d._raw)) {
      console.log(`  ${chalk.grey(k.padEnd(30))} ${v}`);
    }
  } else {
    for (const [label, value] of named) {
      console.log(`  ${chalk.grey(label.padEnd(14))} ${value}`);
    }
  }

  console.log(line);
  console.log();
}
