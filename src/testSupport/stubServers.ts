/**
 * @file A real local HTTP stub center, for the wiring suite.
 *
 * The rest of the suite uses the in-process introspector in authTokens.ts;
 * this one is for proving the real HTTP client is what createApp gets when
 * wired from a config, headers, form body and all.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { answerFor } from "./authTokens";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Stub {
  url: string;
  calls: Recorded[];
  close(): Promise<void>;
}

type Reply = (req: Recorded) => { status: number; body: unknown };

export async function startStub(reply: Reply): Promise<Stub> {
  const calls: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      calls.push(recorded);
      const { status, body: out } = reply(recorded);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const STUB_SECRET = "stub-introspection-secret";

/** A center speaking the contract, for the tokens in authTokens.ts. */
export const startStubCenter = () =>
  startStub((req) => {
    if (req.headers["x-introspection-secret"] !== STUB_SECRET) return { status: 401, body: {} };
    const token = new URLSearchParams(req.body).get("token") ?? "";
    const answer = answerFor(token);
    if (answer.state !== "active") return { status: 200, body: { active: false } };
    const { sub, kind, scopes } = answer.identity;
    return {
      status: 200,
      body: { active: true, sub, kind, scope: scopes.join(" "), exp: Math.floor(Date.now() / 1000) + 300 },
    };
  });
