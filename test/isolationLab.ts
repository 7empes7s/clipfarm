import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { FakePlatforms } from "../server/publish/direct/fake.js";

export interface FakeProxy {
  /** The address to paste, with the sign-in when one is asked for. */
  url: string;
  /** Every tunnel opened through it, as "host:port". */
  connects: string[];
  /** Local ports of its outgoing sockets: how the fake platforms know a call came through it. */
  outPorts: Set<number>;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function closing(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
}

/** A local HTTP proxy (CONNECT tunnels only), optionally asking for a user name and password. */
export async function startProxy(auth?: { user: string; pass: string }): Promise<FakeProxy> {
  const connects: string[] = [];
  const outPorts = new Set<number>();
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    sockets.add(client);
    const wanted = auth ? `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}` : null;
    if (wanted && req.headers["proxy-authorization"] !== wanted) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const [host, port] = req.url!.split(":");
    const upstream = connect(Number(port), host!, () => {
      connects.push(req.url!);
      outPorts.add(upstream.localPort!);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  const port = await listen(server);
  const creds = auth ? `${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.pass)}@` : "";
  return { url: `http://${creds}127.0.0.1:${port}`, connects, outPorts, close: closing(server, sockets) };
}

/** The fake platforms over real HTTP, so calls can be sent through a proxy. Sets `fake.base`. */
export async function servePlatforms(fake: FakePlatforms, proxies: () => FakeProxy[]): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const viaProxy = proxies().some((p) => p.outPorts.has(req.socket.remotePort!));
      void fake.handle(new Request(`${fake.base}${req.url}`, { method: req.method, headers, body }), viaProxy).then(async (answer) => {
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
  });
  server.on("connection", (s) => sockets.add(s));
  fake.base = `http://127.0.0.1:${await listen(server)}`;
  return { close: closing(server, sockets) };
}
