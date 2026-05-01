import inquirer from 'inquirer';
import { topUp } from '../core/topup.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

// Single recharge, single confirmation — by design. Do not add list/CSV/loop variants.
// See AGENTS.md §2 (bulk operations).
export async function topupCommand(provider) {
  const minAmount = provider === 'khalti' ? 50 : 0;

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'mobile',
      message: 'Mobile number to recharge:',
      validate: (v) => /^\d{10}$/.test(v) ? true : 'Enter a 10-digit mobile number',
    },
    {
      type: 'number',
      name: 'amount',
      message: `Recharge amount (Rs.${provider === 'khalti' ? ', minimum 50 for Ncell' : ''}):`,
      validate: (v) => v >= minAmount ? true : `Minimum ${minAmount}`,
    },
  ]);

  console.log();
  console.log(chalk.bold('  Recharge Summary'));
  console.log(`  Mobile:  ${chalk.cyan(answers.mobile)}`);
  console.log(`  Amount:  ${chalk.green.bold('Rs. ' + answers.amount)}`);
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

  const spin = spinner('Processing top up...');
  try {
    const result = await topUp(provider, { mobile: answers.mobile, amount: answers.amount, mpin });
    spin.succeed('Top Up successful!');
    success(result.message || `Rs. ${answers.amount} recharged to ${answers.mobile}`);
    if (result.ref) success(`Reference: ${result.ref}`);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Top Up failed');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}
