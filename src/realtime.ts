/**
 * Notification 2.0 in the fake tenant: subscriptions, tokens, and consumer
 * WebSockets (in memory). Data changes are published to matching
 * subscriptions as frames in the platform's format:
 *
 * ```
 * <ackId>
 * /<tenant>/<api>/<sourceId>
 * CREATE | UPDATE | DELETE
 *
 * <JSON payload>
 * ```
 *
 * Subscriptions and tokens are tenant data (`TenantData.notificationSubscriptions`,
 * `TenantData.notificationTokens`): they fork, reset, snapshot, and diff with
 * the rest of the data. `Realtime` keeps what is not data: the consumer
 * sockets and the frames on their way. `world.reset()` and `world.restore()`
 * drop undelivered frames and close the sockets whose token is gone.
 * The consumer WebSocket is in `./websocket` (the `fake-c8y/realtime` entry).
 */
import type { StoredDocument } from './store'

export type RealtimeApi = 'managedobjects' | 'measurements' | 'events' | 'alarms' | 'operations'

/**
 * Notification 2.0 subscription as stored by the fake.
 */
export interface NotificationSubscription {
  id: string
  tenant: string
  context: 'mo' | 'tenant'
  subscription: string
  source?: { id: string }
  subscriptionFilter?: { apis?: string[], typeFilter?: string }
  fragmentsToCopy?: string[]
  nonPersistent?: boolean
}

export interface NotificationToken {
  tenant: string
  subscription: string
  subscriber: string
}

export interface NotificationFrame {
  ackId: string
  text: string
}

/**
 * Standard properties, which `fragmentsToCopy` always keeps (verified for
 * events; assumed for the other APIs).
 */
const STANDARD_FIELDS = new Set(['id', 'self', 'type', 'text', 'time', 'source', 'creationTime', 'lastUpdated', 'severity', 'status', 'count', 'firstOccurrenceTime', 'deviceId', 'deviceName', 'description', 'failureReason', 'name', 'owner'])

/**
 * With `fragmentsToCopy`, the platform delivers only the named fragments next
 * to the standard properties.
 * @param document - The rendered object
 * @param fragments - The subscription's `fragmentsToCopy`
 */
function copyFragments(document: StoredDocument, fragments: string[] | undefined): StoredDocument {
  if (!fragments || fragments.length === 0) {
    return document
  }
  return Object.fromEntries(Object.entries(document).filter(([key]) => STANDARD_FIELDS.has(key) || fragments.includes(key))) as StoredDocument
}

function typesOf(typeFilter: unknown): string[] | undefined {
  if (typeof typeFilter !== 'string' || !typeFilter) {
    return undefined
  }
  const quoted = [...typeFilter.matchAll(/'([^']*)'/g)].map((match) => match[1]!)
  return quoted.length > 0 ? quoted : typeFilter.split(/\s+or\s+/).map((type) => type.trim())
}

/**
 * A consumer WebSocket connected to the fake (see `fake-c8y/realtime`).
 */
export interface NotificationSocket {
  readonly url: string
  readyState: number
  token: NotificationToken | undefined
  emit: (event: string, ...args: unknown[]) => void
  /**
   * Emits a delivered frame as a `message` event.
   */
  receive: (text: string) => void
  /**
   * Closes the socket (e.g. when its consumer is unsubscribed).
   */
  close: () => void
}

/**
 * WebSocket ready states.
 */
export const SOCKET_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

export interface RealtimeOptions {
  /**
   * Runs a callback later (frame delivery, socket events).
   * @default (callback) => setTimeout(callback, 0)
   */
  schedule?: (callback: () => void) => void
  /**
   * Requests the world is answering right now (handlers may still publish).
   */
  inflight?: () => number
  /**
   * The stored subscriptions of all tenants (the world's tenant data).
   * @default none
   */
  subscriptions?: () => Iterable<NotificationSubscription>
  /**
   * The stored tokens of all tenants, by token value (the world's tenant data).
   * @default none
   */
  tokens?: () => Iterable<[string, NotificationToken]>
}

/**
 * Notification 2.0 of one world: consumer sockets and frames on their way.
 * Subscriptions and tokens are read from the world's tenant data.
 */
export class Realtime {
  nextAck = 1
  sockets: Set<NotificationSocket> = new Set()
  /**
   * sockets created whose connect has not run yet
   */
  connecting: Set<NotificationSocket> = new Set()
  /**
   * frames waiting for a consumer of a subscription name (persistent subscriptions)
   */
  backlog: Map<string, NotificationFrame[]> = new Map()
  /**
   * delivered but not yet acknowledged frames, per socket
   */
  unacked: Map<NotificationSocket, Set<string>> = new Map()
  /**
   * frames scheduled for delivery
   */
  scheduled = 0
  readonly schedule: (callback: () => void) => void
  private readonly inflight: () => number
  private readonly storedSubscriptions: () => Iterable<NotificationSubscription>
  private readonly storedTokens: () => Iterable<[string, NotificationToken]>
  /**
   * Bumped by `dropPending()`: frames scheduled before are not delivered.
   */
  private generation = 0

  constructor(options: RealtimeOptions = {}) {
    this.schedule = options.schedule ?? ((callback) => {
      setTimeout(callback, 0)
    })
    this.inflight = options.inflight ?? (() => 0)
    this.storedSubscriptions = options.subscriptions ?? (() => [])
    this.storedTokens = options.tokens ?? (() => [])
  }

  /**
   * The stored subscriptions of all tenants (a copy of the list).
   */
  get subscriptions(): NotificationSubscription[] {
    return [...this.storedSubscriptions()]
  }

  /**
   * The stored tokens of all tenants, by token value (a copy of the map).
   */
  get tokens(): Map<string, NotificationToken> {
    return new Map(this.storedTokens())
  }

  connect(socket: NotificationSocket): void {
    this.connecting.delete(socket)
    const token = this.tokens.get(new URL(socket.url).searchParams.get('token') ?? '')
    if (!token || socket.readyState === SOCKET_STATE.CLOSED) {
      socket.readyState = SOCKET_STATE.CLOSED
      socket.emit('error', new Error('Invalid notification token'))
      socket.emit('close', 1008, 'invalid token')
      return
    }
    socket.token = token
    socket.readyState = SOCKET_STATE.OPEN
    this.sockets.add(socket)
    this.unacked.set(socket, new Set())
    socket.emit('open')
    const waiting = this.backlog.get(this.key(token.tenant, token.subscription)) ?? []
    this.backlog.delete(this.key(token.tenant, token.subscription))
    for (const frame of waiting) {
      this.deliver(socket, frame)
    }
  }

  disconnect(socket: NotificationSocket): void {
    this.connecting.delete(socket)
    this.sockets.delete(socket)
    this.unacked.delete(socket)
  }

  acknowledge(socket: NotificationSocket, ackId: string): void {
    this.unacked.get(socket)?.delete(ackId)
  }

  key(tenant: string, subscription: string): string {
    return `${tenant}\u0000${subscription}`
  }

  deliver(socket: NotificationSocket, frame: NotificationFrame): void {
    const generation = this.generation
    this.scheduled++
    this.schedule(() => {
      if (generation !== this.generation) {
        // dropped by dropPending(), which already reset `scheduled`
        return
      }
      this.scheduled--
      if (socket.readyState !== SOCKET_STATE.OPEN) {
        return
      }
      this.unacked.get(socket)?.add(frame.ackId)
      socket.receive(frame.text)
    })
  }

  /**
   * Publishes a data change to every matching subscription.
   * @param tenant - Tenant of the data
   * @param api - Notification API, e.g. `measurements`
   * @param action - CREATE, UPDATE, or DELETE
   * @param document - The rendered object (for DELETE: `{ id }` plus its source)
   * @param sourceId - Device id the notification is about
   * @param subscriptions - The tenant's subscriptions (default: the stored ones)
   */
  publish(tenant: string, api: RealtimeApi, action: 'CREATE' | 'UPDATE' | 'DELETE', document: StoredDocument, sourceId: string | undefined, subscriptions: Iterable<NotificationSubscription> = this.storedSubscriptions()): void {
    const names = new Map<string, NotificationSubscription>()
    for (const subscription of subscriptions) {
      if (subscription.tenant !== tenant) {
        continue
      }
      const apis = Array.isArray(subscription.subscriptionFilter?.apis) ? subscription.subscriptionFilter.apis : ['*']
      if (!apis.includes('*') && !apis.includes(api)) {
        continue
      }
      if (subscription.context === 'mo' && subscription.source?.id !== sourceId) {
        continue
      }
      const types = typesOf(subscription.subscriptionFilter?.typeFilter)
      if (types && !types.includes(String(document.type))) {
        continue
      }
      names.set(subscription.subscription, subscription)
    }
    for (const [name, subscription] of names) {
      const ackId = String(this.nextAck++)
      // verified: a DELETE notification's payload is not JSON but an opaque
      // object string; the deleted object's id is only in the description
      const payload = action === 'DELETE'
        ? `com.cumulocity.notification.service.RealtimeDeletedObject$1@${(this.nextAck * 2654435761 >>> 0).toString(16)}`
        : JSON.stringify(copyFragments(document, subscription.fragmentsToCopy))
      const frame: NotificationFrame = {
        ackId,
        text: `${ackId}\n/${tenant}/${api}/${sourceId ?? document.id}\n${action}\n\n${payload}`,
      }
      const consumers = [...this.sockets].filter((socket) => socket.token?.tenant === tenant && socket.token.subscription === name)
      if (consumers.length > 0) {
        for (const socket of consumers) {
          this.deliver(socket, frame)
        }
      } else {
        if (!subscription.nonPersistent) {
          const key = this.key(tenant, name)
          this.backlog.set(key, [...(this.backlog.get(key) ?? []), frame])
        }
      }
    }
  }

  /**
   * Notifications on their way to a consumer or not yet acknowledged.
   */
  pending(): number {
    let count = this.scheduled + this.inflight()
    for (const acks of this.unacked.values()) {
      count += acks.size
    }
    // backlog of subscriptions a consumer has a token for (it is connecting)
    const tokens = [...this.storedTokens()].map(([, token]) => token)
    for (const [key, frames] of this.backlog) {
      const [tenant, subscription] = key.split('\u0000')
      if (tokens.some((token) => token.tenant === tenant && token.subscription === subscription)) {
        count += frames.length
      }
    }
    return count
  }

  /**
   * Drops undelivered notifications, also the ones already scheduled (data
   * reset between tests).
   */
  dropPending(): void {
    this.generation++
    this.scheduled = 0
    this.backlog.clear()
    for (const acks of this.unacked.values()) {
      acks.clear()
    }
  }

  /**
   * Drops undelivered notifications and closes the sockets whose token is
   * no longer stored (after the data was reset or restored).
   */
  resync(): void {
    this.dropPending()
    const tokens = new Map(this.storedTokens())
    for (const socket of [...this.sockets]) {
      const value = new URL(socket.url).searchParams.get('token') ?? ''
      if (tokens.get(value) === undefined) {
        this.disconnect(socket)
        socket.readyState = SOCKET_STATE.CLOSED
        socket.emit('close', 1000, '')
      }
    }
  }

  /**
   * Closes every socket and drops undelivered notifications.
   */
  clear(): void {
    for (const socket of this.sockets) {
      socket.readyState = SOCKET_STATE.CLOSED
      socket.emit('close', 1000, '')
    }
    this.sockets.clear()
    this.connecting.clear()
    this.unacked.clear()
    this.dropPending()
  }
}
