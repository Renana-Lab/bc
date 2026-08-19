let timer = null;
let tickMs = 5000;

const stop = () => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
};

const tick = () => {
  self.postMessage({ type: "TICK", at: Date.now() });
};

const start = () => {
  stop();
  tick();
  timer = setInterval(tick, tickMs);
  self.postMessage({ type: "STATUS", status: "running", tickMs });
};

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "CONFIG") {
    tickMs = Math.max(2500, Number(message.tickMs || tickMs));
    if (timer !== null) start();
  } else if (message.type === "START") {
    start();
  } else if (message.type === "STOP") {
    stop();
    self.postMessage({ type: "STATUS", status: "stopped", tickMs });
  } else if (message.type === "SHUTDOWN") {
    stop();
    self.close();
  }
};
