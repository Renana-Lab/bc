# MetaMask access verification

The shared wallet session is the only source of website access. It requires an
unlocked MetaMask provider and a valid authorized account. The provider must be
the announced `io.metamask` provider, or an unambiguous legacy MetaMask provider
with an unlock-check method. Unsupported verification fails closed.

Each foreground check shares its pending promise. Verification expires after
three seconds, and the foreground loop runs every second. Disconnect, account
changes, provider changes, page suspension and cache restoration invalidate old
results. Successful rechecks preserve mounted forms. Wallet writes verify again
and reject an account/provider mismatch before forwarding a transaction.

## Repeatable checks

Run the focused regression suites:

```powershell
$env:CI='true'
npm test -- --watchAll=false --runInBand src/App.test.js src/real_ethereum/walletAccess.test.js
npm run build
```

With Playwright available to Node and Chromium/WebKit installed:

```powershell
node scripts/stress/walletAccessBrowser.js chromium
node scripts/stress/walletAccessBrowser.js webkit
```

The browser suite serves the production build on an ephemeral loopback port,
closes its server and browser afterward, blocks external requests, and submits
no transactions. It tests absent, locked, unsupported and malformed wallets on
all four protected routes, including reloads, and observes DOM insertions for
protected-content flashes. These are simulated providers, not extension tests.

## Actual macOS extension acceptance

Local results (2026-09-06): full Jest run passed 14 suites / 111 tests; the
final focused access suites passed 32 tests. CRA and Vite production builds
passed. Chromium and WebKit each passed 32 direct-link/reload denial checks,
plus verified entry and subsequent lock revocation against the final Vite build.
The final CRA main bundle is `main.5cb975c2.js`. Actual macOS extension checks
and post-deployment production/development checks remain pending.

Record macOS, Chrome, MetaMask versions and the build identifier from **Copy
connection diagnostic** on the login page. The diagnostic excludes addresses,
keys, and raw provider errors.

Test production and development separately after each receives this build:

1. Disable MetaMask completely. Open `/auctions-list`, `/open-auction`,
   `/manage-budget`, and a known auction detail URL directly. Content must not
   appear, even briefly. Repeat after reload and back/forward navigation.
2. Enable MetaMask but leave it locked, including a previously connected account.
   Repeat those direct links. Access must remain blocked.
3. Unlock MetaMask without authorizing the website. Access must remain blocked.
4. Connect the account. Enter the site and type into a form. Switch applications
   and return with the wallet still unlocked. The form must retain its input.
5. Lock or disconnect MetaMask while the protected page is visible. An observed
   event must hide content immediately; a silent lock is checked on the next
   foreground poll. Hanging verification must revoke access within three seconds
   while the browser event loop is running.
6. Repeat with another wallet extension installed. Only the selected MetaMask
   provider may authorize access. Test browser sleep/wake and a background tab.
7. Copy the diagnostic if anything fails. Verify its bundle/build identifier
   belongs to the new deployment before concluding the fix regressed.

Local automated checks do not substitute for these actual extension tests.
Do not label the Mac incident resolved until they pass. No deployment or real
macOS-extension validation was performed as part of the local implementation.

This is a website access gate. Public blockchain data remains publicly readable;
client-side code is not a server authorization boundary. Browser suspension can
delay JavaScript timers, so resume always requires fresh verification.
