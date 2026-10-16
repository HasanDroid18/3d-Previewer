// Model loading, free of DOM rendering and React so the viewer and the check share it.
// Centres the model and checks it can be shown. The file's own materials are kept,
// and the files a model refers to (.bin, .mtl, textures) resolved from what was opened with it.
import * as THREE from 'three'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Formats the preview opens, in the order one is picked as the model when several files arrive together
export const FORMATS = ['glb', 'gltf', 'fbx', 'usdz', 'usdc', 'usda', 'usd', 'dae', 'obj', '3ds', '3mf', 'amf', '3dm', 'stl', 'ply', 'wrl', 'vtk', 'vtp', 'kmz', 'lwo', 'vox', 'md2', 'drc', 'pcd', 'xyz', 'gcode'] as const
export type Format = (typeof FORMATS)[number]
// The file picker also takes the files a model refers to, so they can be chosen together with it
export const ACCEPT = [...FORMATS, 'zip', 'bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif', 'ktx2'].map((e) => '.' + e).join(',')
export const MAX_BYTES = 500e6

export type Stats = { meshes: number; triangles: number; vertices: number; points: number; materials: number }

// object is centred on the origin; size is in the file's own units, which unit names when the file states it.
export type Model = {
  name: string
  format: string
  object: THREE.Group
  size: THREE.Vector3
  unit?: string
  clips: THREE.AnimationClip[]
  stats: Stats
  dispose: () => void
}

// Problems the person opening the file can act on; anything else is a parser failure.
export class LoadError extends Error {}

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
export const extOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const baseOf = (path: string) => {
  let p = path
  try {
    p = decodeURIComponent(path)
  } catch {} // a stray % in a name
  return p.split(/[\\/]/).pop()!.toLowerCase()
}

// What a file holds when it carries no materials of its own: matte clay, or its own vertex colours
const clay = (g: THREE.BufferGeometry) =>
  new THREE.MeshStandardMaterial({ color: g.attributes.color ? 0xffffff : 0xb9b9be, vertexColors: !!g.attributes.color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })
const dots = (g: THREE.BufferGeometry) => new THREE.PointsMaterial({ color: g.attributes.color ? 0xffffff : 0xb9b9be, vertexColors: !!g.attributes.color })
// Geometry-only formats: faces make a surface, a bare vertex list is a point cloud
const shape = (g: THREE.BufferGeometry) => {
  if (!g.index && g.attributes.position.count % 3) return new THREE.Points(g, dots(g))
  if (!g.attributes.normal) g.computeVertexNormals()
  return new THREE.Mesh(g, clay(g))
}

type Parsed = { root: THREE.Object3D; clips?: THREE.AnimationClip[]; unit?: string }
type Ctx = { buf: ArrayBuffer; text: () => string; name: string; files: File[]; manager: THREE.LoadingManager; renderer?: THREE.WebGLRenderer }

const PARSERS: Record<Format, (c: Ctx) => Promise<Parsed>> = {
  glb: gltf,
  gltf,
  fbx: async ({ buf, manager }) => {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    const root = new FBXLoader(manager).parse(buf, '')
    return { root, clips: root.animations }
  },
  usdz: usd,
  usdc: usd,
  usda: usd,
  usd,
  dae: async ({ text, manager }) => {
    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
    const scene = new ColladaLoader(manager).parse(text(), '')?.scene
    if (!scene) throw new LoadError("This .dae couldn't be read. Export it again from the design program.")
    return { root: scene, clips: scene.animations }
  },
  obj: async ({ text, files, manager }) => {
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([import('three/examples/jsm/loaders/OBJLoader.js'), import('three/examples/jsm/loaders/MTLLoader.js')])
    const src = text()
    const loader = new OBJLoader(manager)
    // The material library the file names, or any that came along with it
    const lib = src.match(/^mtllib\s+(.+)$/m)?.[1].trim()
    const mtl = files.find((f) => lib && baseOf(f.name) === baseOf(lib)) ?? files.find((f) => extOf(f.name) === 'mtl')
    if (mtl) {
      const materials = new MTLLoader(manager).parse(await mtl.text(), '')
      materials.preload()
      loader.setMaterials(materials)
    }
    return { root: loader.parse(src) }
  },
  '3ds': async ({ buf, manager }) => {
    const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js')
    return { root: new TDSLoader(manager).parse(buf, '') }
  },
  '3mf': async ({ buf, manager }) => {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js')
    return { root: new ThreeMFLoader(manager).parse(buf) }
  },
  amf: async ({ buf }) => {
    const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js')
    return { root: new AMFLoader().parse(buf) }
  },
  '3dm': load3dm,
  stl: async ({ buf }) => {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
    const g = new STLLoader().parse(buf)
    // CAD tessellation arrives faceted: smooth curved surfaces but keep edges sharper than 15° crisp,
    // or a flat face blends into its bevel and long CAD triangles smear that across the face
    return { root: new THREE.Mesh(toCreasedNormals(g, THREE.MathUtils.degToRad(15)), clay(g)) }
  },
  ply: async ({ buf }) => {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js')
    const g = new PLYLoader().parse(buf)
    return { root: g.index ? shape(g) : new THREE.Points(g, dots(g)) } // no faces: a scan's point cloud
  },
  wrl: async ({ text, manager }) => {
    const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js')
    return { root: new VRMLLoader(manager).parse(text(), '') }
  },
  vtk: vtk,
  vtp: vtk,
  kmz: async ({ buf, manager }) => {
    const { KMZLoader } = await import('three/examples/jsm/loaders/KMZLoader.js')
    return { root: new KMZLoader(manager).parse(buf).scene }
  },
  lwo: async ({ buf, name, manager }) => {
    const { LWOLoader } = await import('three/examples/jsm/loaders/LWOLoader.js')
    return { root: new THREE.Group().add(...new LWOLoader(manager).parse(buf, '', name).meshes) }
  },
  vox: async ({ buf }) => {
    const { VOXLoader } = await import('three/examples/jsm/loaders/VOXLoader.js')
    return { root: new VOXLoader().parse(buf).scene }
  },
  md2: async ({ buf }) => {
    const { MD2Loader } = await import('three/examples/jsm/loaders/MD2Loader.js')
    const g = new MD2Loader().parse(buf)
    return { root: shape(g), clips: (g as THREE.BufferGeometry & { animations?: THREE.AnimationClip[] }).animations }
  },
  drc: async ({ buf }) => {
    const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js')
    const loader = new DRACOLoader().setDecoderPath(BASE + 'draco/')
    try {
      return { root: shape(await new Promise<THREE.BufferGeometry>((ok, fail) => loader.parse(buf, ok, fail))) }
    } finally {
      loader.dispose()
    }
  },
  pcd: async ({ buf }) => {
    const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js')
    return { root: new PCDLoader().parse(buf) }
  },
  xyz: async ({ text }) => {
    const { XYZLoader } = await import('three/examples/jsm/loaders/XYZLoader.js')
    const g = new XYZLoader().parse(text(), () => {}) as unknown as THREE.BufferGeometry // its typings predate parse returning the geometry
    return { root: new THREE.Points(g, dots(g)) }
  },
  gcode: async ({ text }) => {
    const { GCodeLoader } = await import('three/examples/jsm/loaders/GCodeLoader.js')
    return { root: new GCodeLoader().parse(text()) }
  },
}

async function gltf({ buf, name, manager, renderer }: Ctx): Promise<Parsed> {
  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
    import('three/examples/jsm/loaders/KTX2Loader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ])
  const draco = new DRACOLoader(manager).setDecoderPath(BASE + 'draco/')
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder)
  // KTX2 textures are transcoded to what this GPU supports, so they need the renderer
  const ktx2 = renderer && new KTX2Loader(manager).setTranscoderPath(BASE + 'basis/').detectSupport(renderer)
  if (ktx2) loader.setKTX2Loader(ktx2)
  try {
    const g = await loader.parseAsync(buf, '')
    return { root: g.scene ?? g.scenes[0], clips: g.animations, unit: 'm' } // glTF is metres by spec
  } catch (e) {
    if (extOf(name) === 'gltf') throw new LoadError("This .gltf refers to files that weren't opened with it (its .bin or textures). Select them all together, drop the whole folder, or open a .zip.")
    throw e
  } finally {
    draco.dispose()
    ktx2?.dispose()
  }
}

async function usd({ buf, manager }: Ctx): Promise<Parsed> {
  const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js')
  return { root: new USDLoader(manager).parse(buf, '') }
}

async function vtk({ buf }: Ctx): Promise<Parsed> {
  const { VTKLoader } = await import('three/examples/jsm/loaders/VTKLoader.js')
  return { root: shape(new VTKLoader().parse(buf, '')) }
}

const RHINO_UNITS: Record<string, string> = { Millimeters: 'mm', Centimeters: 'cm', Meters: 'm', Inches: 'in', Feet: 'ft' }

// Rhino files (also MatrixGold and RhinoGold). The browser can't turn NURBS surfaces into triangles, so this
// shows the render meshes Rhino saves with each object once it has been shaded. rhino3dm's WebAssembly is
// served from /rhino3dm/ (copied there on npm install) and only downloads when a .3dm is opened.
async function load3dm({ buf }: Ctx): Promise<Parsed> {
  const { Rhino3dmLoader } = await import('three/examples/jsm/loaders/3DMLoader.js')
  const loader = new Rhino3dmLoader().setLibraryPath(BASE + 'rhino3dm/')
  let root: THREE.Object3D
  try {
    root = await loader.parseAsync(buf)
  } catch {
    throw new LoadError("This .3dm couldn't be read. Save it again from Rhino (version 5 or later) and try once more.")
  } finally {
    loader.dispose()
  }
  // Keep what the designer shows: hidden layers hold construction curves, and curves, points, text dots
  // and lights would stretch the bounds without being part of the model
  const drop: THREE.Object3D[] = []
  root.traverse((o) => {
    const x = o as THREE.Object3D & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isLight?: boolean }
    if (o !== root && (!o.visible || x.isLine || x.isPoints || x.isSprite || x.isLight)) drop.push(o)
  })
  drop.forEach((o) => o.removeFromParent())
  let meshes = 0
  root.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes++))
  if (!meshes) {
    throw new LoadError('This .3dm has no render meshes, so there is nothing to show. In Rhino, switch a viewport to Shaded or Rendered, then save with Save (not Save Small). Or export GLB or STL.')
  }
  const unit: string = root.userData.settings?.modelUnitSystem?.name ?? ''
  return { root, unit: RHINO_UNITS[unit.split('_').pop() ?? ''] }
}

// Everything opened together: a zip's contents are unpacked, and macOS resource forks left out
async function expand(files: File[]) {
  const out: File[] = []
  for (const f of files) {
    if (extOf(f.name) !== 'zip') {
      out.push(f)
      continue
    }
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(await f.arrayBuffer()))
    } catch {
      throw new LoadError(`${f.name} couldn't be unzipped.`)
    }
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || path.startsWith('__MACOSX/') || baseOf(path).startsWith('._')) continue
      out.push(new File([data as Uint8Array<ArrayBuffer>], path.split('/').pop()!))
    }
  }
  return out
}

// Opens a model from one file, or from a model and the files it refers to (picked together, a dropped folder, or a zip).
export async function loadFiles(picked: File[], renderer?: THREE.WebGLRenderer): Promise<Model> {
  if (picked.reduce((n, f) => n + f.size, 0) > MAX_BYTES) throw new LoadError('That is over 500 MB. Export a lighter version of the model for the preview.')
  const files = await expand(picked)
  const main = FORMATS.map((f) => files.find((x) => extOf(x.name) === f)).find((f) => f)
  if (!main) {
    const ext = files.length === 1 ? extOf(files[0].name) : ''
    throw new LoadError(ext ? `.${ext} files can't be previewed. Open a GLB, glTF, FBX, OBJ, STL, USDZ or another 3D format.` : files.length ? 'None of these files is a 3D model this preview can open.' : 'Nothing to open.')
  }
  const buf = await main.arrayBuffer()
  if (!buf.byteLength) throw new LoadError('This file is empty. Export it again from the design program.')

  // References inside the model (textures, .bin, .mtl) resolve to the files opened with it, matched by name.
  // ponytail: by file name only, so two textures with one name in different folders collide; match whole paths if that turns up
  const byName = new Map(files.map((f) => [baseOf(f.name), f]))
  const urls = new Map<File, string>()
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    const file = /^(data|blob):/.test(url) ? undefined : byName.get(baseOf(url))
    if (!file) return url
    if (!urls.has(file)) urls.set(file, URL.createObjectURL(file))
    return urls.get(file)!
  })
  manager.addHandler(/\.tga$/i, new TGALoader(manager))

  const format = extOf(main.name) as Format
  const text = () => new TextDecoder().decode(buf)
  let parsed: Parsed
  try {
    parsed = await PARSERS[format]({ buf, text, name: main.name, files, manager, renderer })
  } catch (e) {
    urls.forEach((u) => URL.revokeObjectURL(u))
    if (e instanceof LoadError) throw e
    console.error(e)
    throw new LoadError(`${main.name} couldn't be read. It may be damaged, or saved by a newer version of the program than this preview understands.`)
  }
  return finish(main.name, format, parsed, () => urls.forEach((u) => URL.revokeObjectURL(u)))
}

// A model to try the viewer without a file
export function sampleModel(): Model {
  const geometry = new THREE.TorusKnotGeometry(1, 0.32, 320, 48)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc9a46a, metalness: 1, roughness: 0.22 }))
  return finish('Sample knot', 'sample', { root: mesh }, () => {})
}

const NOTHING = 'This file has nothing to show: no surfaces, points or lines. Check the export includes meshes.'

function finish(name: string, format: string, { root, clips = [], unit }: Parsed, release: () => void): Model {
  const stats: Stats = { meshes: 0, triangles: 0, vertices: 0, points: 0, materials: 0 }
  const materials = new Set<THREE.Material>()
  const drawn: THREE.Object3D[] = []
  root.traverse((o) => {
    const x = o as THREE.Mesh & { isPoints?: boolean; isLine?: boolean }
    const P = x.geometry?.attributes?.position
    if (!P || !(x.isMesh || x.isPoints || x.isLine)) return
    drawn.push(o)
    for (const m of [x.material].flat()) if (m) materials.add(m)
    if (x.isPoints) stats.points += P.count
    if (!x.isMesh) return
    stats.meshes++
    stats.vertices += P.count
    stats.triangles += (x.geometry.index?.count ?? P.count) / 3
  })
  if (!drawn.length) throw new LoadError(NOTHING)
  stats.materials = materials.size
  stats.triangles = Math.round(stats.triangles)

  const group = new THREE.Group()
  group.add(root)
  group.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty()) throw new LoadError(NOTHING)
  const size = box.getSize(new THREE.Vector3())
  if (![size.x, size.y, size.z].every(Number.isFinite)) throw new LoadError('This file contains broken coordinates. Export it again from the design program.')
  root.position.sub(box.getCenter(new THREE.Vector3()))

  // Point sizes are in model units, so they follow the model's own scale
  const pointSize = size.length() * 0.0025
  for (const m of materials) if ((m as THREE.PointsMaterial).isPointsMaterial) (m as THREE.PointsMaterial).size = pointSize

  return {
    name,
    format,
    object: group,
    size,
    unit,
    clips,
    stats,
    dispose: () => {
      for (const m of materials) {
        for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose()
        m.dispose()
      }
      for (const o of drawn) (o as THREE.Mesh).geometry.dispose()
      release()
    },
  }
}
