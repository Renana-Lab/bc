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
  const run = async (action) => {
    setBusy(true); setError(''); setSaved(false);
    try { await action(); await load(); await refresh(); setSaved(true); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const rows = data && [[], data.bids, data.ledger, data.events][tab];
  const columns = [[], ['identifier', 'amount', 'cumulative', 'budget_before', 'budget_after', 'created_at'], ['user_id', 'delta', 'balance', 'reason', 'created_at'], ['type', 'actor_id', 'detail', 'created_at']][tab];
  return <Dialog open fullWidth maxWidth="md" onClose={busy ? undefined : onClose} aria-labelledby="database-title">
    <DialogTitle id="database-title">{administrative ? 'Auction database record' : 'Edit your auction'}</DialogTitle>
    {busy && <LinearProgress />}
    <DialogContent>
      {error && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">{administrative ? 'Database updated.' : 'Auction updated.'}</Alert>}
      {!data && !error && <p>Loading record...</p>}
      {data && <>
        <p className="database-record-id">{id}</p>
        {administrative && <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" allowScrollButtonsMobile>
          <Tab label="Record" /><Tab label={`Bids (${data.bids.length})`} /><Tab label="Ledger" /><Tab label="Audit history" />
        </Tabs>}
        {tab === 0 ? <form id="auction-record-form" className="database-record-form" onSubmit={event => {
          event.preventDefault();
          run(() => marketApi(endpoint, administrative ? {
            revision: data.revision, description: draft.description, payload: draft.payload,
            minimum: Number(draft.minimum), end_at: Number(draft.end_at)
          } : { revision: data.revision, minimum: Number(draft.minimum) }));
        }}>
          {!data.editable && <Alert severity="info">This record is read-only because bidding has started or the auction has ended.</Alert>}
          <TextField label="Seller identifier" value={data.seller_identifier} InputProps={{ readOnly: true }} />
          <TextField label="Description" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} disabled={busy || !data.editable || !administrative} required inputProps={{ maxLength: 300 }} />
          {administrative && <TextField label="Data payload" value={draft.payload} onChange={e => setDraft({ ...draft, payload: e.target.value })} multiline minRows={3} disabled={busy || !data.editable} required inputProps={{ maxLength: 50000 }} />}
          <TextField label="Minimum bid (credits)" type="number" value={draft.minimum} onChange={e => setDraft({ ...draft, minimum: e.target.value })} disabled={busy || !data.editable} required inputProps={{ min: 1, max: 1000000000, step: 1 }} />
          <TextField label="Closing time" type="datetime-local" InputLabelProps={{ shrink: true }} value={new Date(draft.end_at - new Date(draft.end_at).getTimezoneOffset() * 60000).toISOString().slice(0, 19)} onChange={e => { const time = new Date(e.target.value).getTime(); if (Number.isFinite(time)) setDraft({ ...draft, end_at: time }); }} disabled={busy || !data.editable || !administrative} inputProps={{ step: 1 }} required />
        </form> : <div className="database-table-scroll"><Table size="small"><TableHead><TableRow>{columns.map(col => <TableCell key={col}>{col.replaceAll('_', ' ')}</TableCell>)}</TableRow></TableHead><TableBody>
          {rows.map((row, index) => <TableRow key={row.id ?? index}>{columns.map(col => <TableCell key={col}>{col === 'created_at' ? new Date(row[col]).toLocaleString() : String(row[col] ?? '-')}</TableCell>)}</TableRow>)}
          {!rows.length && <TableRow><TableCell colSpan={columns.length}>No records.</TableCell></TableRow>}
        </TableBody></Table></div>}
      </>}
    </DialogContent>
    <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
      <Button disabled={busy} onClick={() => run(load)}>Reload record</Button>
      {administrative && data && !data.record.finalized_at && <Button color="warning" disabled={busy} onClick={() => {
        const open = data.record.end_at > Date.now();
        if (window.confirm(open ? 'Close bidding immediately?' : 'Finalize this auction and credit the seller?')) run(() => marketApi(open ? `/admin/auctions/${id}/close` : `/auctions/${id}/finalize`, {}));
      }}>{data.record.end_at > Date.now() ? 'Close auction' : 'Finalize payment'}</Button>}
      {tab === 0 && data?.editable && <Button variant="contained" type="submit" form="auction-record-form" disabled={busy}>Save changes</Button>}
      <Button disabled={busy} onClick={onClose}>Done</Button>
    </DialogActions>
  </Dialog>;
}
