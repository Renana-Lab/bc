import { analyzeMarketReport } from './analysis';
import { buildMarketWorkbook } from './reportExport';
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
