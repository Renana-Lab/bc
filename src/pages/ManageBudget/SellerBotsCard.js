// Seller bots (Admin Zone): configures the server-side seller bots that run as a scheduled Lambda in the faucet stack.
// They create auctions only while real participants are on the site. Nothing here runs in the browser: this card only
// edits the configuration (admin wallet proof, or the faucet admin password as the fallback) and shows what the job reports.
// Payloads are write-only: the server returns byte lengths, and an empty payload field means "keep the stored one".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Checkbox, Chip, FormControlLabel, MenuItem, Switch, TextField, Typography } from "@mui/material";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { formatNative } from "../../real_ethereum/wallets/nativeBalance";
import { fetchSellerBots, saveSellerBots, stopAllSellerBots } from "../../real_ethereum/wallets/sellerBotsClient.mjs";
import { useIsAdminWallet } from "../../real_ethereum/wallets/useIsAdminWallet";
import { writeSellerBotCache } from "../../botnet/sellerBotList";
import AdminCard, { AdminRefreshButton, adminPrimaryButtonSx } from "./AdminCard";
import { useFaucetSessionPassword } from "./faucetSessionPassword";

export const DESCRIPTION_MAX_BYTES = 1200;
export const PAYLOAD_MAX_BYTES = 2000;

// UTF-8 length without TextEncoder (older jsdom has none).
export const utf8Length = (text) => {
  let total = 0;
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return total;
};

export const presenceLabel = (presence) => {
  if (!presence) return "Unknown";
  if (presence.state === "active") return presence.count === null || presence.count === undefined ? "Active" : `Active ${presence.count}`;
  if (presence.state === "idle") return "Idle";
  return "Unknown";
};

const wei = (value) => { try { return BigInt(value ?? "0"); } catch { return null; } };
export const isLowBalance = (bot) => {
  const balance = wei(bot.balanceWei);
  if (balance === null || bot.balanceWei === null || bot.balanceWei === undefined) return false;
  return balance < BigInt(Math.round(Number(bot.minNativeBalance || 0) * 1e6)) * 10n ** 12n;
};

const emptyItem = () => ({ description: "", payload: "", minimumBid: 1, durationMinutes: 5, quantity: 1, created: 0, payloadBytes: 0 });
const mono = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };
const numberField = (value, set, label, width = 120, extra = {}) => (
  <TextField size="small" label={label} value={value} onChange={(e) => set(e.target.value)} inputProps={{ "aria-label": label }} sx={{ width }} {...extra} />
);

// The editable copy: numbers as strings while typing.
const toDraft = (config) => JSON.parse(JSON.stringify(config));
const toNumber = (value) => (typeof value === "number" ? value : /^-?\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN);
const toPayload = (draft) => ({
  enabled: draft.enabled === true,
  presenceMode: draft.presenceMode,
  minActiveParticipants: toNumber(draft.minActiveParticipants),
  activeWindowMinutes: toNumber(draft.activeWindowMinutes),
  idleGraceMinutes: toNumber(draft.idleGraceMinutes),
  allowBuyerBotsOnSellerAuctions: draft.allowBuyerBotsOnSellerAuctions === true,
  bots: draft.bots.map((bot) => ({
    id: bot.id, running: bot.running === true, maxConcurrentOpen: toNumber(bot.maxConcurrentOpen), spacingSeconds: toNumber(bot.spacingSeconds), minNativeBalance: toNumber(bot.minNativeBalance),
    items: bot.items.map((item) => ({
      ...(item.slot ? { slot: item.slot } : {}), description: item.description, payload: item.payload || "", minimumBid: toNumber(item.minimumBid),
      durationMinutes: toNumber(item.durationMinutes), quantity: toNumber(item.quantity), ...(item.resetProgress ? { resetProgress: true } : {}),
    })),
  })),
});

export const SellerBotsCardBody = ({ faucetUrl = process.env.REACT_APP_FAUCET_URL, deps: depsOverride, fetchImpl, defaultOpen = true, refreshMs = 30_000 }) => {
  const deps = useMemo(() => ({ fetchSellerBots, saveSellerBots, stopAllSellerBots, ...depsOverride }), [depsOverride]);
  const symbol = getTargetNetwork().nativeCurrency?.symbol || "TEST";
  const session = useFaucetSessionPassword();
  const [password, setPassword] = useState("");
  const [state, setState] = useState(null); // last server answer { version, config, presence, lastRunAt, ... }
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [baseVersion, setBaseVersion] = useState(0); // the version the draft was made from: a save is refused when the server moved on
  const [message, setMessage] = useState("");
  const [notDeployed, setNotDeployed] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const adopt = useCallback((body, { keepDraft = false } = {}) => {
    setState(body);
    if (!keepDraft) { setDraft(toDraft(body.config)); setDirty(false); setBaseVersion(body.version); }
    // The buyer-bot runtime reads this cache to skip seller-bot auctions (never shown to participants).
    writeSellerBotCache({ addresses: body.botAddresses, allowBuyerBotsOnSellerAuctions: body.config.allowBuyerBotsOnSellerAuctions });
  }, []);
  const run = async (typed, clear, action) => {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await session.run(typed, action); }
    catch (error) {
      if (error?.code === "not_deployed") { setNotDeployed(true); setMessage(""); } else setMessage(error?.message || "Request failed.");
    } finally { clear(""); setBusy(false); }
  };
  const load = (typed = password) => run(typed, setPassword, async (auth) => {
    const body = await deps.fetchSellerBots({ faucetUrl, ...auth, fetchImpl });
    setNotDeployed(false);
    adopt(body, { keepDraft: dirtyRef.current });
    if (dirtyRef.current) setMessage("Showing live progress. Your unsaved edits are kept.");
  });
  const save = () => run(password, setPassword, async (auth) => {
    const body = await deps.saveSellerBots({ faucetUrl, ...auth, config: toPayload(draft), version: baseVersion, fetchImpl });
    setMessage("Saved.");
    const fresh = await deps.fetchSellerBots({ faucetUrl, ...auth, fetchImpl });
    adopt(fresh);
    return body;
  });
  const stopAll = () => {
    if (!window.confirm("Stop all seller bots now? No new auctions are created until you switch them on again.")) return;
    run(password, setPassword, async (auth) => {
      await deps.stopAllSellerBots({ faucetUrl, ...auth, fetchImpl });
      const fresh = await deps.fetchSellerBots({ faucetUrl, ...auth, fetchImpl });
      adopt(fresh);
      setMessage("Seller bots are stopped.");
    });
  };

  // With the admin wallet the card loads by itself; with the password it waits for "Load".
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || !faucetUrl || !(session.usesWallet || session.hasPassword)) return;
    autoLoaded.current = true;
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.usesWallet, session.hasPassword, faucetUrl]);
  useEffect(() => {
    if (!state || notDeployed) return undefined;
    const id = window.setInterval(() => { if (!document.hidden && !busy) load(""); }, refreshMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, notDeployed, busy, refreshMs]);

  const edit = (mutate) => { setDraft((current) => { const next = JSON.parse(JSON.stringify(current)); mutate(next); return next; }); setDirty(true); };
  const editBot = (index, mutate) => edit((next) => mutate(next.bots[index]));
  const progressOf = (id, slot) => state?.config?.bots?.find((bot) => bot.id === id)?.items?.find((item) => item.slot === slot);
  const botView = (id) => state?.config?.bots?.find((bot) => bot.id === id) || {};
  const presence = state?.presence;
  const canAct = (session.hasCredential || Boolean(password)) && !busy;

  return (
    <div data-testid="seller-bots-card">
      <AdminCard title="Seller bots" defaultOpen={defaultOpen} action={<AdminRefreshButton onClick={() => load("")} loading={busy} />}>
        <Typography variant="body2" color="text.secondary">
          Server-side sellers that create auctions only while participants are on the site. They run on a schedule in the faucet stack; this tab does not need to stay open.
        </Typography>
        {!faucetUrl ? <Typography variant="body2" sx={{ mt: 1 }}>The faucet URL is not configured.</Typography> : (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", mt: 1 }}>
            {session.usesWallet ? (
              <Typography variant="caption" color="text.secondary" data-testid="wallet-auth-note">Using your admin wallet.</Typography>
            ) : session.hasPassword ? (
              <Typography variant="caption" color="text.secondary">Faucet admin password saved for this session. <Button size="small" onClick={session.forget}>Forget</Button></Typography>
            ) : (
              <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Seller bots admin password" }} />
            )}
            <Button size="small" variant="outlined" onClick={() => load()} disabled={!canAct}>{state ? "Reload" : "Load seller bots"}</Button>
          </Box>
        )}
        {notDeployed ? <Typography role="status" sx={{ mt: 1 }} data-testid="seller-not-deployed">Seller bots are not deployed yet.</Typography> : null}
        {message ? <Typography role="status" variant="body2" sx={{ mt: 1 }} data-testid="seller-message">{message}</Typography> : null}

        {draft && !notDeployed ? (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
              <FormControlLabel control={<Switch checked={draft.enabled === true} onChange={(e) => edit((next) => { next.enabled = e.target.checked; })} inputProps={{ "aria-label": "Seller bots enabled" }} />} label="Seller bots enabled" />
              <Button size="small" color="error" variant="outlined" onClick={stopAll} disabled={!canAct}>Stop all</Button>
              <Chip size="small" data-testid="presence-chip" color={presence?.state === "active" ? "success" : presence?.state === "idle" ? "default" : "warning"} label={presenceLabel(presence)} />
              {state?.lastRunAt ? <Typography variant="caption" color="text.secondary">Last run {new Date(state.lastRunAt).toLocaleTimeString()}</Typography> : <Typography variant="caption" color="text.secondary">No run yet</Typography>}
            </Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center", mt: 1 }}>
              <TextField select size="small" label="Presence" value={draft.presenceMode} onChange={(e) => edit((next) => { next.presenceMode = e.target.value; })} sx={{ width: 200 }} inputProps={{ "aria-label": "Presence mode" }}>
                <MenuItem value="sweep">Only with participants</MenuItem>
                <MenuItem value="always">Always (testing)</MenuItem>
              </TextField>
              {numberField(draft.minActiveParticipants, (v) => edit((next) => { next.minActiveParticipants = v; }), "Min participants")}
              {numberField(draft.activeWindowMinutes, (v) => edit((next) => { next.activeWindowMinutes = v; }), "Window (min)")}
              {numberField(draft.idleGraceMinutes, (v) => edit((next) => { next.idleGraceMinutes = v; }), "Idle grace (min)")}
              <FormControlLabel control={<Checkbox checked={draft.allowBuyerBotsOnSellerAuctions === true} onChange={(e) => edit((next) => { next.allowBuyerBotsOnSellerAuctions = e.target.checked; })} inputProps={{ "aria-label": "Allow buyer bots on seller auctions" }} />} label="Allow buyer bots on seller-bot auctions" />
            </Box>

            {draft.bots.map((bot, botIndex) => {
              const view = botView(bot.id);
              const low = isLowBalance({ ...view, minNativeBalance: bot.minNativeBalance });
              return (
                <Box key={bot.id} sx={{ mt: 2, p: 1.5, border: "1px solid #d9deea", borderRadius: 2 }} data-testid={`seller-bot-${bot.id}`}>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
                    <Typography variant="subtitle2">{bot.id}</Typography>
                    <FormControlLabel control={<Switch size="small" checked={bot.running === true} onChange={(e) => editBot(botIndex, (b) => { b.running = e.target.checked; })} inputProps={{ "aria-label": `${bot.id} running` }} />} label="Running" />
                    <Typography variant="body2" data-testid={`balance-${bot.id}`}>
                      Balance: <strong>{view.balanceWei === null || view.balanceWei === undefined ? "—" : `${formatNative(BigInt(view.balanceWei))} ${symbol}`}</strong>
                    </Typography>
                    {low ? <Chip size="small" color="warning" label="Low balance" data-testid={`low-balance-${bot.id}`} /> : null}
                    <Typography variant="body2" color="text.secondary">Open auctions: {view.openAuctions ?? 0}</Typography>
                  </Box>
                  {view.address ? <Typography sx={mono}>{view.address}</Typography> : null}
                  {view.lastError ? <Typography variant="body2" color="error" data-testid={`last-error-${bot.id}`}>Last error: {view.lastError}{bot.running ? "" : " (paused)"}</Typography> : null}
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 1 }}>
                    {numberField(bot.spacingSeconds, (v) => editBot(botIndex, (b) => { b.spacingSeconds = v; }), "Spacing (s)", 110)}
                    {numberField(bot.maxConcurrentOpen, (v) => editBot(botIndex, (b) => { b.maxConcurrentOpen = v; }), "Max open", 100)}
                    {numberField(bot.minNativeBalance, (v) => editBot(botIndex, (b) => { b.minNativeBalance = v; }), `Min balance (${symbol})`, 150)}
                  </Box>
                  {bot.items.map((item, itemIndex) => {
                    const progress = item.slot ? progressOf(bot.id, item.slot) : null;
                    const descBytes = utf8Length(item.description);
                    const typedBytes = utf8Length(item.payload);
                    const storedBytes = item.payloadBytes || 0;
                    return (
                      <Box key={item.slot ?? `new-${itemIndex}`} sx={{ mt: 1.5, pl: 1.5, borderLeft: "3px solid #103090" }} data-testid={`item-${bot.id}-${itemIndex}`}>
                        <TextField size="small" fullWidth multiline label="Public description" value={item.description} onChange={(e) => editBot(botIndex, (b) => { b.items[itemIndex].description = e.target.value; })}
                          inputProps={{ "aria-label": `Description ${bot.id} ${itemIndex + 1}` }} error={descBytes > DESCRIPTION_MAX_BYTES}
                          helperText={<span data-testid={`desc-bytes-${bot.id}-${itemIndex}`}>{descBytes} / {DESCRIPTION_MAX_BYTES} bytes</span>} />
                        <TextField size="small" fullWidth multiline label="Data for sale (write-only)" value={item.payload} onChange={(e) => editBot(botIndex, (b) => { b.items[itemIndex].payload = e.target.value; })}
                          placeholder={storedBytes ? `Stored: ${storedBytes} bytes. Leave empty to keep.` : "Required for a new item"} sx={{ mt: 1 }}
                          inputProps={{ "aria-label": `Payload ${bot.id} ${itemIndex + 1}` }} error={typedBytes > PAYLOAD_MAX_BYTES}
                          helperText={<span data-testid={`payload-bytes-${bot.id}-${itemIndex}`}>{typedBytes ? `${typedBytes} / ${PAYLOAD_MAX_BYTES} bytes` : storedBytes ? `Stored: ${storedBytes} bytes. Leave empty to keep.` : `0 / ${PAYLOAD_MAX_BYTES} bytes`}</span>} />
                        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", mt: 1 }}>
                          {numberField(item.minimumBid, (v) => editBot(botIndex, (b) => { b.items[itemIndex].minimumBid = v; }), "Minimum bid", 120)}
                          {numberField(item.durationMinutes, (v) => editBot(botIndex, (b) => { b.items[itemIndex].durationMinutes = v; }), "Minutes", 90)}
                          {numberField(item.quantity, (v) => editBot(botIndex, (b) => { b.items[itemIndex].quantity = v; }), "Quantity", 90)}
                          <Typography variant="body2" data-testid={`progress-${bot.id}-${itemIndex}`}>{progress ? `${progress.created} / ${progress.quantity} created` : "not saved yet"}</Typography>
                          {item.slot ? <FormControlLabel control={<Checkbox size="small" checked={item.resetProgress === true} onChange={(e) => editBot(botIndex, (b) => { b.items[itemIndex].resetProgress = e.target.checked; })} inputProps={{ "aria-label": `Reset progress ${bot.id} ${itemIndex + 1}` }} />} label="Reset progress on save" /> : null}
                          <Button size="small" onClick={() => editBot(botIndex, (b) => { b.items.splice(itemIndex, 1); })}>Remove</Button>
                        </Box>
                      </Box>
                    );
                  })}
                  <Button size="small" sx={{ mt: 1 }} onClick={() => editBot(botIndex, (b) => { b.items.push(emptyItem()); })}>Add item</Button>
                </Box>
              );
            })}
            <Box sx={{ display: "flex", gap: 1, mt: 2, alignItems: "center" }}>
              <Button variant="contained" sx={adminPrimaryButtonSx} onClick={save} disabled={!canAct || !dirty}>Save</Button>
              {dirty ? <Typography variant="caption" color="text.secondary">Unsaved changes</Typography> : null}
            </Box>
          </Box>
        ) : null}
      </AdminCard>
    </div>
  );
};

// Admin Zone version: admin wallets only.
const SellerBotsCard = (props) => {
  const { isAdmin } = useIsAdminWallet({ allowlist: props.allowlist });
  return isAdmin ? <SellerBotsCardBody defaultOpen={false} {...props} /> : null;
};

export default SellerBotsCard;
