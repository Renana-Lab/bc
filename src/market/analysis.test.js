import { analyzeMarketReport } from './analysis';
import { buildMarketWorkbook, formatReportValue } from './reportExport';
test('backend report joins cohorts and flags missing payments', () => {
  const report = {
    generatedAt: 100,
    users: [{
      id: 'u',
      name: 'Participant',
      role: 'user',
      budget: 1500
    }, {
      id: 'b',
      name: 'Bot',
      role: 'bot',
      budget: 2000
    }],
    auctions: [{
      id: 'a',
      seller_id: 's',
      winner_id: 'u',
      highest: 500,
      end_at: 50,
      finalized_at: null
    }],
    bids: [{
      auction_id: 'a',
      user_id: 'u',
      amount: 500
    }],
    ledger: []
  };
  const result = analyzeMarketReport(report);
  expect(result.participants[0].bids).toBe(1);
  expect(result.participants[1].cohort).toBe('bot');
  expect(result.flags).toEqual([{
    auction: 'a',
    reason: 'Seller payment pending'
  }]);
});
test('workbook keeps user text as escaped strings rather than formulas', () => {
  const xml = buildMarketWorkbook([{
    name: 'Bids',
    rows: [{
      User: '<script>&',
      Description: '=SUM(1,2)',
      Amount: 5
    }]
  }]);
  expect(xml).toContain('&lt;script&gt;&amp;');
  expect(xml).toContain('ss:Type="String">=SUM(1,2)');
  expect(xml).toContain('ss:Type="Number">5');
  expect(xml).not.toContain('ss:Formula');
});

test('report timestamps are native Excel dates in UTC, with empty pending dates and numeric amounts', () => {
  const created = Date.parse('2026-10-22T08:26:33.000Z');
  const end = created + 25 * 60000;
  const xml = buildMarketWorkbook([{ name: 'auctions', rows: [{ created_at: created, end_at: end, finalized_at: null, minimum: 50 }, { created_at: 0, end_at: end, finalized_at: end + 1000 }] }]);
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
  expect(xml).toContain('ss:Type="DateTime">2026-10-22T08:26:33.000');
  expect(xml).toContain('ss:Type="DateTime">2026-10-22T08:51:33.000');
  expect(xml).toContain('ss:Type="DateTime">1970-01-01T00:00:00.000');
  expect(xml).toContain('ss:Type="String"></Data>');
  expect(xml).toContain('created_at (UTC)');
  expect(xml).toContain('ss:Type="Number">50');
  expect(formatReportValue('created_at', created)).toBe('2026-10-22T08:26:33.000Z');
  expect(formatReportValue('finalized_at', null)).toBe('');
  expect(formatReportValue('duration_ms', 1000)).toBe(1000);
});
