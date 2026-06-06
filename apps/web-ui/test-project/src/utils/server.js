const http = require("http");

function createServer(config) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: config.version }));
  });
  return server;
}

module.exports = { createServer };
