import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { SSEClient } from "./sse-client.js";

describe("SSEClient", () => {
  let server: http.Server | undefined;
  let client: SSEClient | undefined;

  // Helper to create a mock SSE server
  function createMockSSEServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        resolve({ server: s, port: addr.port });
      });
    });
  }

  afterEach(() => {
    if (client) client.disconnect();
    client = undefined;
    if (server) server.close();
    server = undefined;
  });

  it("starts in connecting mode", () => {
    client = new SSEClient();
    expect(client.getMode()).toBe("connecting");
  });

  it("receives SSE message and calls pushFn", async () => {
    const received: Record<string, unknown>[] = [];
    const { server: s, port: p } = await createMockSSEServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("id: msg-1\nevent: message\ndata: {\"type\":\"x811/offer\",\"test\":true}\n\n");
      // Close the connection after sending
      setTimeout(() => res.end(), 50);
    });
    server = s;

    client = new SSEClient();
    // Use a promise that resolves once the first message is received
    const gotMessage = new Promise<void>((resolve) => {
      const origPush = (msg: Record<string, unknown>) => {
        received.push(msg);
        // Disconnect immediately after receiving first message to prevent reconnect loop
        client!.disconnect();
        resolve();
      };
      client!.connect(`http://127.0.0.1:${p}`, "did:x811:test-agent", () => "", origPush)
        .catch(() => {}); // Swallow error from disconnect
    });

    await gotMessage;

    expect(received.length).toBe(1);
    expect((received[0] as Record<string, unknown>).type).toBe("x811/offer");
    expect(client.getLastMessageAt()).toBeDefined();
  }, 10000);

  it("falls back to poll mode after max backoff attempts", async () => {
    // Server that always returns 503
    const { server: s, port: p } = await createMockSSEServer((_req, res) => {
      res.writeHead(503).end();
    });
    server = s;

    client = new SSEClient();
    // Override delays to make test fast
    (client as unknown as Record<string, unknown[]>).BACKOFF_DELAYS = [1, 1, 1, 1, 1];

    await client.connect(`http://127.0.0.1:${p}`, "did:x811:test-agent", () => "", () => {});

    expect(client.getMode()).toBe("poll");
  }, 30000);

  it("disconnect stops reconnecting", async () => {
    client = new SSEClient();
    client.disconnect();
    expect(client.getMode()).toBe("poll");
  });
});
