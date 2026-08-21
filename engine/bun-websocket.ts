type BunWebSocketConstructor = {
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

// TypeScript's DOM WebSocket constructor wins overload resolution when the DOM
// lib is enabled alongside bun-types. Bun supports this options overload at
// runtime, so keep the compatibility cast in one audited adapter.
// SAFETY: this module runs under Bun, whose global WebSocket implements this
// constructor overload even though the merged DOM declaration omits it.
const BunWebSocket = WebSocket as BunWebSocketConstructor;

export function createBunWebSocket(url: string | URL, options?: Bun.WebSocketOptions): WebSocket {
  return new BunWebSocket(url, options);
}
