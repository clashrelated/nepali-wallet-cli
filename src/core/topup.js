import { withSession } from './session-helper.js';
import { ValidationError, ProviderError } from './errors.js';

// Recharge a mobile number. Single call — caller must confirm intent before calling.
//   provider: 'esewa' | 'khalti'
//   opts.mobile: 10-digit string
//   opts.amount: number (Rs.)
//   opts.mpin: required for eSewa
// Returns: { mobile, amount, ref?, message? }
// Throws: ValidationError, NotLoggedInError, SessionExpiredError, ProviderError
export async function topUp(provider, opts) {
  if (!opts?.mobile || !/^\d{10}$/.test(opts.mobile)) {
    throw new ValidationError('mobile must be a 10-digit number', 'mobile');
  }
  if (!opts.amount || opts.amount <= 0) {
    throw new ValidationError('amount must be > 0', 'amount');
  }

  if (provider === 'esewa') return topUpEsewa(opts);
  if (provider === 'khalti') return topUpKhalti(opts);
  throw new ValidationError(`Unknown provider: ${provider}`, 'provider');
}

async function topUpEsewa({ mobile, amount, mpin, headless = true }) {
  if (!mpin || mpin.length < 4) throw new ValidationError('mpin required (4+ digits) for eSewa', 'mpin');
  return withSession('esewa', async (client) => {
    const result = await client.topUp(mobile, amount, mpin);
    if (!result.success) throw new ProviderError(result.error || 'Top up failed', 'esewa');
    return { mobile, amount, ref: result.ref };
  }, { headless });
}

async function topUpKhalti({ mobile, amount, headless = true }) {
  return withSession('khalti', async (client) => {
    const prep = await client.prepareTopUp(mobile, amount);
    if (!prep.success) throw new ProviderError(prep.error || 'Top up preparation failed', 'khalti');
    const result = await client.confirmTopUp();
    if (!result.success) throw new ProviderError(result.error || 'Top up failed', 'khalti');
    return { mobile, amount, message: result.message };
  }, { headless });
}
