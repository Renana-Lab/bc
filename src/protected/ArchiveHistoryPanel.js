import { memo, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Collapse, Dialog, DialogContent, DialogTitle,
  IconButton, Link, Stack, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Tooltip, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { subscribeProtectedRevocation } from './client';

export const ARCHIVE_LABEL = 'Encrypted copy of previously public information';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = `0x${'0'.repeat(40)}`;

export function normalizeArchiveRows(input) {
  if (!Array.isArray(input)) throw new Error('Invalid archive listing');
  const rows = new Map();
  let rejected = 0;
  for (const item of input) {
    const source = item?.source;
    if (!source || String(source.chainId) !== '11155111' || !ADDRESS.test(source.factory) ||
      !ADDRESS.test(source.auction) || !HASH.test(source.blockHash) || !/^\d+$/.test(String(source.blockNumber)) ||
      item.closed !== true || !ADDRESS.test(item.seller) || item.seller.toLowerCase() === ZERO ||
      !ADDRESS.test(item.winner) || !HASH.test(item.archiveId) || !HASH.test(item.id) || !HASH.test(item.ciphertextHash)) {
      rejected++; continue;
    }
    const identity = `${source.chainId}:${source.factory.toLowerCase()}:${source.auction.toLowerCase()}`;
    // Whitelist public fields: never retain payloads or wrapped keys from a response.
    if (!rows.has(identity)) rows.set(identity, {
      identity, closed: true, archiveId: item.archiveId.toLowerCase(), id: item.id.toLowerCase(),
      ciphertextHash: item.ciphertextHash.toLowerCase(),
      description: typeof item.description === 'string' ? item.description : '',
      seller: item.seller.toLowerCase(), winner: item.winner.toLowerCase(),
      source: { chainId: '11155111', factory: source.factory.toLowerCase(),
        auction: source.auction.toLowerCase(), blockHash: source.blockHash.toLowerCase(),
        blockNumber: String(source.blockNumber) },
    });
  }
  return { rows: Array.from(rows.values()), rejected };
}

export async function loadArchivePage({ signal, cursor } = {}) {
  const base = (process.env.REACT_APP_PROTECTED_API_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base)) {
    throw new Error('Protected archive is unavailable');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const response = await fetch(`${base}/archives${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Protected archive is unavailable');
    const result = await response.json();
    if (!result || !Array.isArray(result.archives) ||
        (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096))) throw new Error('Invalid archive listing');
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

const shortAddress = value => `${value.slice(0, 8)}...${value.slice(-6)}`;
const decryptArchive = async options => {
  const client = await import('./client');
  if (typeof client.decryptProtectedArchive !== 'function') throw new Error('Archive release unavailable');
  return client.decryptProtectedArchive(options);
};

function ArchiveHistoryPanel({ wallet = '', loadPage = loadArchivePage, releaseArchive = decryptArchive }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rejected, setRejected] = useState(0);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState('');
  const request = useRef(null);
  const listingEpoch = useRef(0);
  const accessEpoch = useRef(0);
  const walletId = String(wallet || '').toLowerCase();
  const currentView = view?.wallet === walletId ? view : null;

  useEffect(() => {
    accessEpoch.current++;
    setView(null); setBusy('');
    return subscribeProtectedRevocation(() => {
      accessEpoch.current++;
      setView(null); setBusy('');
    });
  }, [walletId]);
  useEffect(() => () => {
    accessEpoch.current++;
    listingEpoch.current++;
    request.current?.abort();
  }, []);

  const refresh = async (append = false) => {
    const epoch = ++listingEpoch.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await loadPage({ signal: controller.signal, cursor: append ? cursor : undefined });
      if (append && cursor && result.nextCursor === cursor) throw new Error('Archive pagination did not advance');
      const normalized = normalizeArchiveRows(result.archives);
      if (epoch !== listingEpoch.current) return;
      setRows(previous => normalizeArchiveRows(append ? [...previous, ...normalized.rows] : normalized.rows).rows);
      setRejected(previous => append ? previous + normalized.rejected : normalized.rejected);
      setCursor(result.nextCursor || null);
    } catch (_) {
      if (epoch === listingEpoch.current && !controller.signal.aborted) setError('Archive history could not be loaded. Try again.');
    } finally { if (epoch === listingEpoch.current) setLoading(false); }
  };
  const toggle = () => {
    setOpen(!open);
    if (!open && !rows.length && !loading) refresh();
  };
  const closeView = () => { accessEpoch.current++; setView(null); setBusy(''); };
  const viewData = async row => {
    const epoch = ++accessEpoch.current;
    setBusy(row.archiveId);
    setView({ archiveId: row.archiveId, wallet: walletId, text: '', error: '' });
    try {
      const text = await releaseArchive({ archiveId: row.archiveId, wallet,
        expectedHash: row.ciphertextHash, expectedPayloadId: row.id });
      if (epoch !== accessEpoch.current) return;
      if (typeof text !== 'string') throw new Error('Invalid decrypted content');
      setView({ archiveId: row.archiveId, wallet: walletId, text, error: '' });
    } catch (_) {
      if (epoch === accessEpoch.current) setView({ archiveId: row.archiveId, wallet: walletId,
        text: '', error: 'Access could not be verified or encrypted information is unavailable. Try again.' });
    } finally { if (epoch === accessEpoch.current) setBusy(''); }
  };

  return <Box component="section" aria-label="Legacy archive history" sx={{ mt: 3, borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Button onClick={toggle} aria-expanded={open} aria-controls="protected-archive-rows" endIcon={<ExpandMoreIcon sx={{ transform: open ? 'rotate(180deg)' : 'none' }} />}>
        Archived auctions
      </Button>
      {open && <Tooltip title="Refresh archive history"><span><IconButton aria-label="Refresh archive history" disabled={loading} onClick={() => refresh()}><RefreshIcon /></IconButton></span></Tooltip>}
    </Stack>
    <Collapse in={open} timeout={90}>
      <Box id="protected-archive-rows" sx={{ pb: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>{ARCHIVE_LABEL}. Original blockchain records remain public.</Typography>
        {error && <Alert severity="warning">{error}</Alert>}
        {rejected > 0 && <Alert severity="warning">Some archive records could not be verified and are not displayed.</Alert>}
        {!loading && !error && !rows.length && !cursor && <Typography variant="body2">No archived auctions.</Typography>}
        {rows.length > 0 && <TableContainer><Table size="small" aria-label="Archived auctions">
          <TableHead><TableRow><TableCell>Description</TableCell><TableCell>Original record</TableCell><TableCell>Access</TableCell></TableRow></TableHead>
          <TableBody>{rows.map(row => {
            const canView = !!walletId && (row.seller === walletId || (row.winner !== ZERO && row.winner === walletId));
            return <TableRow key={row.identity}>
              <TableCell sx={{ minWidth: 140, maxWidth: 360, overflowWrap: 'anywhere' }}>{row.description || 'Archived auction'}</TableCell>
              <TableCell><Stack spacing={0.5}>
                <Link href={`https://sepolia.etherscan.io/address/${row.source.auction}`} target="_blank" rel="noopener noreferrer" title={row.source.auction}>{shortAddress(row.source.auction)}</Link>
                <Link variant="caption" href={`https://sepolia.etherscan.io/block/${row.source.blockHash}`} target="_blank" rel="noopener noreferrer">Source block {row.source.blockNumber}</Link>
              </Stack></TableCell>
              <TableCell>{canView ? <Button size="small" disabled={!!busy} onClick={() => viewData(row)}>View data</Button> : <Typography variant="body2" color="text.secondary">Seller or winning buyer only</Typography>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table></TableContainer>}
        {loading && <Box role="status" aria-label="Loading archive history" sx={{ py: 1 }}><CircularProgress size={20} /></Box>}
        {cursor && <Stack direction="row" alignItems="center" spacing={1}><Button disabled={loading} onClick={() => refresh(true)}>Load more</Button><Typography variant="caption" color="text.secondary">More archive history is available.</Typography></Stack>}
      </Box>
    </Collapse>
    <Dialog open={!!currentView} onClose={closeView} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>Archived information<IconButton aria-label="Close archived information" onClick={closeView}><CloseIcon /></IconButton></DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary">{ARCHIVE_LABEL}</Typography>
        {busy ? <Box role="status" aria-label="Decrypting archived information" sx={{ py: 2 }}><CircularProgress size={24} /></Box> : currentView?.error ? <Alert severity="warning">{currentView.error}</Alert> : <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', maxHeight: '55vh', overflow: 'auto' }}>{currentView?.text}</Box>}
      </DialogContent>
    </Dialog>
  </Box>;
}

export default memo(ArchiveHistoryPanel);
