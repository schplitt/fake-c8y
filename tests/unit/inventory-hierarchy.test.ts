// Parent references of withParents/withGroups on hierarchies the contract
// scenarios cannot build on a shared tenant (cycles, long chains).
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

const ids = (fragment: { references: Array<{ managedObject: { id: string } }> }) => fragment.references.map((reference) => reference.managedObject.id)

async function get(world: ReturnType<typeof createWorld>, path: string) {
  return await (await world.fetch(new Request(`${world.baseUrl}${path}`))).json()
}

it('lists ancestors root first under the kind of the link below them', async () => {
  const world = createWorld()
  const sensor = world.device({ name: 'sensor' })
  const gateway = world.device({ name: 'gateway', children: [sensor] })
  const agent = world.device({ name: 'agent', children: [gateway] })
  const area = world.managedObject({ name: 'area', type: 'c8y_DeviceSubgroup', c8y_IsDeviceGroup: {}, assets: [gateway] })
  const site = world.managedObject({ name: 'site', type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {}, assets: [area] })

  const detail = await get(world, `/inventory/managedObjects/${sensor}?withParents=true`)
  expect(ids(detail.deviceParents)).toEqual([agent, gateway])
  expect(ids(detail.assetParents)).toEqual([site, area])

  const { managedObjects: [listed] } = await get(world, `/inventory/managedObjects?ids=${gateway}&withGroups=true`)
  expect(ids(listed.assetParents)).toEqual([area])
  expect(listed.assetParents.references[0].managedObject).not.toHaveProperty('type')
})

it('lists an ancestor under every kind of link that leads down from it', async () => {
  // verified: a direct asset parent that is also a device parent of the device
  // parent appears in both lists, first among the asset parents
  const world = createWorld()
  const sensor = world.device({ name: 'sensor' })
  const gateway = world.device({ name: 'gateway', children: [sensor] })
  const group = world.managedObject({ name: 'group', type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {}, assets: [gateway] })
  const both = world.device({ name: 'both', children: [gateway], assets: [sensor] })

  const detail = await get(world, `/inventory/managedObjects/${sensor}?withParents=true`)
  expect(ids(detail.assetParents)).toEqual([both, group])
  expect(ids(detail.deviceParents)).toEqual([both, gateway])
})

it('stops at cycles', async () => {
  const world = createWorld()
  const first = world.managedObject({ name: 'first' })
  const second = world.managedObject({ name: 'second', assets: [first] })
  await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${first}/childAssets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ managedObject: { id: second } }),
  }))
  const detail = await get(world, `/inventory/managedObjects/${first}?withParents=true`)
  expect(ids(detail.assetParents)).toEqual([second])
})
