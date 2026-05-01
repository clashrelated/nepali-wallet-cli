import inquirer from 'inquirer';
import { sendMoney } from '../core/send.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

const ESEWA_PURPOSES = ['Bill sharing', 'Family Expenses', 'Groceries', 'Lend/borrow', 'Personal Use', 'Ride Sharing'];

// Single recipient, single confirmation — by design. Do not add list/CSV/loop variants.
// See AGENTS.md §2 (bulk operations).
export async function sendCommand(provider) {
  const idLabel = provider === 'esewa' ? 'eSewa ID (mobile or email)' : 'Khalti ID (mobile or email)';

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'recipient',
      message: `Recipient ${idLabel}:`,
      validate: (v) => v.length > 3 ? true : 'Enter a valid ID',
    },
    {
      type: 'number',
      name: 'amount',
      message: 'Amount (Rs.):',
      validate: (v) => v > 0 ? true : 'Enter a valid amount',
    },
  ]);

  let purpose = null;
  if (provider === 'esewa') {
    ({ purpose } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'purpose',
      message: 'Purpose (type a number):',
      choices: ESEWA_PURPOSES,
    }]));
  }

  const { remarks } = await inquirer.prompt([{
    type: 'input',
    name: 'remarks',
    message: 'Remarks (optional):',
    default: '',
  }]);

  console.log();
  console.log(chalk.bold('  Transfer Summary'));
  console.log(`  To:      ${chalk.cyan(answers.recipient)}`);
  console.log(`  Amount:  ${chalk.green.bold('Rs. ' + answers.amount)}`);
  if (purpose) console.log(`  Purpose: ${purpose}`);
  if (remarks) console.log(`  Remarks: ${remarks}`);
  console.log();

  const { confirm } = await inquirer.prompt([{
    type: 'rawlist',
    name: 'confirm',
    message: 'Proceed?',
    choices: ['Yes', 'No'],
  }]);
  if (confirm !== 'Yes') { info('Cancelled.'); return; }

  let mpin;
  if (provider === 'esewa') {
    ({ mpin } = await inquirer.prompt([{
      type: 'password',
      name: 'mpin',
      message: 'Enter your MPIN:',
      mask: '*',
      validate: (v) => v.length >= 4 ? true : 'MPIN must be at least 4 digits',
    }]));
  }

  const spin = spinner('Processing transfer...');
  try {
    const result = await sendMoney(provider, {
      recipient: answers.recipient,
      amount: answers.amount,
      purpose,
      remarks,
      mpin,
    });
    spin.succeed('Transfer successful!');
    success(result.message || `Rs. ${answers.amount} sent to ${answers.recipient}`);
    if (result.ref) success(`Reference: ${result.ref}`);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Transfer failed');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}
