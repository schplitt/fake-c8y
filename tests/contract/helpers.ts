/**
 * Contract scenarios for the fake Cumulocity platform.
 *
 * Each scenario talks to "a Cumulocity tenant" through the real \@c8y/client
 * and asserts platform behavior the fake emulates. They run against the fake
 * in CI (tests/contract/fake.test.ts). They only use a `Client` and create
 * their own uniquely named data, so the same scenarios can later run against a
 * real tenant to verify the fake. When a scenario fails there, the fake is
 * wrong.
 */
import type { Client } from '@c8y/client'
import type { RealtimeClient } from 'c8y-realtime'

export interface ContractContext {
  client: Client
  /**
   * Unique per scenario run, to keep data apart on a shared tenant.
   */
  unique: string
  /**
   * Tenant id of the credentials.
   */
  tenant: string
  /**
   * A c8y-realtime client for the same tenant and user (closed after the
   * scenario). Against the fake it uses the fake tenant's WebSocket.
   */
  realtime: () => RealtimeClient
  /**
   * Opens a raw Notification 2.0 consumer socket with a token and records
   * what happens (closed after the scenario). Resolves once the socket opened
   * or the connect failed.
   */
  socket: (token: string) => Promise<RawSocket>
  /**
   * Waits for a write the platform applies asynchronously before asserting
   * that nothing changed (a negative wait). The fake applies writes at once,
   * so its runner shortens the wait.
   */
  settle: (ms: number) => Promise<void>
}

/**
 * A consumer socket without a client library on top, so a scenario sees
 * refused connects, close codes, and frames as they are.
 */
export interface RawSocket {
  token: string
  opened: boolean
  /**
   * HTTP status of a refused connect, where the transport shows it.
   */
  refused?: number
  /**
   * Frame texts, in arrival order.
   */
  messages: string[]
  closes: Array<[code: number, reason: string]>
  send: (text: string) => void
  close: () => void
}

/**
 * The parts of a WebSocket (`ws` or the fake's `ws` flavor) that `openSocket()` uses.
 */
export interface EventSocket {
  on: (event: string, listener: (...args: any[]) => void) => unknown
  send: (data: string) => void
  close: () => void
  terminate: () => void
}

/**
 * Opens a consumer socket for a token and records its events. The socket is
 * added to `sockets` at once, so a connect that never resolves is still
 * closed by the caller's cleanup. Resolves once it opened or closed.
 * @param WebSocket - A `ws`-like WebSocket constructor
 * @param baseUrl - The tenant's base URL
 * @param token - A token of `POST /notification2/token`
 * @param sockets - The caller's cleanup list
 */
export function openSocket(WebSocket: new (url: string) => EventSocket, baseUrl: string, token: string, sockets: RawSocket[]): Promise<RawSocket> {
  // the consumer URL, built like c8y-realtime does
  const url = `${baseUrl.replace(/\/+$/, '')}/notification2/consumer/?${new URLSearchParams({ token })}`
  const socket = new WebSocket(url.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://'))
  const raw: RawSocket = {
    token,
    opened: false,
    messages: [],
    closes: [],
    send: (text) => socket.send(text),
    close: () => socket.close(),
  }
  sockets.push(raw)
  return new Promise((resolve) => {
    // with this listener, ws leaves a refused upgrade to the caller
    socket.on('unexpected-response', (_request: unknown, response: { statusCode: number }) => {
      raw.refused = response.statusCode
      socket.terminate()
    })
    socket.on('open', () => {
      raw.opened = true
      resolve(raw)
    })
    socket.on('message', (data: unknown) => {
      raw.messages.push(String(data))
    })
    socket.on('close', (code: number, reason: unknown) => {
      raw.closes.push([code, String(reason)])
      resolve(raw)
    })
    // a failed connect also emits an error; its close is recorded
    socket.on('error', () => {})
  })
}

export interface ContractScenario {
  name: string
  /**
   * Ids of the platform behaviors this scenario checks, as listed in
   * docs/platform-behavior.md (tests/unit/platform-behavior.test.ts
   * keeps the list and the scenarios in sync).
   */
  verifies?: string[]
  run: (context: ContractContext) => Promise<void>
}

export async function rejection(promise: Promise<unknown>): Promise<{ res: { status: number }, data?: { error?: string } }> {
  try {
    await promise
  } catch (error) {
    return error as { res: { status: number }, data?: { error?: string } }
  }
  throw new Error('expected the request to fail')
}

/**
 * Retries an assertion for a few seconds: some platform writes (bulk deletes)
 * apply asynchronously on a real tenant. The fake applies them immediately.
 * @param assertion
 * @param timeout
 */
export async function eventually(assertion: () => Promise<void>, timeout = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      return await assertion()
    } catch (error) {
      if (Date.now() - start > timeout) {
        throw error
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250)
      })
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const time = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 10, minutes)).toISOString()
