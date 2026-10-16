// The decoders some files need (Draco and KTX2 inside glTF, Rhino .3dm) are served from public/ and only download when used.
import { cpSync } from 'node:fs'

const copies = {
  'node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm': 'public/draco/draco_decoder.wasm',
  'node_modules/three/examples/jsm/libs/draco/draco_wasm_wrapper.js': 'public/draco/draco_wasm_wrapper.js',
  'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js': 'public/basis/basis_transcoder.js',
  'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm': 'public/basis/basis_transcoder.wasm',
  'node_modules/rhino3dm/rhino3dm.js': 'public/rhino3dm/rhino3dm.js',
  'node_modules/rhino3dm/rhino3dm.wasm': 'public/rhino3dm/rhino3dm.wasm',
}
for (const [from, to] of Object.entries(copies)) cpSync(from, to)
