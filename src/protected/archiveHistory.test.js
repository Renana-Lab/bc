import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ArchiveHistoryPanel, { ARCHIVE_LABEL, loadArchivePage, normalizeArchiveRows } from './ArchiveHistoryPanel';
import { subscribeProtectedRevocation } from './client';

jest.mock('./client', () => ({ subscribeProtectedRevocation: jest.fn() }));
const seller = `0x${'1'.repeat(40)}`;
const winner = `0x${'2'.repeat(40)}`;
const outsider = `0x${'3'.repeat(40)}`;
const row = (overrides = {}) => ({
  archiveId: `0x${'a'.repeat(64)}`, id: `0x${'a'.repeat(64)}`, ciphertextHash: `0x${'b'.repeat(64)}`,
  seller, winner, closed: true, description: 'Legacy shoe sizes',
  source: { chainId: '11155111', factory: `0x${'4'.repeat(40)}`, auction: `0x${'5'.repeat(40)}`,
    blockNumber: '123', blockHash: `0x${'c'.repeat(64)}` },
  ...overrides,
});
const openPanel = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Archived auctions' }));
  await screen.findByText('Legacy shoe sizes');
};
let revoke;
beforeEach(() => {
  jest.clearAllMocks();
  subscribeProtectedRevocation.mockImplementation(listener => { revoke = listener; return () => {}; });
});

test('normalizes public provenance, removes plaintext/keys/finances, deduplicates source', () => {
  const original = row({ payload: 'NEVER RETAIN', wrappedKey: 'NEVER RETAIN', highestBid: '2000', budget: '2000' });
  const result = normalizeArchiveRows([original, { ...original, archiveId: `0x${'d'.repeat(64)}` }]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].source.auction).toBe(original.source.auction);
  expect(JSON.stringify(result)).not.toContain('NEVER RETAIN');
  expect(result.rows[0].highestBid).toBeUndefined();
  expect(result.rows[0].budget).toBeUndefined();
});

test('rejects active, unknown-chain, malformed and missing provenance archives', () => {
  const original = row();
  const result = normalizeArchiveRows([
    { ...original, closed: false }, { ...original, source: { ...original.source, chainId: '1' } },
    { ...original, source: { ...original.source, auction: 'javascript:alert(1)' } },
    { ...original, source: { ...original.source, blockHash: null } },
    { ...original, ciphertextHash: null }, { ...original, seller: `0x${'0'.repeat(40)}` }, null,
  ]);
  expect(result.rows).toHaveLength(0);
  expect(result.rejected).toBe(7);
});

test('collapsed panel makes no network calls; listing shows already-public notice and safe source links only', async () => {
  const load = jest.fn().mockResolvedValue({ archives: [row(), row()] });
  const release = jest.fn();
  render(<ArchiveHistoryPanel wallet={outsider} loadPage={load} releaseArchive={release} />);
  expect(load).not.toHaveBeenCalled();
  await openPanel();
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByText(`${ARCHIVE_LABEL}. Original blockchain records remain public.`)).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Archived auctions' });
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  const links = within(table).getAllByRole('link');
  expect(links[0].getAttribute('href')).toBe(`https://sepolia.etherscan.io/address/${row().source.auction}`);
  expect(links[1].getAttribute('href')).toBe(`https://sepolia.etherscan.io/block/${row().source.blockHash}`);
  for (const link of links) expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.queryByRole('button', { name: /place bid|create auction|finalize|refund|view data/i })).toBeNull();
  expect(screen.queryByText(/budget|payment status|highest bid/i)).toBeNull();
  expect(release).not.toHaveBeenCalled();
});

test.each([seller, winner])('seller/winner %s can request verified decryption, never a bid', async wallet => {
  const release = jest.fn().mockResolvedValue('Decrypted secret');
  render(<ArchiveHistoryPanel wallet={wallet} loadPage={async () => ({ archives: [row()] })} releaseArchive={release} />);
  await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'View data' }));
  await screen.findByText('Decrypted secret');
  expect(release).toHaveBeenCalledWith({ archiveId: row().archiveId, wallet,
    expectedHash: row().ciphertextHash, expectedPayloadId: row().id });
  fireEvent.click(screen.getByRole('button', { name: 'Close archived information' }));
  await waitFor(() => expect(screen.queryByText('Decrypted secret')).toBeNull());
});

test('late decryption cannot restore information after revocation or account replacement', async () => {
  let complete;
  const release = jest.fn(() => new Promise(resolve => { complete = resolve; }));
  const load = async () => ({ archives: [row()] });
  const view = render(<ArchiveHistoryPanel wallet={winner} loadPage={load} releaseArchive={release} />);
  await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'View data' }));
  act(() => revoke());
  await act(async () => complete('STALE_SECRET'));
  expect(screen.queryByText('STALE_SECRET')).toBeNull();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'View data' }));
  view.rerender(<ArchiveHistoryPanel wallet={outsider} loadPage={load} releaseArchive={release} />);
  await act(async () => complete('OTHER_WALLET_SECRET'));
  expect(screen.queryByText('OTHER_WALLET_SECRET')).toBeNull();
});

test('release failures show a generic error, never sensitive backend details', async () => {
  render(<ArchiveHistoryPanel wallet={winner} loadPage={async () => ({ archives: [row()] })}
    releaseArchive={async () => { throw new Error('SECRET KEY BACKEND TRACE'); }} />);
  await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'View data' }));
  await screen.findByText('Access could not be verified or encrypted information is unavailable. Try again.');
  expect(screen.queryByText(/SECRET KEY/)).toBeNull();
});

test('pagination deduplicates copies across pages without modifying auction state', async () => {
  const load = jest.fn().mockResolvedValueOnce({ archives: [row()], nextCursor: 'page2' })
    .mockResolvedValueOnce({ archives: [row()], nextCursor: null });
  render(<ArchiveHistoryPanel loadPage={load} />);
  await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  expect(load.mock.calls[1][0].cursor).toBe('page2');
  expect(screen.getAllByText('Legacy shoe sizes')).toHaveLength(1);
});

test('loads over 200 unique archives through opaque cursors including an empty intermediate page', async () => {
  const make = number => {
    const hex = number.toString(16);
    return row({ description: `Archived record ${number}`, archiveId: `0x${hex.padStart(64, '0')}`,
      id: `0x${hex.padStart(64, '0')}`, source: { ...row().source, auction: `0x${hex.padStart(40, '0')}` } });
  };
  const first = Array.from({ length: 100 }, (_, index) => make(index + 1));
  const second = Array.from({ length: 100 }, (_, index) => make(index + 101));
  const final = Array.from({ length: 5 }, (_, index) => make(index + 201));
  const load = jest.fn().mockResolvedValueOnce({ archives: first, nextCursor: 'opaque-page-2' })
    .mockResolvedValueOnce({ archives: second, nextCursor: 'opaque-page-3' })
    .mockResolvedValueOnce({ archives: [], nextCursor: 'opaque-page-4' })
    .mockResolvedValueOnce({ archives: [first[0], ...final], nextCursor: null });
  render(<ArchiveHistoryPanel loadPage={load} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archived auctions' }));
  await screen.findByText('Archived record 100');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Archived record 200');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Archived record 205');
  expect(screen.getAllByRole('row')).toHaveLength(206);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(load.mock.calls.map(([request]) => request.cursor)).toEqual([undefined, 'opaque-page-2', 'opaque-page-3', 'opaque-page-4']);
}, 15000);

test('empty first page with next cursor does not falsely claim no history; repeated cursor fails safely', async () => {
  const load = jest.fn().mockResolvedValueOnce({ archives: [], nextCursor: 'opaque-next' })
    .mockResolvedValueOnce({ archives: [], nextCursor: 'opaque-next' });
  render(<ArchiveHistoryPanel loadPage={load} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archived auctions' }));
  await screen.findByRole('button', { name: 'Load more' });
  expect(screen.queryByText('No archived auctions.')).toBeNull();
  expect(screen.getByText('More archive history is available.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Archive history could not be loaded. Try again.');
  expect(load).toHaveBeenCalledTimes(2);
});

test('listing errors are retryable and unmount aborts outstanding requests', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('RAW_PROVIDER_SECRET'))
    .mockResolvedValueOnce({ archives: [row()] });
  const view = render(<ArchiveHistoryPanel loadPage={load} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archived auctions' }));
  await screen.findByText('Archive history could not be loaded. Try again.');
  expect(screen.queryByText('RAW_PROVIDER_SECRET')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh archive history' }));
  await screen.findByText('Legacy shoe sizes');
  const signal = load.mock.calls[1][0].signal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

test('GET listing is no-store, encodes cursor and refuses insecure services', async () => {
  const previous = process.env.REACT_APP_PROTECTED_API_URL;
  const originalFetch = global.fetch;
  try {
    process.env.REACT_APP_PROTECTED_API_URL = 'https://protected.example';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ archives: [] }) });
    await loadArchivePage({ cursor: 'page&limit=100' });
    expect(global.fetch.mock.calls[0][0]).toBe('https://protected.example/archives?cursor=page%26limit%3D100');
    expect(global.fetch.mock.calls[0][1].cache).toBe('no-store');
    process.env.REACT_APP_PROTECTED_API_URL = 'http://untrusted.example';
    await expect(loadArchivePage()).rejects.toThrow('unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.REACT_APP_PROTECTED_API_URL;
    else process.env.REACT_APP_PROTECTED_API_URL = previous;
    global.fetch = originalFetch;
  }
});
