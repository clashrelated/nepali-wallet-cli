import inquirer from 'inquirer';
import { getCredentials } from '../auth/keystore.js';
import { loadSession } from '../auth/session.js';
import { EsewaProvider } from '../providers/esewa.js';
import { listLinkedAccounts, initiateLoad, verifyLoadOtp } from '../core/load.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

const PURPOSES = ['Travel Ticketing', 'Utilities', 'P2P/Bank Transfers', 'Bill Payments', 'QR Payments'];

export async function loadCommand(provider, options) {
  if (provider === 'khalti') return khaltiLoadCommand();
  if (provider !== 'esewa') {
    error('Load Fund is only supported for eSewa and Khalti currently.');
    process.exit(1);
  }

  const creds = await getCredentials(provider);
  const cookies = loadSession(provider);
  if (!creds || !cookies) {
    error(`Not logged in. Run: wallet login ${provider} --show-browser`);
    process.exit(1);
  }

  const client = new EsewaProvider(true);
  const spin = spinner('Fetching linked bank accounts...');

  let banks = [];
  try {
    const valid = await client.restoreSession(cookies);
    if (!valid) {
      spin.fail('Session expired');
      error(`Run: wallet login ${provider} --show-browser`);
      await client.close();
      process.exit(1);
    }

    await client.page.goto('https://esewa.com.np/#/loadfund/linked-account', { waitUntil: 'load', timeout: 20000 });
    await client.page.waitForTimeout(3000);

    // Bank cards: ng-repeat="account in linkedAccounts" → .load-fund-wrap__list
    banks = await client.page.evaluate(() => {
      return Array.from(document.querySelectorAll('.load-fund-wrap__list'))
        .map((el) => el.innerText.trim())
        .filter(Boolean);
    });

    spin.succeed(banks.length ? `Found ${banks.length} linked bank(s)` : 'No linked banks found');
  } catch (err) {
    spin.fail('Error');
    error(err.message);
    await client.close();
    return;
  }

  if (!banks.length) {
    error('No linked bank accounts found. Link a bank account in the eSewa app first.');
    await client.close();
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: 'rawlist',
      name: 'bank',
      message: 'Select bank account:',
      choices: banks,
    },
    {
      type: 'number',
      name: 'amount',
      message: 'Amount to load (Rs., minimum 500):',
      validate: (v) => v >= 500 ? true : 'Minimum load amount is Rs.500',
    },
    {
      type: 'rawlist',
      name: 'purpose',
      message: 'Purpose:',
      choices: PURPOSES,
    },
  ]);

  console.log();
  console.log(chalk.bold('  Load Fund Summary'));
  console.log(`  Bank:    ${chalk.cyan(answers.bank)}`);
  console.log(`  Amount:  ${chalk.green.bold('Rs. ' + answers.amount)}`);
  console.log(`  Purpose: ${answers.purpose}`);
  console.log();

  const { confirm } = await inquirer.prompt([{
    type: 'rawlist',
    name: 'confirm',
    message: 'Proceed?',
    choices: ['Yes', 'No'],
  }]);

  if (confirm !== 'Yes') { info('Cancelled.'); await client.close(); return; }

  const loadSpin = spinner('Opening bank modal...');

  try {
    const result = await client.loadFund(answers.bank, answers.amount, answers.purpose);

    if (result === 'otp_required') {
      loadSpin.stop();

      const { otp } = await inquirer.prompt([{
        type: 'input',
        name: 'otp',
        message: 'Enter the 6-digit OTP sent to your mobile:',
        validate: (v) => /^\d{6}$/.test(v) ? true : 'Enter a valid 6-digit OTP',
      }]);

      const otpSpin = spinner('Verifying OTP...');
      const final = await client.submitLoadOtp(otp);
      await client.close();

      if (final.success) {
        otpSpin.succeed('Fund loaded successfully!');
        success(`Rs. ${answers.amount} loaded from ${answers.bank}`);
        if (final.ref) success(`Reference: ${final.ref}`);
      } else {
        otpSpin.fail('Failed');
        error(final.error);
      }
    } else if (result && result.success) {
      loadSpin.succeed('Fund loaded successfully!');
      await client.close();
      success(`Rs. ${answers.amount} loaded from ${answers.bank}`);
    } else {
      loadSpin.fail('Failed');
      await client.close();
      error(result?.error || 'Unknown error');
    }
  } catch (err) {
    loadSpin.fail('Error');
    error(err.message);
    await client.close();
  }
}

async function khaltiLoadCommand() {
  const spin = spinner('Fetching Khalti linked accounts...');
  let accounts;
  try {
    accounts = await listLinkedAccounts('khalti');
    spin.succeed(`Found ${accounts.length} linked account(s)`);
  } catch (err) {
    spin.fail(err.code === 'SESSION_EXPIRED' ? 'Session expired' : 'Error');
    error(err.message);
    if (err.hint) error(err.hint);
    if (err.code === 'NOT_LOGGED_IN' || err.code === 'SESSION_EXPIRED') process.exit(1);
    return;
  }

  const usable = accounts.filter((a) => a.txn_enabled !== false);
  if (!usable.length) {
    error('No transaction-enabled linked accounts. Link/verify a bank in Khalti first.');
    return;
  }

  const choices = usable.map((a) => ({
    name: `${a.bank_name}  ${chalk.grey(a.account_number)}`,
    value: a,
  }));

  const answers = await inquirer.prompt([
    { type: 'rawlist', name: 'account', message: 'Select linked account:', choices },
    {
      type: 'number',
      name: 'amount',
      message: 'Amount to load (Rs.):',
      validate: (v) => v > 0 ? true : 'Enter a valid amount',
    },
    { type: 'input', name: 'remarks', message: 'Remarks (optional):', default: '' },
  ]);

  console.log();
  console.log(chalk.bold('  Khalti Load Fund Summary'));
  console.log(`  From:    ${chalk.cyan(answers.account.bank_name + ' ' + answers.account.account_number)}`);
  console.log(`  Amount:  ${chalk.green.bold('Rs. ' + answers.amount)}`);
  if (answers.remarks) console.log(`  Remarks: ${answers.remarks}`);
  console.log();

  const { confirm } = await inquirer.prompt([{
    type: 'rawlist', name: 'confirm', message: 'Send load request to Khalti?', choices: ['No', 'Yes'],
  }]);
  if (confirm !== 'Yes') { info('Cancelled.'); return; }

  const initSpin = spinner('Submitting load request...');
  let otpId;
  try {
    const init = await initiateLoad('khalti', { account: answers.account, amountRs: answers.amount, remarks: answers.remarks });
    initSpin.succeed('Load completed (no OTP required)');
    success(init.message || `Rs. ${answers.amount} requested. Check Khalti history.`);
    return;
  } catch (err) {
    if (err.code === 'OTP_REQUIRED') {
      otpId = err.otpId;
      initSpin.succeed('Load initiated — OTP sent to your mobile');
    } else {
      initSpin.fail('Load init failed');
      error(err.message);
      if (err.hint) error(err.hint);
      return;
    }
  }

  const { otp } = await inquirer.prompt([{
    type: 'input',
    name: 'otp',
    message: 'Enter the OTP:',
    validate: (v) => /^\d{4,8}$/.test(v) ? true : 'Enter a valid OTP (4-8 digits)',
  }]);

  const verifySpin = spinner('Verifying OTP...');
  try {
    const result = await verifyLoadOtp('khalti', { otpId, code: otp });
    verifySpin.succeed('Fund loaded!');
    success(result.message || `Rs. ${answers.amount} loaded`);
    if (result.balance != null) info(`New balance: Rs. ${result.balance}`);
    if (result.txnId) info(`Transaction: ${result.txnId}`);
  } catch (err) {
    verifySpin.fail('OTP verification failed');
    error(err.message);
  }
}
