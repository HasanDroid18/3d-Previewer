// Run: npm run check
import assert from 'node:assert/strict'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { loadFiles, LoadError, sampleModel, type Model } from './load.ts'

// three's FileLoader reports progress with an event Node doesn't have
(globalThis as any).ProgressEvent ??= class extends Event {
  constructor(type: string, init: object) {
    super(type)
    Object.assign(this, init)
  }
}

const file = (name: string, data: string | Uint8Array) => new File([data as BlobPart], name)
const centred = (m: Model) => {
  const p = m.object.children[0].position
  return p // what was subtracted, so the model sits on the origin
}

// A 2 mm cube with one corner at (10, 10, 10), as a CAD export would place it
const cubeVerts = [[10, 10, 10], [12, 10, 10], [12, 12, 10], [10, 12, 10], [10, 10, 12], [12, 10, 12], [12, 12, 12], [10, 12, 12]]
const cubeFaces = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]]
const obj = `mtllib cube.mtl\n${cubeVerts.map((v) => `v ${v.join(' ')}`).join('\n')}\nusemtl red\n${cubeFaces.map((f) => `f ${f.join(' ')}`).join('\n')}\n`
const mtl = 'newmtl red\nKd 1 0 0\n'
const stl = `solid cube\n${cubeFaces
  .flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]])
  .map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${cubeVerts[i - 1].join(' ')}`).join('\n')}\nendloop\nendfacet`)
  .join('\n')}\nendsolid cube\n`

// STL: geometry only, so it gets the clay material; centred, with its true size
{
  const m = await loadFiles([file('cube.stl', stl)])
  assert.equal(m.format, 'stl')
  assert.equal(m.stats.triangles, 12)
  assert.deepEqual(m.size.toArray(), [2, 2, 2])
  assert.deepEqual(centred(m).toArray(), [-11, -11, -11])
  m.dispose()
}

// OBJ picked out of several files, with the material library it names
{
  const m = await loadFiles([file('notes.txt', 'hi'), file('cube.mtl', mtl), file('cube.obj', obj), file('wood.png', new Uint8Array([1]))])
  assert.equal(m.format, 'obj')
  assert.equal(m.stats.triangles, 12)
  let red = false
  m.object.traverse((o: any) => o.isMesh && (red = o.material.color.r === 1 && o.material.color.g === 0))
  assert.ok(red, 'the .mtl colour reached the mesh')
}

// The same two files inside a zip, with a macOS resource fork that must be skipped
{
  const zip = zipSync({ 'export/cube.obj': new TextEncoder().encode(obj), 'export/cube.mtl': new TextEncoder().encode(mtl), '__MACOSX/export/._cube.obj': new Uint8Array([0]) })
  const m = await loadFiles([file('cube.zip', zip)])
  assert.equal(m.name, 'cube.obj')
  assert.equal(m.stats.triangles, 12)
}

// glTF with its buffer in a separate .bin, resolved from the files opened with it
{
  const pos = new Float32Array([0, 0, 0, 3, 0, 0, 0, 4, 0])
  const gltf = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [3, 4, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri: 'tri.bin', byteLength: 36 }],
  })
  const m = await loadFiles([file('tri.gltf', gltf), file('tri.bin', new Uint8Array(pos.buffer))])
  assert.equal(m.unit, 'm')
  assert.equal(m.stats.triangles, 1)
  assert.deepEqual(m.size.toArray(), [3, 4, 0])
  await assert.rejects(loadFiles([file('tri.gltf', gltf)]), (e) => e instanceof LoadError && /\.bin/.test(e.message), 'a missing .bin is explained')
}

// A PLY scan with no faces is a point cloud
{
  const ply = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n'
  const m = await loadFiles([file('scan.ply', ply)])
  assert.equal(m.stats.points, 3)
  assert.equal(m.stats.meshes, 0)
}

// Problems the person can fix are explained, not thrown as parser errors
await assert.rejects(loadFiles([file('scene.max', 'x')]), (e) => e instanceof LoadError && e.message.startsWith('.max files'))
await assert.rejects(loadFiles([file('empty.stl', '')]), (e) => e instanceof LoadError && /empty/.test(e.message))
await assert.rejects(loadFiles([file('broken.glb', 'not a glb')]), (e) => e instanceof LoadError && /couldn't be read/.test(e.message))
await assert.rejects(loadFiles([file('bad.zip', 'not a zip')]), (e) => e instanceof LoadError && /unzipped/.test(e.message))

assert.ok(sampleModel().stats.triangles > 1000)
console.log('load checks passed')
