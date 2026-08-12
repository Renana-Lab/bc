import http from "node:http";
import https from "node:https";
import { defineConfig, loadEnv, transformWithEsbuild } from "vite";
import react from "@vitejs/plugin-react";

const treatSourceJavaScriptAsJsx = () => ({
  name: "treat-source-javascript-as-jsx",
  enforce: "pre",
  async transform(code, id) {
    if (!/\/src\/.*\.js$/.test(id.replace(/\\/g, "/"))) return null;

    return transformWithEsbuild(code, id, {
      loader: "jsx",
      jsx: "automatic",
    });
  },
});

const botnetProxy = (targetUrl) => ({
  name: "botnet-proxy",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/api/botnet")) {
        next();
        return;
      }

      const target = new URL(targetUrl);
      const client = target.protocol === "https:" ? https : http;
      const proxyRequest = client.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: request.url,
          method: request.method,
          headers: {
            ...request.headers,
            host: target.host,
          },
        },
        (proxyResponse) => {
          response.writeHead(proxyResponse.statusCode || 500, proxyResponse.headers);
          proxyResponse.pipe(response);
        }
      );

      proxyRequest.on("error", () => {
        if (response.headersSent) return;

        response.writeHead(502, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error: "Botnet API is not running. Start it with npm run botnet:api.",
          })
        );
      });

      request.pipe(proxyRequest);
    });
  },
});

const clientEnvironment = (environment) => {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.startsWith("REACT_APP_"))
  );
};

export default defineConfig(({ mode }) => {
  const loadedEnvironment = loadEnv(mode, process.cwd(), "");
  const environment = clientEnvironment(loadedEnvironment);
  const botnetTarget =
    process.env.BOTNET_PROXY_TARGET ||
    loadedEnvironment.BOTNET_PROXY_TARGET ||
    "http://127.0.0.1:3002";

  return {
    plugins: [treatSourceJavaScriptAsJsx(), react(), botnetProxy(botnetTarget)],
    define: {
      global: "globalThis",
      "process.env": JSON.stringify({
        ...environment,
        NODE_ENV: mode === "production" ? "production" : "development",
        PUBLIC_URL: "",
      }),
    },
    esbuild: {
      loader: "jsx",
      include: /src\/.*\.js$/,
    },
    optimizeDeps: {
      esbuildOptions: {
        loader: {
          ".js": "jsx",
        },
      },
    },
    server: {
      host: true,
      port: 3000,
      open: process.env.BROWSER !== "none",
    },
  };
});
