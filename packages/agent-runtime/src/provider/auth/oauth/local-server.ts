import http from "node:http";
import { URL } from "node:url";

export interface LocalCallbackServerOptions {
  port?: number;
  redirectUri: string;
  onCodeReceived: (code: string, state: string) => void;
  onError: (error: Error) => void;
}

export class LocalCallbackServer {
  private server: http.Server;
  private port!: number;

  constructor(options: LocalCallbackServerOptions) {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

      if (url.pathname === "/callback" || url.pathname === "/") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          options.onError(new Error(`OAuth error: ${error}`));
          res.writeHead(400, { "content-type": "text/html" });
          res.end(`<h1>OAuth Error</h1><p>${error}</p>`);
          return;
        }

        if (code && state) {
          options.onCodeReceived(code, state);
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<h1>Authorization successful! You may close this window.</h1>");
          setTimeout(() => this.stop(), 1000);
        } else {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<h1>Missing authorization code</h1>");
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  }

  start(): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(0, () => {
        this.port = (this.server.address() as any).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  getPort(): number { return this.port; }
}
