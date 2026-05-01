import { withSession, providerClass, loadProviderSession } from './session-helper.js';
import { ValidationError, ProviderError } from './errors.js';

// Returns the list of banks usable for bank-transfer:
//   eSewa: linked accounts saved in the user's eSewa profile (free transfer if linked)
//   Khalti: all banks that support direct withdraw (~27 banks)
export async function listSavedBanks(provider, { headless = true } = {}) {
  if (provider === 'esewa') {
    return withSession('esewa', (client) => client.getSavedBanks(), { headless });
  }
  if (provider === 'khalti') {
    // Stateless API call — no browser needed
    const session = loadProviderSession('khalti');
    const Client = providerClass('khalti');
    return new Client().listWithdrawBanksApi(session);
  }
  throw new ValidationError(`Unknown provider: ${provider}`, 'provider');
}

// Khalti-only. Validates the destination account with the bank, returns the
// verified holder name + the Khalti transfer fee. Recommended call before
// `bankTransfer` so the user can confirm the verified info.
//   opts.bankIdx, accountHolder, accountNo, amountRs, purpose, remarks
// Returns: { accountName, accountNumber, matchPercentage, feeRs, message }
export async function validateBankTransfer(provider, opts) {
  if (provider !== 'khalti') {
    throw new ValidationError('validateBankTransfer is Khalti-only; eSewa has no validate step', 'provider');
  }
  const session = loadProviderSession('khalti');
  const Client = providerClass('khalti');
  const result = await new Client().validateBankAccountApi(session, opts);
  if (!result.success) throw new ProviderError(result.error || 'Validation failed', 'khalti');
  return result;
}

// Submit a bank transfer.
//   provider: 'esewa' | 'khalti'
//   eSewa: opts = { bankName, amount, remarks, mpin }
//   Khalti: opts = { bankIdx, accountHolder, accountNo, amountRs, purpose, remarks }
// Returns: { ref?, message?, txnId?, balance? }
export async function bankTransfer(provider, opts) {
  if (!opts.amount && !opts.amountRs) {
    throw new ValidationError('amount required', 'amount');
  }
  if (provider === 'esewa') return bankTransferEsewa(opts);
  if (provider === 'khalti') return bankTransferKhalti(opts);
  throw new ValidationError(`Unknown provider: ${provider}`, 'provider');
}

async function bankTransferEsewa({ bankName, amount, remarks = '', mpin, headless = true }) {
  if (!bankName) throw new ValidationError('bankName required', 'bankName');
  if (!mpin || mpin.length < 4) throw new ValidationError('mpin required (4+ digits)', 'mpin');
  return withSession('esewa', async (client) => {
    const result = await client.bankTransfer(bankName, amount, remarks, mpin);
    if (!result.success) throw new ProviderError(result.error || 'Bank transfer failed', 'esewa');
    return { ref: result.ref };
  }, { headless });
}

async function bankTransferKhalti(opts) {
  const session = loadProviderSession('khalti');
  const Client = providerClass('khalti');
  const result = await new Client().submitBankTransferApi(session, opts);
  if (!result.success) throw new ProviderError(result.error || 'Bank transfer failed', 'khalti');
  return { message: result.message, txnId: result.txnId, balance: result.balance };
}
