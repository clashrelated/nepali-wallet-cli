import inquirer from 'inquirer';
import { listSavedBanks, validateBankTransfer, bankTransfer } from '../core/bank-transfer.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

// Single transfer, single confirmation — by design. Do not add list/CSV/loop variants.
// See AGENTS.md §2 (bulk operations).

const KHALTI_PURPOSES = [
  'Personal use',
  'Borrow/Lend',
  'Family expenses',
  'Bill Sharing',
  'Salary',
  'Ride Sharing',
  'Others',
];

function fuzzyMatchBank(banks, query) {
  const q = query.trim().toLowerCase();
  return (
    banks.find((b) => b.name.toLowerCase() === q) ||
    banks.find((b) => b.short_name?.toLowerCase() === q) ||
    banks.find((b) => b.name.toLowerCase().startsWith(q)) ||
    banks.find((b) => b.short_name?.toLowerCase().startsWith(q)) ||
    banks.find((b) => b.name.toLowerCase().includes(q))
  );
}

export async function bankTransferCommand(provider) {
  if (provider === 'khalti') return khaltiBankTransfer();
  if (provider === 'esewa') return esewaBankTransfer();
  error('Bank Transfer is only supported for eSewa and Khalti currently.');
  process.exit(1);
}

async function esewaBankTransfer() {
  const fetchSpin = spinner('Fetching saved bank accounts...');
  let banks;
  try {
    banks = await listSavedBanks('esewa');
    fetchSpin.succeed(`Found ${banks.length} saved bank(s)`);
  } catch (err) {
    fetchSpin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
    return;
  }

  if (!banks.length) {
    error('No saved bank accounts found. Add a bank account in the eSewa app first.');
    return;
  }

  const bankChoices = banks.map((b, i) => ({
    name: `${b.name}${b.linked ? ' (Free transfer)' : ''}  ${chalk.grey(b.accountNo)}`,
    value: i,
  }));

  const answers = await inquirer.prompt([
    { type: 'rawlist', name: 'bankIdx', message: 'Select destination bank:', choices: bankChoices },
    {
      type: 'number',
      name: 'amount',
      message: 'Amount (Rs.):',
      validate: (v) => v > 0 ? true : 'Enter a valid amount',
    },
    {
      type: 'input',
      name: 'remarks',
      message: 'Purpose/Remarks (letters, numbers, dot, dash only):',
      validate: (v) => /^[a-zA-Z0-9.,/\\-\s]{1,60}$/.test(v) ? true : 'Only letters, numbers, dot(.), comma(,), slash(/,\\), dash(-) allowed',
    },
  ]);

  const bank = banks[answers.bankIdx];

  console.log();
  console.log(chalk.bold('  Bank Transfer Summary'));
  console.log(`  Bank:    ${chalk.cyan(bank.name)}`);
  console.log(`  Account: ${chalk.grey(bank.accountNo)}`);
  console.log(`  Holder:  ${bank.holder}`);
  console.log(`  Amount:  ${chalk.green.bold('Rs. ' + answers.amount)}`);
  console.log(`  Remarks: ${answers.remarks}`);
  if (bank.linked) console.log(`  ${chalk.green('✔ Linked account — no service charge')}`);
  console.log();

  const { confirm } = await inquirer.prompt([{
    type: 'rawlist', name: 'confirm', message: 'Proceed?', choices: ['Yes', 'No'],
  }]);
  if (confirm !== 'Yes') { info('Cancelled.'); return; }

  const { mpin } = await inquirer.prompt([{
    type: 'password',
    name: 'mpin',
    message: 'Enter your MPIN:',
    mask: '*',
    validate: (v) => v.length >= 4 ? true : 'MPIN must be at least 4 digits',
  }]);

  const txSpin = spinner('Processing bank transfer...');
  try {
    const result = await bankTransfer('esewa', {
      bankName: bank.name,
      amount: answers.amount,
      remarks: answers.remarks,
      mpin,
    });
    txSpin.succeed('Transfer successful!');
    success(`Rs. ${answers.amount} sent to ${bank.name}`);
    if (result.ref) success(`Reference: ${result.ref}`);
  } catch (err) {
    txSpin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Transfer failed');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
  }
}

async function khaltiBankTransfer() {
  const fetchSpin = spinner('Fetching Khalti withdraw-enabled banks...');
  let banks;
  try {
    banks = await listSavedBanks('khalti');
    fetchSpin.succeed(`${banks.length} banks support direct withdraw`);
  } catch (err) {
    fetchSpin.fail('Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'bankName',
      message: "Bank name (full or partial, e.g. 'Nabil', 'NIC ASIA'):",
      validate: (v) => v.trim().length >= 2 ? true : 'Enter at least 2 characters',
    },
    {
      type: 'input',
      name: 'accountHolder',
      message: "Account holder's name:",
      validate: (v) => v.trim().length >= 2 ? true : 'Enter the holder name',
    },
    {
      type: 'input',
      name: 'accountNo',
      message: 'Account number:',
      validate: (v) => /^\d{6,20}$/.test(v.trim()) ? true : 'Enter a valid account number (6-20 digits)',
    },
    {
      type: 'number',
      name: 'amount',
      message: 'Amount (Rs.):',
      validate: (v) => v >= 100 ? true : 'Minimum bank transfer amount is Rs. 100',
    },
    { type: 'rawlist', name: 'purpose', message: 'Purpose:', choices: KHALTI_PURPOSES },
    { type: 'input', name: 'remarks', message: 'Remarks (optional):', default: '' },
  ]);

  const bank = fuzzyMatchBank(banks, answers.bankName);
  if (!bank) {
    error(`Bank "${answers.bankName}" not found. First few options: ${banks.slice(0, 8).map((b) => b.name).join(', ')}`);
    return;
  }

  const txn = {
    bankIdx: bank.idx,
    accountHolder: answers.accountHolder.trim(),
    accountNo: answers.accountNo.trim(),
    amountRs: answers.amount,
    purpose: answers.purpose,
    remarks: answers.remarks,
  };

  const validateSpin = spinner('Validating account with the bank...');
  let validation;
  try {
    validation = await validateBankTransfer('khalti', txn);
    validateSpin.succeed('Account validated');
  } catch (err) {
    validateSpin.fail('Validation failed');
    error(err.message);
    return;
  }

  console.log();
  console.log(chalk.bold('  Khalti Bank Transfer — Confirm'));
  console.log(`  Bank:           ${chalk.cyan(bank.name)}`);
  console.log(`  Verified holder:${chalk.grey(' ')}${validation.accountName} ${chalk.grey('(' + validation.matchPercentage + '% match)')}`);
  console.log(`  Account:        ${chalk.grey(validation.accountNumber)}`);
  console.log(`  Amount:         ${chalk.green.bold('Rs. ' + answers.amount)}`);
  console.log(`  Khalti fee:     ${chalk.yellow('Rs. ' + validation.feeRs)}`);
  console.log(`  Purpose:        ${answers.purpose}`);
  if (answers.remarks) console.log(`  Remarks:        ${answers.remarks}`);
  console.log();

  const { finalConfirm } = await inquirer.prompt([{
    type: 'rawlist', name: 'finalConfirm', message: 'Send this transfer?', choices: ['No', 'Yes'],
  }]);
  if (finalConfirm !== 'Yes') { info('Cancelled before final submission.'); return; }

  const paySpin = spinner('Submitting bank transfer...');
  try {
    const result = await bankTransfer('khalti', txn);
    paySpin.succeed('Bank transfer submitted!');
    success(result.message || `Rs. ${answers.amount} transferred to ${bank.name}`);
    if (result.balance != null) info(`New balance: Rs. ${result.balance}`);
    if (result.txnId) info(`Transaction: ${result.txnId}`);
  } catch (err) {
    paySpin.fail('Bank transfer failed');
    error(err.message);
  }
}
