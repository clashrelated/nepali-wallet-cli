import { providerClass, loadProviderSession } from './session-helper.js';
import { ValidationError, ProviderError, OtpRequiredError } from './errors.js';

// Khalti only — eSewa load fund stays CLI-only for now (its OTP flow needs a
// shared browser session across two calls, which is awkward to model).

// Returns: [{ account_id, bank_name, account_number, swift_code, txn_enabled }]
export async function listLinkedAccounts(provider) {
  if (provider !== 'khalti') {
    throw new ValidationError('listLinkedAccounts is Khalti-only for now', 'provider');
  }
  const session = loadProviderSession('khalti');
  const Client = providerClass('khalti');
  return new Client().listLinkedAccountsApi(session);
}

// Initiate a load from a linked bank account. If Khalti requires OTP (almost
// always for bank-debit loads), throws OtpRequiredError with the otpId. The
// caller then prompts the user for the OTP and calls verifyLoadOtp.
//   opts.account: a single account from listLinkedAccounts (must include account_id + swift_code)
//   opts.amountRs: number (Rs.)
//   opts.remarks: optional
// Returns: { otpId } if OTP needed; otherwise { message } if completed instantly.
export async function initiateLoad(provider, opts) {
  if (provider !== 'khalti') {
    throw new ValidationError('initiateLoad is Khalti-only for now', 'provider');
  }
  if (!opts?.account?.account_id || !opts?.account?.swift_code) {
    throw new ValidationError('opts.account must include account_id and swift_code', 'account');
  }
  if (!opts.amountRs || opts.amountRs <= 0) {
    throw new ValidationError('amountRs must be > 0', 'amountRs');
  }

  const session = loadProviderSession('khalti');
  const Client = providerClass('khalti');
  const result = await new Client().initiateLoadFundApi(
    session, opts.account, opts.amountRs, opts.remarks || ''
  );
  if (!result.success) throw new ProviderError(result.error || 'Load initiation failed', 'khalti');

  if (result.needsOtp) throw new OtpRequiredError(result.otpId, 'load');
  return { message: 'Load completed without OTP', amountRs: opts.amountRs };
}

// Verifies the OTP issued by initiateLoad. Returns final result.
// Returns: { message, amountRs, txnId, balance }
export async function verifyLoadOtp(provider, { otpId, code }) {
  if (provider !== 'khalti') {
    throw new ValidationError('verifyLoadOtp is Khalti-only for now', 'provider');
  }
  if (!otpId) throw new ValidationError('otpId required', 'otpId');
  if (!code) throw new ValidationError('code required', 'code');

  const session = loadProviderSession('khalti');
  const Client = providerClass('khalti');
  const result = await new Client().verifyLoadFundOtpApi(session, otpId, code);
  if (!result.success) throw new ProviderError(result.error || 'OTP verification failed', 'khalti');
  return {
    message: result.message,
    amountRs: result.amount,
    txnId: result.txnId,
    balance: result.balance,
  };
}
