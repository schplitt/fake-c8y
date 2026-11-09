# Generated measurement history

Stored measurements cost about 580 bytes each, so a month of history for a large world does not fit in memory. A measurement generator describes the history instead, and the world computes the documents when a request reads them:

```ts
const { measurementGenerators: [temperature] } = world.seed({
  measurementGenerators: [{
    source: pump,
    type: 'c8y_Temperature',
    from: '2026-09-24T00:00:00Z',
    to: '2026-10-24T00:00:00Z', // leave it out for a live generator
    interval: '5m', // s, m, h, or d
    series: [
      { fragment: 'c8y_Temperature', series: 'T', unit: 'C', value: { base: 21, dailyAmplitude: 3, noise: 0.5 } },
      { fragment: 'c8y_Temperature', series: 'T2', unit: 'C', value: (time) => 20 + (time % 7), gaps: [{ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }] },
    ],
  }],
})
```

A generator makes one document per grid point (`from` inclusive, `to` exclusive, every `interval`) with a value for each series. `gaps` on the generator or on a series leave grid points without a value; a grid point where no series has a value has no document. Every request sees the generated documents as if they were stored: lists with all filters, paging and totals, `revert`, `series` with aggregation, `supportedSeries` and `supportedMeasurements`, deletes, and `world.db.measurements`.

`seed()` returns `{ firstId, lastId }` per generator: the ids reserved for its grid points, in grid order (see [Model](#model)). `temperature.firstId` is the document at `from`, unless a gap covers it.

The rest of this page covers how it works inside the fake, which behavior it promises, and what it costs. The code is `src/generators.ts`; the request handlers in `src/api/data.ts` and `src/api/inventory.ts` use it when a tenant has generators, and keep their stored-only path otherwise.

## The promise

A world with generators answers every measurement request exactly like a world that stores the same documents, in id order. `tests/unit/generated-measurements.test.ts` checks this: it builds random generators (constants, waves, functions, gaps per generator and per series, fixed and live), builds the stored world independently from their definitions, and sends both worlds the same random requests. The run covers list queries (all filters, equal bounds, `revert`, page sizes 1 to 2000, pages up to 400, `withTotalElements`, `withTotalPages`), `series` with intervals and aggregation functions, `supportedSeries`, `supportedMeasurements`, POSTs (half on grid times, to make ties), deletes by id (generated, stored, gaps, already deleted, not yet there), deletes by filter (hour aligned, equal bounds, unaligned 422s), a deleted device, and clock moves. It repeats this on forks, after `reset()`, and after `restore()` into a new world and into another fork, and compares the fork diffs. Three seeds run with the default scattered ids and one also with `ids: 'sequential'`; each run sends about 570 requests to both worlds and compares the answers byte for byte; a fourth run restores a JSON snapshot, and a fifth compares the Notification 2.0 backlog after deletes. Breaking the tie order, the point tombstone count, the live delete limit, or the series gaps makes the test fail.

## Model

- **Generator (stream).** One source and type, one grid (`from`, `interval`, and `to` or the clock), and one or more series. A document per grid point holds the series that have a value there, grouped by fragment in the order the series are given. Its `time` and `creationTime` are the grid time. Compiled generators (`MeasurementStream`) live in `TenantData.measurementGenerators`, keyed by their first id, so forks share them by reference.
- **Gaps** are time ranges, turned into grid index intervals at seeding. A grid point where every series has a gap is a hole (no document). Gaps must be declared: a value function cannot decide that a point is missing, because counting and paging need the holes without evaluating values.
- **Ids.** Seeding reserves one number of the world's id counter per grid point (`WorldContext.reserveIds`): the point at grid index `i` has the sequence number `idStart + i` and the id `WorldContext.measurementId(idStart + i)`, the same id `newId('measurement')` would give for that number. With `ids: 'scattered'` (the default) that is 24 hex digits whose first 8 are `0x6A000000` plus the number, so `measurementSequence()` decodes an id back to its number (and checks the other 16 digits), and the hex ids sort like their numbers; with `ids: 'sequential'` it is the number itself. Generators keep numbers internally and format ids only when they build a document. A hole leaves its id unused. A live generator reserves its points at seeding plus `LIVE_CAPACITY` (100,000). Stored documents never get an id inside a block, so "id order" is "block order, and stored documents between blocks".
- **Tombstones** live in `TenantData.measurementTombstones`, in write order: a point tombstone (keyed by the id) keeps the deleted document; a range tombstone (`range#<n>`) keeps the filter, the clock at the delete (`until`), and the number of generated documents it removed (`count`). Being a collection, they fork, reset, freeze, snapshot, and diff like every other collection.

## Values

A series value is a constant, a deterministic function `(time, index) => number` (epoch milliseconds and grid index), or a wave:

| Wave Field       | Default                            | What It Does                                                               |
| ---------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `base`           | (required)                         | Base value.                                                                |
| `dailyAmplitude` | `0`                                | Amplitude of a daily sine (UTC).                                           |
| `peakHour`       | `15`                               | UTC hour of the sine's peak.                                               |
| `trendPerDay`    | `0`                                | Change per day since `from`.                                               |
| `noise`          | `0`                                | Uniform noise in `[-noise, noise]`, a hash of the key and the time.        |
| `noiseKey`       | `<source id>\|<fragment>.<series>` | Key of the noise hash.                                                     |
| `overrides`      | none                               | `[{ from, to, add?, set? }]`: shifts or replaces values, e.g. an incident. |
| `min`, `max`     | none                               | Clamps the value.                                                          |
| `precision`      | `2`                                | Decimal places.                                                            |

## Reads

`GeneratedView` (built per request with the world's clock) answers from the generators, the tombstones, and the stored documents the stored path selects:

- **Plan per stream.** The query's date window becomes a grid index window. The excluded intervals are the holes, the grid points without the queried fragment (or series), and the range tombstones that match the stream, merged and with prefix sums. Point tombstones in the window are kept apart. Counting a window is a binary search.
- **List order.** Newest first, or oldest first with `revert=false` and a date range (as for stored measurements). Documents of the same time are ordered by ascending id: this is what the stored path does, because stored measurements are never updated, so their collection order is their id order. The platform shows no stable order for equal times (`default-order` in `docs/platform-behavior.md`).
- **Paging** does not build the list. A binary search over time with "documents before time t" (summed over the plans and the stored list) finds the time of the first document of the page, and a heap merge from there fills it. `paged()` takes a lazy list (`length` and `slice`), so only the page is rendered.
- **`series`** evaluates every point in the window, in id order, so float sums equal the stored path exactly. It has no closed form: hashed noise, rounding, and clamping rule out analytic aggregates. `Math.min(...values)` became a `reduce`, since spreading throws above about 120k values in one bucket.
- **`supportedSeries`** takes, per series, the first point that is not excluded, and orders the series by that id (first appearance, like the stored path).
- **`world.db.measurements`**: `get(id)` decodes the id; `find()` builds every matching document, restricted to the filter's `source` when it has one.

## Writes

- **POST** stores the document as usual. Its id comes after every reserved block.
- **Delete by id** of a generated document that exists now: a point tombstone, 204, and a DELETE notification. A gap, an already deleted document, or a point a live generator has not reached yet: 404.
- **Delete by filter** deletes the stored matches and, if it covers generated documents, adds one range tombstone. Equal bounds are widened to the hour first, as on the platform. The deleted documents are listed (to publish them in list order) only when a Notification 2.0 subscription of the tenant may receive measurement notifications of the filter's source; otherwise the cost does not depend on how many documents the range covers.
- **Deleting a managed object** adds a range tombstone for its source without `until`: its generated history goes, including points a live generator would add later.

## Live generators and the clock

A generator without `to` is live: it shows the grid points up to the world's clock, inclusive. When a trial moves the clock forward, new points appear, like a device that keeps sending. Decisions:

- New points come from the ids reserved at seeding, so their ids are lower than those of documents POSTed earlier. A document at the same time as a POSTed one is listed first.
- A delete by filter covers the points up to the time of the delete (`until`); points that arrive later stay, as on the platform, where a delete cannot remove data that does not exist yet.
- A live generator stops after `LIVE_CAPACITY` points after seeding (100,000 points: 69 days at one minute, 28 hours at one second).
- New points publish no Notification 2.0 messages. They count as data for availability monitoring (`src/availability.ts`): the monitor jumps over runs of points (`nextPointTime()`, `runEndTime()`), so a device with a running generator costs one look per run, and `lastMessage` moves only at those looks.
- A fork has its own clock (`fork({ now })` or `fork({ clock })`, or a copy of the base's `clock`), so forks of the same base can see different numbers of live points.

## Snapshots and diffs

- `snapshot()` keeps `measurementGenerators` (the input, `idStart`, `block`) and `measurementTombstones`, never the documents. `restore()` compiles the generators again. A function value survives in-process snapshots but not `JSON.stringify`; restoring such a JSON snapshot throws. Waves and constants are JSON.
- `diff()` puts the documents of point tombstones into `measurements.deleted` and the range tombstones into `deletedMeasurementRanges` (with `count`), without building the documents a range covers. The stored documents a range deleted are in `measurements.deleted` as usual. Live growth is not reported as `created`.

## Cost

`node --expose-gc scripts/bench-generated.ts`: 1,000 devices with 4 series over 30 days, Apple M5, Node 24, medians.

|                                                 | 5 Min, 1 Generator Per Device | 5 Min, 4 Per Device | 1 Min, 1 Per Device | 1 Min, 4 Per Device |
| ----------------------------------------------- | ----------------------------- | ------------------- | ------------------- | ------------------- |
| documents (values)                              | 8.6M (34.6M)                  | 34.6M (34.6M)       | 43.2M (172.8M)      | 172.8M (172.8M)     |
| seed generators                                 | 6 ms                          | 8 ms                | 4 ms                | 5 ms                |
| heap of the world (with the devices)            | 4.8 MB                        | 6.2 MB              | 4.4 MB              | 6.2 MB              |
| first fork                                      | 3 ms                          | 3 ms                | 2 ms                | 3 ms                |
| source page (5) + total                         | 94 µs                         | 43 µs               | 52 µs               | 41 µs               |
| source page of 2000 (rendering)                 | 7.6 ms                        | 4.6 ms              | 7.6 ms              | 4.1 ms              |
| tenant-wide page (5) + total                    | 0.7 ms                        | 2.0 ms              | 0.8 ms              | 1.8 ms              |
| tenant-wide page 500 of 2000                    | 8.9 ms                        | 6.0 ms              | 8.2 ms              | 6.3 ms              |
| series, 30 days, daily, 5 functions             | 11 ms                         | 13 ms               | 55 ms               | 61 ms               |
| 20 range + 200 id deletes                       | 8 ms                          | 8 ms                | 8 ms                | 8 ms                |
| tenant-wide page + total after them             | 1.3 ms                        | 3.6 ms              | 0.9 ms              | 3.5 ms              |
| fork diff (200 documents, 20 ranges)            | 1.0 ms                        | 0.5 ms              | 0.8 ms              | 0.5 ms              |
| JSON snapshot: size; parse, restore, first fork | 0.9 MB; 9 ms                  | 1.4 MB; 11 ms       | 0.9 MB; 7 ms        | 1.4 MB; 11 ms       |

For comparison, the same history stored as documents costs about 580 bytes per document: 5 GB at 5 minutes with one generator per device.

## Open questions

- The platform's order of measurements with equal times (the fake uses ascending ids).
- Whether the platform publishes a DELETE notification per document for a delete by filter (the fake does, like for stored measurements).
- Whether `supportedSeries` lists a series after all its measurements are deleted (the fake does not).
- A generator per source and type is one grid; two generators with the same source and type are two streams of documents, not merged into one document per time.
