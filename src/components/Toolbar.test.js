import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ToolbarComponent from './Toolbar';
import { getDefaultBudget } from '../real_ethereum/budget';

let mockSession;
jest.mock('../Context/Context', () => ({ useMetaMask: () => mockSession }));
jest.mock('../real_ethereum/budget', () => ({
  getDefaultBudget: jest.fn(async () => '2000'),
  subscribeToBudgetChanges: () => () => {},
}));
jest.mock('../real_ethereum/ethereumProvider', () => ({ getEthereumAccounts: jest.fn(async () => []) }));
jest.mock('../real_ethereum/marketConfig', () => ({
  getActiveMarket: () => ({ id: 'live', environment: 'production', description: 'Live' }),
  getActiveFactoryAddress: () => '', getMarketOptions: () => [], subscribeToMarketChanges: () => () => {},
}));

beforeEach(() => { mockSession = { status: 'checking', account: '' }; jest.clearAllMocks(); getDefaultBudget.mockResolvedValue('2000'); });

test('budget is hidden before verification and immediately after wallet access is revoked', async () => {
  const toolbar = () => <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ToolbarComponent openDrawerHandler={() => {}} /></MemoryRouter>;
  const view = render(toolbar());
  expect(screen.queryByText('Budget:')).toBeNull();
  expect(getDefaultBudget).not.toHaveBeenCalled();
  mockSession = { status: 'connected', account: '0x1234567890abcdef1234567890abcdef12345678' };
  view.rerender(toolbar());
  await waitFor(() => expect(screen.getByText('2000')).toBeTruthy());
  expect(screen.getByText('Budget:')).toBeTruthy();
  mockSession = { status: 'locked', account: '' };
  view.rerender(toolbar());
  expect(screen.queryByText('Budget:')).toBeNull();
  expect(screen.queryByText('2000')).toBeNull();
});
