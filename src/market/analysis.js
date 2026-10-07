export function analyzeMarketReport(report) {
  const users = new Map(report.users.map(user => [user.id, user]));
  const participants = report.users.map(user => {
    const bids = report.bids.filter(b => b.user_id === user.id);
    const wins = report.auctions.filter(a => a.winner_id === user.id && a.finalized_at);
    return {
      id: user.id,
      name: user.name,
      cohort: user.role === 'bot' ? 'bot' : 'human',
      bids: bids.length,
      auctions_bid_on: new Set(bids.map(b => b.auction_id)).size,
      wins: wins.length,
      spent: wins.reduce((n, a) => n + a.highest, 0),
      available_budget: user.budget
    };
  });
  const payments = report.auctions.map(a => ({
    auction: a.id,
    description: a.description,
    seller: users.get(a.seller_id)?.name || a.seller_id,
    winner: users.get(a.winner_id)?.name || '',
    amount: a.highest,
    status: a.finalized_at ? 'finalized' : a.end_at <= report.generatedAt ? 'awaiting-finalization' : 'open',
    finalized_at: a.finalized_at,
    delay_ms: a.finalized_at ? Math.max(0, a.finalized_at - a.end_at) : ''
  }));
  const flags = payments.filter(p => p.status === 'awaiting-finalization').map(p => ({
    auction: p.auction,
    reason: 'Seller payment pending'
  }));
  for (const a of report.auctions) {
    const bids = report.bids.filter(b => b.auction_id === a.id);
    if (!bids.length) flags.push({
      auction: a.id,
      reason: 'No bids'
    });
    if (bids.some(b => b.user_id === a.seller_id)) flags.push({
      auction: a.id,
      reason: 'Seller bid detected'
    });
    if (a.finalized_at && a.highest && report.ledger.filter(l => l.auction_id === a.id && l.reason === 'seller-payment').length !== 1) flags.push({
      auction: a.id,
      reason: 'Seller payment ledger mismatch'
    });
  }
  return {
    participants,
    payments,
    flags
  };
}
