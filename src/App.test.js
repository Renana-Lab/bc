import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import {
  getEthereumAccounts,
  getMetaMaskErrorMessage,
  getMetaMaskProvider,
  getEthereumProvider,
  requestEthereumAccounts,
  waitForEthereumProvider,
} from './real_ethereum/ethereumProvider';

jest.mock('./real_ethereum/ethereumProvider', () => ({
  getEthereumAccounts: jest.fn(),
  getMetaMaskErrorMessage: jest.fn(),
  getMetaMaskProvider: jest.fn(),
  getEthereumProvider: jest.fn(),
  requestEthereumAccounts: jest.fn(),
  waitForEthereumProvider: jest.fn(),
}));

beforeEach(() => {
  getEthereumAccounts.mockResolvedValue([]);
  getMetaMaskErrorMessage.mockReturnValue('MetaMask is unavailable.');
  getMetaMaskProvider.mockReturnValue(null);
  getEthereumProvider.mockReturnValue(null);
  requestEthereumAccounts.mockResolvedValue([]);
  waitForEthereumProvider.mockResolvedValue(null);

  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
});

test('renders the marketplace loading shell', () => {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>
  );

  expect(
    screen.getByRole('status', { name: /loading blockchain data market/i })
  ).toBeInTheDocument();
  expect(screen.getByText(/preparing the workspace/i)).toBeInTheDocument();
});

test(
  'redirects disconnected users away from protected auction routes',
  async () => {
    render(
      <MemoryRouter
        initialEntries={['/auctions-list']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole(
        'heading',
        { name: /are you logged in to metamask/i },
        { timeout: 20000 }
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/search auctions/i)
    ).not.toBeInTheDocument();
  },
  30000
);

test(
  'keeps protected content hidden while wallet access is being verified',
  async () => {
    let resolveAccounts;
    getEthereumAccounts.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccounts = resolve;
        })
    );

    render(
      <MemoryRouter
        initialEntries={['/auctions-list']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    );

    expect(
      await screen.findByText(/verifying your metamask connection/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/search auctions/i)
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(resolveAccounts).toEqual(expect.any(Function));
    });

    await act(async () => {
      resolveAccounts([]);
    });

    expect(
      await screen.findByRole(
        'heading',
        { name: /are you logged in to metamask/i },
        { timeout: 20000 }
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/search auctions/i)
    ).not.toBeInTheDocument();
  },
  30000
);
