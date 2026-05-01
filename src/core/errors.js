// Structured errors thrown from src/core/. Designed so the CLI can render them
// nicely AND a future MCP server can serialize them to a structured response.

export class WalletError extends Error {
  constructor(message, code, hint) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    if (hint) this.hint = hint;
  }
  toJSON() {
    return { error: this.code, message: this.message, hint: this.hint };
  }
}

export class NotLoggedInError extends WalletError {
  constructor(provider) {
    super(`Not logged in to ${provider}`, 'NOT_LOGGED_IN', `Run: wallet login ${provider}`);
    this.provider = provider;
  }
}

export class SessionExpiredError extends WalletError {
  constructor(provider) {
    super(`Session expired for ${provider}`, 'SESSION_EXPIRED', `Run: wallet login ${provider}`);
    this.provider = provider;
  }
}

export class OtpRequiredError extends WalletError {
  constructor(otpId, context) {
    super('OTP required to complete this action', 'OTP_REQUIRED');
    this.otpId = otpId;
    this.context = context;
  }
  toJSON() {
    return { error: this.code, otpId: this.otpId, context: this.context };
  }
}

export class ValidationError extends WalletError {
  constructor(message, field) {
    super(message, 'VALIDATION_ERROR');
    if (field) this.field = field;
  }
}

export class ProviderError extends WalletError {
  constructor(message, provider) {
    super(message, 'PROVIDER_ERROR');
    this.provider = provider;
  }
}
