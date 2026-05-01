import { withSession } from './session-helper.js';

// Returns an array of { date, description, channel, amount, type, balance }.
// `filter` accepts { type: 'credit'|'debit', from: Date, to: Date }.
// `limit` is applied AFTER filtering. Internally fetches more than `limit`
// so filters still produce enough rows.
export async function getHistory(provider, { limit = 10, filter = {}, headless = true } = {}) {
  const fetchLimit = Math.max(limit * 3, 50);
  let txs = await withSession(provider, (client) => client.getTransactions(fetchLimit), { headless });

  if (filter.type === 'credit' || filter.type === 'debit') {
    txs = txs.filter((t) => t.type === filter.type);
  }
  if (filter.from instanceof Date) {
    txs = txs.filter((t) => new Date(t.date) >= filter.from);
  }
  if (filter.to instanceof Date) {
    txs = txs.filter((t) => new Date(t.date) <= filter.to);
  }

  return txs.slice(0, limit);
}

export function transactionsToCSV(transactions) {
  const headers = ['Date', 'Description', 'Type', 'Amount', 'Balance'];
  const rows = transactions.map((t) => [
    `"${t.date}"`,
    `"${(t.description || '').replace(/"/g, '""')}"`,
    t.type,
    t.amount,
    t.balance || '',
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
