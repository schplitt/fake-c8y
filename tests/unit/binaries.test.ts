// Binaries: range downloads of inventory binaries, and event attachments
// (name from Content-Disposition, size limit).
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

function send(world: World, method: string, path: string, headers: Record<string, string> = {}, body?: string | Uint8Array<ArrayBuffer>) {
  return world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { accept: 'application/json', ...headers }, ...(body === undefined ? {} : { body }) }))
}

describe('inventory binary downloads with Range', () => {
  const world = createWorld()
  const id = world.binary({ name: 'f.txt', content: 'abcdef', contentType: 'text/plain' })
  const range = (value: string) => send(world, 'GET', `/inventory/binaries/${id}`, { accept: '*/*', range: value })
  const answer = async (value: string) => {
    const response = await range(value)
    return [response.status, response.headers.get('content-range'), response.headers.get('content-length'), await response.text()]
  }

  it('answers 206 with the requested bytes, like the platform', async () => {
    expect(await answer('bytes=2-4')).toEqual([206, 'bytes 2-4/6', '3', 'cde'])
    expect(await answer('bytes=4-')).toEqual([206, 'bytes 4-5/6', '2', 'ef'])
    expect(await answer('bytes=-2')).toEqual([206, 'bytes 4-5/6', '2', 'ef'])
    // a start at the end of the file, and an empty suffix: empty 206
    expect(await answer('bytes=6-')).toEqual([206, 'bytes 6-5/6', '0', ''])
    expect(await answer('bytes=-0')).toEqual([206, 'bytes 6-5/6', '0', ''])
    // an end before the start: from the start to the end of the file
    expect(await answer('bytes=4-2')).toEqual([206, 'bytes 4-2/6', '2', 'ef'])
    const response = await range('bytes=2-4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="f.txt"; filename*=UTF-8\'\'f.txt')
  })

  it('answers the platform\'s errors for ranges it does not serve', async () => {
    const past = await range('bytes=2-100')
    expect(past.status).toBe(416)
    expect(await past.json()).toMatchObject({ error: 'inventory/Requested Range Not Satisfiable', message: 'Range parameter "end" is bigger than actual file length' })
    const several = await range('bytes=0-1,3-4')
    expect(several.status).toBe(422)
    expect(await several.json()).toEqual({ error: 'Only one Range is supported by the resource/Invalid Data', info: 'https://cumulocity.com/api/core/' })
    const unit = await range('items=0-1')
    expect(unit.status).toBe(400)
    expect(await unit.json()).toMatchObject({ error: 'general/internalError', message: 'HTTP 400 Bad Request : Range \'items=0-1\' does not start with \'bytes=\'' })
    const whole = await send(world, 'GET', `/inventory/binaries/${id}`, { accept: '*/*' })
    expect([whole.status, whole.headers.get('accept-ranges'), await whole.text()]).toEqual([200, 'bytes', 'abcdef'])
    expect(world.unhandled).toEqual([])
  })
})

describe('event attachments', () => {
  async function event(world: World): Promise<string> {
    const device = world.device({ name: 'D' })
    const response = await send(world, 'POST', '/event/events', { 'content-type': 'application/json' }, JSON.stringify({ source: { id: device }, type: 't', text: 'x', time: '2026-11-07T10:00:00Z' }))
    return (await response.json() as { id: string }).id
  }

  it('a raw PUT takes its name from Content-Disposition', async () => {
    const world = createWorld()
    const id = await event(world)
    const quoted = await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.txt"' }, 'hello')
    expect(await quoted.json()).toMatchObject({ name: 'file.txt', type: 'application/octet-stream' })
    expect(world.db.events.get(id)?.c8y_IsBinary).toEqual({ name: 'file.txt', length: 5, type: 'application/octet-stream' })
    const extended = await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="a.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.txt' }, 'hello')
    expect((await extended.json() as { name: string }).name).toBe('résumé.txt')
    // without the header the attachment is named after the event (verified)
    const plain = await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream' }, 'hello')
    expect((await plain.json() as { name: string }).name).toBe(id)
  })

  it('a download answers no Accept-Ranges and ignores Range', async () => {
    const world = createWorld()
    const id = await event(world)
    await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream' }, 'hello')
    for (const headers of [{ accept: '*/*' }, { accept: '*/*', range: 'bytes=1-2' }, { accept: '*/*', range: 'items=0-1' }]) {
      const response = await send(world, 'GET', `/event/events/${id}/binaries`, headers)
      expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), await response.text()]).toEqual([200, null, null, 'hello'])
    }
  })

  it('reads Content-Disposition like the platform: filename* wins, its charset counts, a quote ends the name', async () => {
    const world = createWorld()
    const id = await event(world)
    const put = async (disposition: string) => {
      await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream', 'content-disposition': disposition }, 'hello')
      const response = await send(world, 'GET', `/event/events/${id}/binaries`, { accept: '*/*' })
      return [(world.db.events.get(id)?.c8y_IsBinary as { name: string }).name, response.headers.get('content-disposition')]
    }
    expect(await put('attachment; filename="file.txt"')).toEqual(['file.txt', 'attachment; filename="file.txt"; filename*=UTF-8\'\'file.txt'])
    expect(await put('attachment; filename*=UTF-8\'\'%E2%82%AC.txt')).toEqual(['€.txt', 'attachment; filename=" .txt"; filename*=UTF-8\'\'%e2%82%ac.txt'])
    expect(await put('attachment; filename="fallback.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.txt')).toEqual(['résumé.txt', 'attachment; filename="résumé.txt"; filename*=UTF-8\'\'r%c3%a9sum%c3%a9.txt'])
    expect(await put('attachment; filename*=ISO-8859-1\'\'%E4.txt')).toEqual(['ä.txt', 'attachment; filename="ä.txt"; filename*=UTF-8\'\'%c3%a4.txt'])
    expect(await put('attachment; filename="a\\"b.txt"')).toEqual(['a\\', 'attachment; filename="a\\"; filename*=UTF-8\'\'a%5c'])
    // control characters (a CR LF) are dropped from the stored name
    expect((await put('attachment; filename*=UTF-8\'\'x%0D%0Ay.txt'))[0]).toBe('xy.txt')
  })

  it('downloads inventory binaries with any name', async () => {
    const world = createWorld()
    const id = world.binary({ name: 'line\nbreak €.txt', content: 'abc', contentType: 'text/plain' })
    const response = await send(world, 'GET', `/inventory/binaries/${id}`, { accept: '*/*' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="line break  .txt"; filename*=UTF-8\'\'line%0abreak%20%e2%82%ac.txt')
  })

  it('rejects an attachment over 50 MiB', async () => {
    const world = createWorld()
    const id = await event(world)
    const limit = 50 * 1024 * 1024
    const tooLarge = await send(world, 'PUT', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream' }, new Uint8Array(limit + 1))
    expect(tooLarge.status).toBe(422)
    expect(await tooLarge.json()).toMatchObject({ error: 'event/Invalid Data', message: 'File size too big. Max size is 50MB' })
    expect(world.db.events.get(id)?.c8y_IsBinary).toBeUndefined()
    expect((await send(world, 'POST', `/event/events/${id}/binaries`, { 'content-type': 'application/octet-stream' }, new Uint8Array(limit))).status).toBe(201)
    // a multipart body counts its file part, not the envelope
    const other = await event(world)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(limit)]), 'big.bin')
    expect((await world.fetch(new Request(`${world.baseUrl}/event/events/${other}/binaries`, { method: 'POST', headers: { accept: 'application/json' }, body: form }))).status).toBe(201)
  })
})
