const http = require("http");
const https = require("https");

const BOTNET_PROXY_TARGET =
  process.env.BOTNET_PROXY_TARGET || "http://127.0.0.1:3002";

module.exports = function setupProxy(app) {
  app.use("/api/botnet", (req, res) => {
    const target = new URL(BOTNET_PROXY_TARGET);
    const client = target.protocol === "https:" ? https : http;
    const proxyReq = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: req.originalUrl,
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
        },
      },
      (proxyRes) => {
        res.status(proxyRes.statusCode || 500);
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          if (value !== undefined) res.setHeader(key, value);
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", () => {
      res.status(502).json({
        ok: false,
        error:
          "Botnet API is not running. Start it with npm run botnet:api, or set REACT_APP_BOTNET_API_URL to the deployed botnet API.",
      });
    });

    req.pipe(proxyReq);
  });
};
