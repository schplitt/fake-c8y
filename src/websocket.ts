/**
 * Consumer WebSockets for the fake's Notification 2.0, as a stand-in for the
 * `ws` WebSocket a consumer (e.g. c8y-realtime) opens. Entry: `fake-c8y/realtime`.
 */
import type { NotificationSocket, NotificationToken, Realtime } from './realtime'
import { abortConnect, REFUSE, SOCKET_STATE } from './realtime'
import { reasonPhrase } from './reason-phrases'

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
   * Which WebSocket the events look like.
   *
   * - `'text'`: `message` carries the frame's text, `close` the code and the
   *   reason as text.
   * - `'ws'`: like the `ws` package: `message` carries the frame as a `Buffer`
   *   and `isBinary` (`false`) as second argument, `close` the code and the
   *   reason as a `Buffer`. Where the runtime has no `Buffer`, a `Uint8Array`
   *   of the UTF-8 bytes takes its place.
   * @default 'text'
   */
  flavor?: 'text' | 'ws'
  /**
   * Turns a frame's text into the `message` event's data. It wins over the
   * `flavor`'s encoding (the `ws` flavor still passes `isBinary`).
   * @default by `flavor`
   */
  encodeMessage?: (text: string) => unknown
}

/**
 * The text as the `ws` package hands it out: a `Buffer` where the runtime has
 * one, else its UTF-8 bytes.
 * @param text - The text
 */
function wsData(text: string): unknown {
  // feature-detected: isolates and browsers have no Buffer
  const buffer = Reflect.get(globalThis, 'Buffer') as { from: (text: string) => unknown } | undefined
  return buffer ? buffer.from(text) : new TextEncoder().encode(text)
}

/**
 * Creates a WebSocket class whose sockets connect to a world's Notification 2.0
 * (`world.realtime`) with a token minted by `POST /notification2/token`.
 * @param realtime - Notification 2.0 state of the world
 * @param options - Event flavor and message encoding
 * @example
 * ```ts
 * const world = createWorld()
 * const WebSocket = createFakeWebSocket(world.realtime, { flavor: 'ws' })
 * ```
 */
export function createFakeWebSocket(realtime: Realtime, options: FakeWebSocketOptions = {}): FakeWebSocketClass {
  const ws = options.flavor === 'ws'
  const encode = options.encodeMessage ?? (ws ? wsData : (text: string) => text)
  // the `ws` package's `message` listener gets `(data, isBinary)`
  const messageArgs = (text: string): unknown[] => ws ? [encode(text), false] : [encode(text)]

  class Socket implements FakeWebSocket {
    static readonly CONNECTING = SOCKET_STATE.CONNECTING
    static readonly OPEN = SOCKET_STATE.OPEN
    static readonly CLOSING = SOCKET_STATE.CLOSING
    static readonly CLOSED = SOCKET_STATE.CLOSED

    readyState: number = SOCKET_STATE.CONNECTING
    readonly url: string
    token: NotificationToken | undefined
    private listeners = new Map<string, Set<Listener>>()
    // refused and handed to an `unexpected-response` listener: still
    // CONNECTING until the caller closes it
    private refused = false

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
      // `ws` ignores addEventListener for events other than open, close,
      // error, and message: an `unexpected-response` listener added here is
      // never called and must not hold a refusal
      if (event === 'unexpected-response') {
        return
      }
      this.on(event, listener)
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      if (ws && event === 'close' && typeof args[1] === 'string') {
        // the `ws` package hands out the close reason as a Buffer
        args[1] = wsData(args[1])
      }
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args)
      }
    }

    receive(text: string): void {
      this.emit('message', ...messageArgs(text))
    }

    /**
     * The consumer acknowledges a frame by sending its ack id.
     * @param data - The ack id
     */
    send(data: unknown): void {
      realtime.acknowledge(this, String(data).trim())
    }

    ping(): void {
      realtime.touch(this)
      realtime.schedule(() => this.emit('pong'))
    }

    /**
     * Renders a refused connect (an HTTP status instead of the upgrade) like
     * the `ws` package: without an `unexpected-response` listener (always in
     * the `text` flavor) `error` and close 1006; with one, only that event,
     * and the socket stays CONNECTING until the caller closes it.
     * @param status - The HTTP status of the refusal
     */
    [REFUSE](status: number): void {
      if (ws && (this.listeners.get('unexpected-response')?.size ?? 0) > 0) {
        this.refused = true
        this.emit('unexpected-response', {}, { statusCode: status, statusMessage: reasonPhrase(status) })
        return
      }
      this.abort(`Unexpected server response: ${status}`)
    }

    private abort(message: string): void {
      abortConnect(realtime, this, message)
    }

    close(): void {
      if (this.readyState === SOCKET_STATE.CLOSED) {
        return
      }
      if (this.refused) {
        this.refused = false
        this.abort('WebSocket was closed before the connection was established')
        return
      }
      // a socket still connecting (connect() has not run) closes with 1000
      // and no error here; `ws` would emit an error and close 1006
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
