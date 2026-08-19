import { act, render, screen } from "@testing-library/react";
import { memo } from "react";
import { AuctionCountdown } from "../pages/AuctionsList/AuctionLiveValues";
import {
  getSharedClockDiagnostics,
  getSharedClockSnapshot,
  subscribeSharedClock,
} from "./sharedClock";

describe("shared clock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-17T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("starts only while subscribed and stops after the final unsubscribe", () => {
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = subscribeSharedClock(first);
    const unsubscribeSecond = subscribeSharedClock(second);

    expect(getSharedClockDiagnostics()).toMatchObject({
      subscribers: 2,
      running: true,
    });

    act(() => jest.advanceTimersByTime(1000));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(getSharedClockDiagnostics()).toMatchObject({
      subscribers: 0,
      running: false,
    });
  });

  test("a clock tick does not rerender the parent or a memoized static row", () => {
    const clockStart = getSharedClockSnapshot();
    jest.setSystemTime(clockStart);
    const endTime = clockStart + 5000;
    let parentRenders = 0;
    let staticRowRenders = 0;
    const StaticRow = memo(() => {
      staticRowRenders += 1;
      return <span>Static auction data</span>;
    });
    const Harness = () => {
      parentRenders += 1;
      return (
        <div>
          <StaticRow />
          <AuctionCountdown endTime={endTime} />
        </div>
      );
    };

    render(<Harness />);
    expect(screen.getByText("00:00:05")).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1000));

    expect(screen.getByText("00:00:04")).toBeInTheDocument();
    expect(parentRenders).toBe(1);
    expect(staticRowRenders).toBe(1);
  });
});
