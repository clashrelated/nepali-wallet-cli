import { withSession } from './session-helper.js';
import { ValidationError, ProviderError } from './errors.js';

// Send money to another wallet user.
//   provider: 'esewa' | 'khalti'
//   opts.recipient: string (mobile or email)
//   opts.amount: number (Rs.)
//   opts.purpose: required for eSewa (one of the eSewa-defined values)
//   opts.remarks: optional string
//   opts.mpin: required for eSewa
// Returns: { recipient, amount, ref?, message? }
export async function sendMoney(provider, opts) {
  if (!opts?.recipient || opts.recipient.trim().length < 3) {
    throw new ValidationError('recipient required', 'recipient');
  }
  if (!opts.amount || opts.amount <= 0) {
    throw new ValidationError('amount must be > 0', 'amount');
  }

  if (provider === 'esewa') return sendEsewa(opts);
  if (provider === 'khalti') return sendKhalti(opts);
  throw new ValidationError(`Unknown provider: ${provider}`, 'provider');
}

async function sendEsewa({ recipient, amount, purpose, remarks = '', mpin, headless = true }) {
  if (!purpose) throw new ValidationError('purpose required for eSewa', 'purpose');
  if (!mpin || mpin.length < 4) throw new ValidationError('mpin required (4+ digits) for eSewa', 'mpin');
  return withSession('esewa', async (client, session) => {
    const result = await client.sendMoney(session, recipient, amount, purpose, remarks, mpin);
    if (!result.success) throw new ProviderError(result.error || 'Send failed', 'esewa');
    return { recipient, amount, ref: result.ref };
  }, { headless });
}

async function sendKhalti({ recipient, amount, remarks = '', headless = true }) {
  return withSession('khalti', async (client) => {
    const prep = await client.prepareSendMoney(recipient, amount, remarks);
    if (!prep.success) throw new ProviderError(prep.error || 'Send preparation failed', 'khalti');
    const result = await client.confirmSendMoney();
    if (!result.success) throw new ProviderError(result.error || 'Send failed', 'khalti');
    return { recipient, amount, message: result.message };
  }, { headless });
}
