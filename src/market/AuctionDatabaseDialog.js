import React, { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Tabs, Tab, Table, TableHead, TableBody, TableRow, TableCell, LinearProgress } from '@mui/material';
import { marketApi } from './api';

export default function AuctionDatabaseDialog({ id, onClose, refresh, administrative = true }) {
  const endpoint = `${administrative ? '/admin' : ''}/auctions/${id}/record`;
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = async () => {
    const next = await marketApi(endpoint);
    setData(next);
    setDraft({ ...next.record });
  };
  useEffect(() => {
    let live = true;
    marketApi(endpoint).then(next => {
      if (live) { setData(next); setDraft({ ...next.record }); }
    }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [endpoint]);
  const run = async (action, closeAfter = false) => {
    setBusy(true); setError(''); setSaved(false);
    try {
      await action();
      await refresh();
      if (closeAfter) onClose();
      else { await load(); setSaved(true); }
    }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const rows = data && [[], data.bids, data.ledger, data.events][tab];
  const columns = [[], ['identifier', 'amount', 'cumulative', 'budget_before', 'budget_after', 'created_at'], ['user_id', 'delta', 'balance', 'reason', 'created_at'], ['type', 'actor_id', 'detail', 'created_at']][tab];
  return <Dialog open fullWidth maxWidth="md" onClose={busy ? undefined : onClose} aria-labelledby="database-title">
    <DialogTitle id="database-title">{administrative ? 'Auction database record' : 'Edit minimum bid'}</DialogTitle>
    {busy && <LinearProgress />}
    <DialogContent>
      {error && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">{administrative ? 'Database updated.' : 'Auction updated.'}</Alert>}
      {!data && !error && <p>Loading record...</p>}
      {data && <>
        {administrative && <p className="database-record-id">{id}</p>}
        {administrative && <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" allowScrollButtonsMobile>
          <Tab label="Record" /><Tab label={`Bids (${data.bids.length})`} /><Tab label="Ledger" /><Tab label="Audit history" />
        </Tabs>}
        {tab === 0 ? <form id="auction-record-form" className="database-record-form" onSubmit={event => {
          event.preventDefault();
          run(() => marketApi(endpoint, { revision: data.revision, minimum: Number(draft.minimum) }), !administrative);
        }}>
          {!data.editable && <Alert severity="info">This record is read-only because bidding has started or the auction has ended.</Alert>}
          {administrative && <TextField label="Seller identifier" value={data.seller_identifier} InputProps={{ readOnly: true }} />}
          {administrative && <TextField label="Description" value={draft.description} InputProps={{ readOnly: true }} />}
          {administrative && <TextField label="Data payload" value={draft.payload} multiline minRows={3} InputProps={{ readOnly: true }} />}
          <TextField label="Original minimum bid" type="number" value={draft.original_minimum ?? draft.minimum} InputProps={{ readOnly: true }} />
          <TextField label="Adjusted minimum bid" type="number" value={draft.minimum} onChange={e => setDraft({ ...draft, minimum: e.target.value })} disabled={busy || !data.editable} required inputProps={{ min: 1, max: 1000000000, step: 1 }} />
          {administrative && <TextField label="Closing time" value={new Date(draft.end_at).toLocaleString()} InputProps={{ readOnly: true }} />}
        </form> : <div className="database-table-scroll"><Table size="small"><TableHead><TableRow>{columns.map(col => <TableCell key={col}>{col.replaceAll('_', ' ')}</TableCell>)}</TableRow></TableHead><TableBody>
          {rows.map((row, index) => <TableRow key={row.id ?? index}>{columns.map(col => <TableCell key={col}>{col === 'created_at' ? new Date(row[col]).toLocaleString() : String(row[col] ?? '-')}</TableCell>)}</TableRow>)}
          {!rows.length && <TableRow><TableCell colSpan={columns.length}>No records.</TableCell></TableRow>}
        </TableBody></Table></div>}
      </>}
    </DialogContent>
    <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
      {tab === 0 && data?.editable && <Button variant="contained" type="submit" form="auction-record-form" disabled={busy}>{administrative ? 'Save changes' : 'Save'}</Button>}
      <Button disabled={busy} onClick={onClose}>{administrative ? 'Done' : 'Discard'}</Button>
    </DialogActions>
  </Dialog>;
}
