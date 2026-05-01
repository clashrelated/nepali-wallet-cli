#!/usr/bin/env node
/**
 * MCP server for nepali-wallet-cli.
 *
 * Exposes authenticated wallet operations (balance, history, send money,
 * top-up, bank-transfer, load) over stdio. Login is intentionally NOT
 * exposed — the MCP server returns SESSION_EXPIRED if the saved session
 * dies; user runs `wallet login <provider>` manually.
 *
 * Add to Claude Desktop config:
 *   "mcpServers": {
 *     "wallet": { "command": "node", "args": ["/path/to/nepali-wallet-cli/src/mcp/server.js"] }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getBalance } from '../core/balance.js';
import { getHistory } from '../core/history.js';
import { getTransactionDetail } from '../core/tx.js';
import { getStatus } from '../core/status.js';
import { topUp } from '../core/topup.js';
import { sendMoney } from '../core/send.js';
import { listSavedBanks, validateBankTransfer, bankTransfer } from '../core/bank-transfer.js';
import { listLinkedAccounts, initiateLoad, verifyLoadOtp } from '../core/load.js';
import { openLogin, finishLogin, cancelLogin } from '../core/login.js';

const PROVIDER = z.enum(['esewa', 'khalti']);

// Wraps a core function call in MCP's response envelope. Returns
// structuredContent on success, isError on failure.
function wrapCall(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      const text = JSON.stringify(result, null, 2);
      const response = { content: [{ type: 'text', text }] };
      // structuredContent must be a record (object), not an array or primitive
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        response.structuredContent = result;
      }
      return response;
    } catch (err) {
      const payload = typeof err.toJSON === 'function'
        ? err.toJSON()
        : { error: 'INTERNAL', message: err.message };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

const server = new McpServer({ name: 'wallet', version: '1.0.0' }, {
  instructions:
    'Wallet operations for eSewa & Khalti via the nepali-wallet-cli core. ' +
    'Login is not exposed — if a tool returns SESSION_EXPIRED, ask the user to run ' +
    '`wallet login <provider>` in their terminal. ' +
    'Khalti load fund and bank transfer use direct API calls (fast). ' +
    'Other operations drive a headless browser per call (5-10s each).',
});

// ── read-only ───────────────────────────────────────────────────────────────

server.registerTool('wallet_status', {
  description: 'List which providers (eSewa, Khalti) have saved sessions.',
}, wrapCall(() => getStatus()));

server.registerTool('wallet_balance', {
  description: 'Fetch the current wallet balance for a provider.',
  inputSchema: { provider: PROVIDER },
}, wrapCall(({ provider }) => getBalance(provider)));

server.registerTool('wallet_history', {
  description: 'List recent wallet transactions. Supports type/date filters.',
  inputSchema: {
    provider: PROVIDER,
    limit: z.number().int().positive().max(200).optional().default(10),
    type: z.enum(['credit', 'debit']).optional(),
    fromDate: z.string().describe('YYYY-MM-DD').optional(),
    toDate: z.string().describe('YYYY-MM-DD').optional(),
  },
}, wrapCall(({ provider, limit, type, fromDate, toDate }) => {
  const filter = {};
  if (type) filter.type = type;
  if (fromDate) filter.from = new Date(fromDate);
  if (toDate) filter.to = new Date(toDate + 'T23:59:59');
  return getHistory(provider, { limit, filter });
}));

server.registerTool('wallet_transaction_detail', {
  description: 'Get full detail for a transaction by row number (1 = most recent).',
  inputSchema: {
    provider: PROVIDER,
    row: z.number().int().positive().optional().default(1),
  },
}, wrapCall(({ provider, row }) => getTransactionDetail(provider, { row })));

// ── write: send / topup ─────────────────────────────────────────────────────

const ESEWA_PURPOSES = ['Bill sharing', 'Family Expenses', 'Groceries', 'Lend/borrow', 'Personal Use', 'Ride Sharing'];

server.registerTool('wallet_send_money', {
  description:
    'Send money to another wallet user. eSewa requires `mpin` and `purpose`; ' +
    'Khalti requires neither. Money moves immediately on success.',
  inputSchema: {
    provider: PROVIDER,
    recipient: z.string().describe('mobile number or email'),
    amount: z.number().positive(),
    purpose: z.enum(ESEWA_PURPOSES).optional(),
    remarks: z.string().optional().default(''),
    mpin: z.string().optional().describe('eSewa only — 4-6 digit MPIN'),
  },
}, wrapCall((args) => sendMoney(args.provider, args)));

server.registerTool('wallet_topup', {
  description: 'Recharge a Nepali mobile number via the wallet. eSewa requires `mpin`.',
  inputSchema: {
    provider: PROVIDER,
    mobile: z.string().regex(/^\d{10}$/).describe('10-digit Nepali mobile'),
    amount: z.number().positive(),
    mpin: z.string().optional().describe('eSewa only'),
  },
}, wrapCall((args) => topUp(args.provider, args)));

// ── write: bank-transfer ────────────────────────────────────────────────────

server.registerTool('wallet_list_banks', {
  description:
    'List banks usable for bank-transfer. eSewa returns the user\'s saved/linked ' +
    'bank accounts; Khalti returns all banks that support direct withdraw (~27 entries).',
  inputSchema: { provider: PROVIDER },
}, wrapCall(({ provider }) => listSavedBanks(provider)));

server.registerTool('wallet_validate_bank_account', {
  description:
    'Khalti only. Validates a destination account against the bank, returns the ' +
    'verified holder name + match percentage + Khalti fee in Rs. ' +
    'Recommended call before wallet_bank_transfer for Khalti.',
  inputSchema: {
    provider: PROVIDER,
    bankIdx: z.string().describe('idx from wallet_list_banks (Khalti)'),
    accountHolder: z.string(),
    accountNo: z.string(),
    amountRs: z.number().positive(),
    purpose: z.string(),
    remarks: z.string().optional().default(''),
  },
}, wrapCall((args) => validateBankTransfer(args.provider, args)));

server.registerTool('wallet_bank_transfer', {
  description:
    'Submit a bank transfer. eSewa: { bankName, amount, remarks, mpin }. ' +
    'Khalti: { bankIdx, accountHolder, accountNo, amountRs, purpose, remarks }.',
  inputSchema: {
    provider: PROVIDER,
    // eSewa fields
    bankName: z.string().optional(),
    amount: z.number().positive().optional(),
    mpin: z.string().optional(),
    // Khalti fields
    bankIdx: z.string().optional(),
    accountHolder: z.string().optional(),
    accountNo: z.string().optional(),
    amountRs: z.number().positive().optional(),
    purpose: z.string().optional(),
    remarks: z.string().optional().default(''),
  },
}, wrapCall((args) => bankTransfer(args.provider, args)));

// ── write: load fund (Khalti only) ──────────────────────────────────────────

server.registerTool('wallet_list_linked_accounts', {
  description:
    'Khalti only. List the user\'s linked bank accounts available for load fund. ' +
    'Returns each account\'s account_id and swift_code which initiateLoad needs.',
}, wrapCall(() => listLinkedAccounts('khalti')));

server.registerTool('wallet_initiate_load', {
  description:
    'Khalti only. Start a load-fund from a linked bank account. ' +
    'Throws OTP_REQUIRED with an otpId in almost all cases — the user receives ' +
    'an SMS, the caller passes the code to wallet_verify_load_otp.',
  inputSchema: {
    account: z.object({
      account_id: z.string(),
      swift_code: z.string(),
      bank_name: z.string().optional(),
      account_number: z.string().optional(),
    }).describe('one item from wallet_list_linked_accounts'),
    amountRs: z.number().positive(),
    remarks: z.string().optional().default(''),
  },
}, wrapCall((args) => initiateLoad('khalti', args)));

server.registerTool('wallet_verify_load_otp', {
  description:
    'Khalti only. Submits the OTP code received via SMS. Returns the final result ' +
    'with txnId and new wallet balance.',
  inputSchema: {
    otpId: z.string().describe('otpId from the OTP_REQUIRED error of initiateLoad'),
    code: z.string().regex(/^\d{4,8}$/),
  },
}, wrapCall(({ otpId, code }) => verifyLoadOtp('khalti', { otpId, code })));

// ── login (re-auth when session expires) ────────────────────────────────────

server.registerTool('wallet_open_login', {
  description:
    'Re-authenticate when a tool returns SESSION_EXPIRED. Opens a VISIBLE ' +
    'browser window on the user\'s desktop with saved credentials pre-filled ' +
    'and submitted, then returns immediately. The user completes any captcha/' +
    'OTP/MPIN steps themselves in that browser. After the user reports they ' +
    'are logged in, call wallet_finish_login to capture and save the session. ' +
    'Requires that credentials were saved at least once via the terminal ' +
    'CLI (`wallet login <provider> --relogin`). Auto-closes after 10 min.',
  inputSchema: { provider: PROVIDER },
}, wrapCall(({ provider }) => openLogin(provider)));

server.registerTool('wallet_finish_login', {
  description:
    'After the user completes captcha/OTP/MPIN in the browser opened by ' +
    'wallet_open_login, call this to capture cookies and save the session. ' +
    'Returns status:"not_yet" if the browser is not yet authenticated — wait ' +
    'a moment and try again. Returns status:"logged_in" on success.',
  inputSchema: { provider: PROVIDER },
}, wrapCall(({ provider }) => finishLogin(provider)));

server.registerTool('wallet_cancel_login', {
  description:
    'Abort a pending wallet_open_login (closes the browser without saving).',
  inputSchema: { provider: PROVIDER },
}, wrapCall(({ provider }) => cancelLogin(provider)));

// ── connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
