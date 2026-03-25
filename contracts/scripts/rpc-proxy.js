const http = require("http");
const https = require("https");

const TARGET_HOST = process.env.MEGAETH_RPC_HOST || "carrot.megaeth.com";
const TARGET_PATH = process.env.MEGAETH_RPC_PATH || "/rpc";
const LISTEN_PORT = Number(process.env.MEGAETH_PROXY_PORT || 18545);
const TARGET_IPS = (process.env.MEGAETH_RPC_IPS || "104.18.9.172,104.18.8.172")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!TARGET_IPS.length) {
  throw new Error("MEGAETH_RPC_IPS is empty");
}

let nextIpIndex = 0;

function forwardToUpstream(ip, req, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: TARGET_HOST };
    delete headers.connection;
    headers["content-length"] = Buffer.byteLength(body);

    const options = {
      host: ip,
      port: 443,
      method: req.method || "POST",
      path: req.url && req.url !== "/" ? req.url : TARGET_PATH,
      headers,
      servername: TARGET_HOST,
      timeout: 20000,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        resolve({
          statusCode: upstreamRes.statusCode || 502,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("Upstream timeout"));
    });
    upstreamReq.on("error", (error) => {
      reject(error);
    });
    upstreamReq.end(body);
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    let lastError = null;

    for (let offset = 0; offset < TARGET_IPS.length; offset += 1) {
      const index = (nextIpIndex + offset) % TARGET_IPS.length;
      const ip = TARGET_IPS[index];
      try {
        const upstream = await forwardToUpstream(ip, req, body);
        nextIpIndex = (index + 1) % TARGET_IPS.length;

        if (upstream.headers["content-type"]) {
          res.setHeader("content-type", upstream.headers["content-type"]);
        }
        res.statusCode = upstream.statusCode;
        res.end(upstream.body);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "RPC proxy upstream failed",
        detail: lastError ? String(lastError.message || lastError) : "Unknown error",
      })
    );
  });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `MegaETH RPC proxy listening on http://127.0.0.1:${LISTEN_PORT}${TARGET_PATH} -> ${TARGET_HOST} (${TARGET_IPS.join(
      ", "
    )})`
  );
});
