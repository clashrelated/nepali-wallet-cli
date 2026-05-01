import readline from 'readline';
import inquirer from 'inquirer';
import { saveCredentials, getCredentials } from '../auth/keystore.js';
import { saveSession } from '../auth/session.js';
import { EsewaProvider } from '../providers/esewa.js';
import { KhaltiProvider } from '../providers/khalti.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

export async function loginCommand(provider, options) {
  info(`Logging into ${provider === 'esewa' ? 'eSewa' : 'Khalti'}...`);

  const saved = await getCredentials(provider);
  if (saved && !options.relogin) {
    info(`Using saved credentials for ${saved.phone}`);
    info(`Run with --relogin to use different credentials.`);
    return doLogin(provider, saved.phone, saved.password, options);
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'phone',
      message: 'Mobile number:',
      default: saved?.phone,
      validate: (v) => v.length > 3 ? true : 'Enter your mobile number or eSewa/Khalti ID',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:',
      mask: '*',
    },
  ]);

  return doLogin(provider, answers.phone, answers.password, options);
}

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

async function doLogin(provider, phone, password, options) {
  const showBrowser = options.showBrowser ?? false;
  const Client = provider === 'esewa' ? EsewaProvider : KhaltiProvider;
  const client = new Client(!showBrowser);

  const spin = spinner(`Launching browser...`);

  try {
    if (showBrowser) {
      await client.fillAndSubmit(phone, password);
      spin.stop();
      console.log();
      console.log(chalk.cyan('  Browser is open. Complete any CAPTCHA or OTP steps.'));
      console.log(chalk.bold.green('  Press Enter here once you are fully logged in → '));
      await waitForEnter();
    } else {
      // Headless — login() handles the full flow (fill + submit + detect state)
      const result = await client.login(phone, password);
      spin.stop();

      if (result.needsOtp) {
        spin.stop();
        info('OTP sent to your mobile. Check your messages.');
        const { otp } = await inquirer.prompt([{
          type: 'input',
          name: 'otp',
          message: 'Enter OTP:',
          validate: (v) => v.trim().length >= 4 ? true : 'Enter the OTP from your SMS',
        }]);
        const otpSpin = spinner('Verifying OTP...');
        const otpResult = await client.submitOtp(otp.trim());
        if (!otpResult.success) {
          otpSpin.fail('OTP failed');
          error(otpResult.error);
          await client.close();
          return;
        }
        otpSpin.succeed('OTP verified');
      } else if (!result.success) {
        spin.fail('Login failed');
        error(result.error);
        error('Try again with --show-browser if needed.');
        await client.close();
        return;
      }
    }

    // Save cookies so balance/history don't need to re-login
    const cookies = await client.getCookies();
    saveSession(provider, cookies);
    await client.close();

    await saveCredentials(provider, phone, password);
    success(`Logged into ${provider}!`);
    success('Session saved — no need to login again until it expires.');
  } catch (err) {
    spin.stop();
    error(err.message);
    await client.close();
  }
}
