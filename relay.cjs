const http = require("node:http");
const { fetch, ProxyAgent } = require("undici");

if (process.argv.includes("recovery-probe")) {
  if (!process.send) process.exit(2);
  process.send({ type: "c2c-recovery-probe-ready" }, () => process.exit(0));
} else if (process.argv.includes("serve")) {
  const proxy = new ProxyAgent(process.env.C2C_RELAY_PROXY_URL || "http://127.0.0.1:10809");
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/tunnel") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch("https://api.trycloudflare.com/tunnel", {
        method: "POST",
        body: Buffer.concat(chunks),
        headers: {
          "content-type": request.headers["content-type"] || "application/json",
          "user-agent": request.headers["user-agent"] || "cloudflared",
        },
        dispatcher: proxy,
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      response.end(body);
    } catch {
      response.writeHead(502, { "content-type": "application/json" }).end('{"success":false}');
    }
  });
  server.on("error", () => process.exit(1));
  server.listen(0, "127.0.0.1", () => process.send?.({ port: server.address().port }));
}
