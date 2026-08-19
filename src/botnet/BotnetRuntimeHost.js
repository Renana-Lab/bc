import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { BOTNET_STATE_EVENT, LOCAL_BOTS_KEY } from "../telemetry/botPresence";
import { hasRunningBrowserBots } from "./botRuntimeState";
import { BOT_SCHEDULER_TICK_EVENT } from "./runtimeEvents";

const BotnetRuntime = lazy(() =>
  import("../pages/ManageBudget/BotnetControlPanel.js"),
);

const runtimeIsActive = () =>
  typeof window !== "undefined" &&
  hasRunningBrowserBots(window.localStorage, LOCAL_BOTS_KEY);

const BotnetRuntimeHost = () => {
  const [active, setActive] = useState(runtimeIsActive);
  const workerRef = useRef(null);
  const tickMs = useMemo(
    () => Math.max(2500, Number(process.env.REACT_APP_BOT_SCHEDULER_TICK_MS || 5000)),
    [],
  );

  useEffect(() => {
    const sync = () => setActive(runtimeIsActive());
    const handleStorage = (event) => {
      if (!event.key || event.key === LOCAL_BOTS_KEY) sync();
    };
    window.addEventListener(BOTNET_STATE_EVENT, sync);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(BOTNET_STATE_EVENT, sync);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;

    const workerUrl = `${process.env.PUBLIC_URL || ""}/botScheduler.worker.js`;
    const worker = new Worker(workerUrl);
    workerRef.current = worker;
    worker.onmessage = (event) => {
      if (event.data?.type === "TICK") {
        window.dispatchEvent(
          new CustomEvent(BOT_SCHEDULER_TICK_EVENT, { detail: event.data }),
        );
      }
    };
    worker.postMessage({ type: "CONFIG", tickMs });
    worker.postMessage({ type: "START" });

    return () => {
      worker.postMessage({ type: "SHUTDOWN" });
      worker.terminate();
      workerRef.current = null;
    };
  }, [active, tickMs]);

  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <BotnetRuntime headless schedulerEnabled externalScheduler />
    </Suspense>
  );
};

export default BotnetRuntimeHost;
