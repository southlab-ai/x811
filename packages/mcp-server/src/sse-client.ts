/**
 * x811 SSE Client — Connects to the x811 server's SSE push transport.
 * Uses Node 22 native fetch() + ReadableStream (no eventsource package).
 * Falls back to poll mode after 5 consecutive failures.
 */

type SSEMode = "sse" | "poll" | "connecting" | "backoff";

export class SSEClient {
  private mode: SSEMode = "connecting";
  private lastEventId: string | undefined;
  private backoffAttempts = 0;
  private readonly MAX_BACKOFF_ATTEMPTS = 5;
  private readonly BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
  private abortController: AbortController | undefined;
  private lastMessageAt: string | undefined;
  private pushFn: ((msg: Record<string, unknown>) => void) | undefined;
  private reconnectTimeout: NodeJS.Timeout | undefined;

  /**
   * Connect to the SSE stream. Non-blocking — call with .catch() and do NOT await.
   *
   * @param serverUrl Base URL of x811 server (e.g. "https://api.x811.org")
   * @param agentDid Full DID (e.g. "did:x811:abc-123")
   * @param getAuthHeader Returns the auth token/header for the request
   * @param pushFn Called for each received message (e.g. pushToBuffer from buffer-utils)
   */
  async connect(
    serverUrl: string,
    agentDid: string,
    getAuthHeader: () => string,
    pushFn: (msg: Record<string, unknown>) => void,
  ): Promise<void> {
    this.pushFn = pushFn;
    await this._connect(serverUrl, agentDid, getAuthHeader);
  }

  private async _connect(
    serverUrl: string,
    agentDid: string,
    getAuthHeader: () => string,
  ): Promise<void> {
    this.mode = "connecting";
    this.abortController = new AbortController();

    // Extract agentId from DID: "did:x811:<uuid>" -> "<uuid>"
    const agentId = agentDid.startsWith("did:x811:")
      ? agentDid.slice("did:x811:".length)
      : agentDid;

    const url = new URL(`${serverUrl}/api/v1/messages/${encodeURIComponent(agentId)}/stream`);
    url.searchParams.set("did", agentDid);

    const headers: Record<string, string> = {
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    try {
      const auth = getAuthHeader();
      if (auth) headers["Authorization"] = auth;
    } catch { /* no auth */ }

    try {
      process.stderr.write(`[x811:sse] connecting to ${url.toString()}\n`);

      const response = await fetch(url.toString(), {
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connect failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      this.mode = "sse";
      this.backoffAttempts = 0;
      process.stderr.write(`[x811:sse] connected\n`);

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentId: string | undefined;
      let currentEvent = "message";
      let currentData: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line === "") {
            // Dispatch event on blank line
            if (currentData.length > 0 || currentEvent !== "message") {
              if (currentEvent === "message" && currentData.length > 0) {
                const dataStr = currentData.join("\n");
                try {
                  const msg = JSON.parse(dataStr) as Record<string, unknown>;
                  if (currentId) this.lastEventId = currentId;
                  this.lastMessageAt = new Date().toISOString();
                  this.pushFn?.(msg);
                  process.stderr.write(`[x811:sse] message received (type: ${msg.type ?? "unknown"})\n`);
                } catch {
                  process.stderr.write(`[x811:sse] failed to parse message data\n`);
                }
              } else if (currentEvent === "keepalive") {
                // Ignore keepalive
              } else if (currentEvent === "error") {
                process.stderr.write(`[x811:sse] server error: ${currentData.join("\n")}\n`);
              }
            }
            // Reset
            currentId = undefined;
            currentEvent = "message";
            currentData = [];
          } else if (line.startsWith("id: ")) {
            currentId = line.slice(4);
          } else if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData.push(line.slice(6));
          } else if (line.startsWith(":")) {
            // SSE comment — ignore
          }
        }
      }

      // Stream ended — schedule reconnect
      throw new Error("SSE stream ended");

    } catch (err) {
      if (this.abortController?.signal.aborted) {
        process.stderr.write(`[x811:sse] disconnected\n`);
        return; // Intentional disconnect
      }

      this.backoffAttempts++;
      if (this.backoffAttempts > this.MAX_BACKOFF_ATTEMPTS) {
        this.mode = "poll";
        process.stderr.write(`[x811:sse] fallback-to-poll (${this.MAX_BACKOFF_ATTEMPTS} failures)\n`);
        return;
      }

      const delay = this.BACKOFF_DELAYS[Math.min(this.backoffAttempts - 1, this.BACKOFF_DELAYS.length - 1)];
      this.mode = "backoff";
      process.stderr.write(`[x811:sse] reconnecting (attempt ${this.backoffAttempts}) in ${delay}ms — ${err instanceof Error ? err.message : String(err)}\n`);

      await new Promise<void>((resolve) => {
        this.reconnectTimeout = setTimeout(resolve, delay);
      });

      await this._connect(serverUrl, agentDid, getAuthHeader);
    }
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.abortController?.abort();
    this.mode = "poll"; // Fall back to poll after manual disconnect
  }

  getMode(): SSEMode { return this.mode; }
  getLastMessageAt(): string | undefined { return this.lastMessageAt; }
}
