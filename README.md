# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)

## Automatic seller payouts

Seller payouts do not require the seller to confirm a MetaMask transaction. The contract exposes `finalizeAuctionIfNeeded()` as a public function, so a keeper wallet can pay gas and finalize ended auctions for everyone.

The repo includes a scheduled GitHub Action in `.github/workflows/auto-finalize-auctions.yml`. Add this repository secret before enabling it:

- `AUTO_FINALIZE_PRIVATE_KEY`: private key for a keeper wallet funded with Sepolia ETH for gas only.

`FACTORY_ADDRESS` is read from `src/real_ethereum/factoryAddress.js`, so keep that file updated after deploy. `RPC_URL` is optional; if it is not set, the keeper uses a public Sepolia RPC fallback. You can still add `RPC_URL` or `INFURA_KEY` as GitHub secrets if the public RPC becomes rate-limited.

The action runs every 5 minutes and can also be started manually from GitHub Actions. Locally, create `.env` with the same values and run:

```sh
yarn auto-finalize
```

For new deployments, `finalizeAuctionIfNeeded()` closes the auction and pays the seller first in one small transaction. Losing bidders can withdraw refunds themselves, and a keeper can process refunds in bounded batches later without blocking seller payment.

After changing `Campaign.sol`, compile and redeploy the factory so new auctions use the updated payout logic:

```sh
node src/real_ethereum/compile.js
node src/real_ethereum/deploy.js
```

`deploy.js` reads `DEPLOY_MNEMONIC` and `DEPLOY_RPC_URL` from `.env`, then writes the new factory address to `src/real_ethereum/factoryAddress.js`.
