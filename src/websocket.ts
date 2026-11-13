/**
 * Consumer WebSockets for the fake's Notification 2.0, as a stand-in for the
 * `ws` WebSocket a consumer (e.g. c8y-realtime) opens. Entry: `fake-c8y/realtime`.
 */
import type { NotificationSocket, NotificationToken, Realtime } from './realtime'
import { SOCKET_STATE } from './realtime'

type Listener = (...args: any[]) => void

/**
 * A fake consumer WebSocket bound to one world's Notification 2.0 state.
 */
export interface FakeWebSocket extends NotificationSocket {
  on: (event: string, listener: Listener) => FakeWebSocket
  addEventListener: (event: string, listener: Listener) => void
  removeAllListeners: () => FakeWebSocket
  send: (data: unknown) => void
  ping: () => void
  close: () => void
  terminate: () => void
}

/**
 * Constructor of fake consumer WebSockets.
 */
export interface FakeWebSocketClass {
  new (url: string | URL): FakeWebSocket
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

export interface FakeWebSocketOptions {
  /**
   * Turns a frame's text into the `message` event's data, e.g.
   * `(text) => Buffer.from(text)` to look like the `ws` package.
   * @default the text itself
   */
  encodeMessage?: (text: string) => unknown
}

/**
 * Creates a WebSocket class whose sockets connect to a world's Notification 2.0
 * (`world.realtime`) with a token minted by `POST /notification2/token`.
 * @param realtime - Notification 2.0 state of the world
 * @param options - Message encoding
 * @example
 * ```ts
 * const world = createWorld()
 * const WebSocket = createFakeWebSocket(world.realtime)
 * ```
 */
export function createFakeWebSocket(realtime: Realtime, options: FakeWebSocketOptions = {}): FakeWebSocketClass {
  const encode = options.encodeMessage ?? ((text: string) => text)

  class Socket implements FakeWebSocket {
    static readonly CONNECTING = SOCKET_STATE.CONNECTING
    static readonly OPEN = SOCKET_STATE.OPEN
    static readonly CLOSING = SOCKET_STATE.CLOSING
    static readonly CLOSED = SOCKET_STATE.CLOSED

    readyState: number = SOCKET_STATE.CONNECTING
    readonly url: string
    token: NotificationToken | undefined
    private listeners = new Map<string, Set<Listener>>()

    constructor(url: string | URL) {
      this.url = String(url)
      realtime.connecting.add(this)
      realtime.schedule(() => realtime.connect(this))
    }

    on(event: string, listener: Listener): this {
      let set = this.listeners.get(event)
      if (!set) {
        set = new Set()
        this.listeners.set(event, set)
      }
      set.add(listener)
      return this
    }

    addEventListener(event: string, listener: Listener): void {
      this.on(event, listener)
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args)
      }
    }

    receive(text: string): void {
      this.emit('message', encode(text))
    }

    /**
     * The consumer acknowledges a frame by sending its ack id.
     * @param data - The ack id
     */
    send(data: unknown): void {
      realtime.acknowledge(this, String(data).trim())
    }

    ping(): void {
      realtime.schedule(() => this.emit('pong'))
    }

    close(): void {
      if (this.readyState === SOCKET_STATE.CLOSED) {
        return
      }
      this.readyState = SOCKET_STATE.CLOSED
      realtime.disconnect(this)
      realtime.schedule(() => this.emit('close', 1000, ''))
    }

    terminate(): void {
      this.close()
    }
  }

  return Socket
}

/**
 * Waits until a service has finished starting up its realtime clients: no
 * request in flight, nothing scheduled, and every minted token has a connected
 * socket of its consumer (the same tenant, subscription, and subscriber: a
 * client that reconnected uses a newer token). Uses real timers; meant for
 * hosts, not isolates.
 * @param realtime - Notification 2.0 state of the world
 * @param inflight - Requests the world is answering right now
 * @param timeout - Milliseconds to wait at most
 */
export async function waitForRealtimeStartup(realtime: Realtime, inflight: () => number, timeout = 3000): Promise<void> {
  const start = Date.now()
  let quietTicks = 0
  while (quietTicks < 3 && Date.now() - start < timeout) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
    const consumer = (token: { tenant: string, subscription: string, subscriber: string }) => `${token.tenant}\u0000${token.subscription}\u0000${token.subscriber}`
    const connected = new Set([...realtime.sockets].flatMap((socket) => socket.token ? [consumer(socket.token)] : []))
    const quiet = inflight() === 0 && realtime.scheduled === 0 && [...realtime.tokens.values()].every((token) => connected.has(consumer(token)))
    quietTicks = quiet ? quietTicks + 1 : 0
  }
}
