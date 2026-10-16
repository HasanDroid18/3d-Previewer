import { Environment, Lightformer, TrackballControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useEffectEvent, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import type { Model } from './load'

// The 3D stage: a trackball for dragging and a rig that eases
// every button, key and double-tap move, so the model turns freely in every direction with no poles.

// Camera moves the page can ask for (buttons, keyboard). Dragging is handled by the trackball.
export type ViewControls = {
  fit: () => void // whole model in view, keeping the current angle
  turn: (yawDeg: number, pitchDeg: number) => void
  zoom: (factor: number) => void
  capture: () => string // PNG data URL of the current view
}

function Piece({ model, wireframe, clip, playing }: { model: Model; wireframe: boolean; clip: number; playing: boolean }) {
  const mixer = useMemo(() => new THREE.AnimationMixer(model.object), [model])
  useEffect(() => {
    const c = model.clips[clip]
    if (!c) return
    const action = mixer.clipAction(c).play()
    return () => void action.stop()
  }, [mixer, model, clip])
  useFrame((_, dt) => void (playing && mixer.update(Math.min(dt, 0.1))))

  useEffect(() => {
    model.object.traverse((o) => {
      for (const m of [(o as THREE.Mesh).material].flat()) if (m && 'wireframe' in m) m.wireframe = wireframe
    })
  }, [model, wireframe])
  return <primitive object={model.object} />
}

// A light that follows the camera, so whichever side is turned to the viewer is lit. Phong and Lambert
// materials (OBJ, FBX, 3DS, Collada) ignore the studio environment and need it to show at all.
function Headlight() {
  const light = useRef<THREE.DirectionalLight>(null!)
  useFrame(({ camera }) => {
    light.current.position.copy(camera.position)
    light.current.target.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()))
    light.current.target.updateMatrixWorld()
  })
  return <directionalLight ref={light} intensity={1.6} />
}

type Goal = { q: THREE.Quaternion; target: THREE.Vector3; dist: number }
const SPIN_SPEED = THREE.MathUtils.degToRad(36) // one full turn every 10 s
const Z = new THREE.Vector3(0, 0, 1)
const FOV = 35 // degrees across the narrower side of the view
const CAPTURE_PX = 2400 // the saved picture's longer side, whatever the screen

// Moves the camera around the model for buttons, keys and double-taps: every move is a rotation of the camera's
// orientation around the target, so there are no poles and the model can be seen from any direction.
function Rig({ model, fitKey, apiRef, reduce, spinning, onSpinChange }: {
  model: Model
  fitKey: string
  apiRef: RefObject<ViewControls | null>
  reduce: boolean
  spinning: boolean
  onSpinChange: (on: boolean) => void
}) {
  const { gl, scene } = useThree()
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; minDistance: number; maxDistance: number } | null
  const goal = useRef<Goal | null>(null)
  const snap = useRef(false) // jump to the goal on the next frame instead of easing
  const fitted = useRef('') // fitKey of the last framing
  const tmpQ = useMemo(() => new THREE.Quaternion(), [])
  const span = model.size.length()

  const current = () => {
    const target = controls?.target ?? new THREE.Vector3()
    return { q: camera.quaternion.clone(), target: target.clone(), dist: camera.position.distanceTo(target) }
  }
  const aim = (next: Goal) => {
    if (controls) next.dist = THREE.MathUtils.clamp(next.dist, controls.minDistance, controls.maxDistance)
    goal.current = next
  }
  const halfFov = () => THREE.MathUtils.degToRad(FOV / 2) // of the narrower side (see the frame loop)

  // Camera looking straight at `point` from outside the surface, keeping the current screen up as upright as it can
  const frameFor = (point: THREE.Vector3, normal: THREE.Vector3, size: number): Goal => {
    const back = normal.clone().normalize()
    const u = new THREE.Vector3()
    for (const candidate of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)]) {
      candidate.applyQuaternion(camera.quaternion)
      u.copy(candidate).addScaledVector(back, -candidate.dot(back))
      if (u.lengthSq() > 1e-4) break
    }
    u.normalize()
    const right = new THREE.Vector3().crossVectors(u, back)
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, u, back))
    return { q, target: point.clone(), dist: size / 2 / Math.tan(halfFov()) }
  }

  // The whole model, centred and filling the view, seen with orientation q
  const wholeModel = (q: THREE.Quaternion): Goal => {
    model.object.updateWorldMatrix(true, true)
    const sphere = new THREE.Box3().setFromObject(model.object).getBoundingSphere(new THREE.Sphere())
    const dist = (sphere.radius / Math.sin(halfFov())) * 1.08
    camera.near = dist / 200
    camera.far = dist * 50
    camera.updateProjectionMatrix()
    return { q, target: sphere.center, dist }
  }

  // Frame the whole model from a three-quarter view: straight away for a new file, eased for "Reset view"
  const fitModel = useEffectEvent(() => {
    if (!controls) return
    const eye = new THREE.Vector3(0.35, 0.5, 1).normalize()
    const fit = wholeModel(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, new THREE.Vector3(), new THREE.Vector3(0, 1, 0))))
    const piece = fitKey.slice(0, fitKey.lastIndexOf('#'))
    if (fitted.current.startsWith(piece + '#')) aim(fit)
    else {
      goal.current = fit
      snap.current = true
    }
    fitted.current = fitKey
  })
  useEffect(() => { fitModel() }, [fitKey, controls]) // refit only when the model or the reset request change

  // Grabbing the model takes over from any automatic move or spin
  useEffect(() => {
    const c = controls as unknown as THREE.EventDispatcher<{ start: object }> | null
    if (!c) return
    const stop = () => {
      goal.current = null
      onSpinChange(false)
    }
    c.addEventListener('start', stop)
    return () => c.removeEventListener('start', stop)
  }, [controls, onSpinChange])

  // Double tap or double click: look closer at that spot. Taps come from pointer events because the trackball
  // cancels touchstart, so phones never send a click; the model is only raycast on the second tap.
  const onDoubleTap = useEffectEvent((x: number, y: number) => {
    const rect = gl.domElement.getBoundingClientRect()
    const ray = new THREE.Raycaster()
    ray.params.Points.threshold = ray.params.Line.threshold = span * 0.004
    ray.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera)
    const hit = ray.intersectObject(model.object, true)[0]
    if (!hit) return
    onSpinChange(false)
    if (!hit.face) return aim({ ...current(), target: hit.point.clone(), dist: span * 0.6 })
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    if (normal.dot(camera.position.clone().sub(hit.point)) < 0) normal.negate() // the back of a two-sided surface
    aim(frameFor(hit.point, normal, span * 0.35))
  })
  useEffect(() => {
    const el = gl.domElement
    let down: { x: number; y: number; t: number } | null = null
    let last = 0
    const onDown = (e: PointerEvent) => void (down = { x: e.clientX, y: e.clientY, t: performance.now() })
    const onUp = (e: PointerEvent) => {
      const d = down
      down = null
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return // a drag, not a tap
      const now = performance.now()
      if (now - last > 350) return void (last = now)
      last = 0
      onDoubleTap(e.clientX, e.clientY)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [gl])

  useEffect(() => {
    apiRef.current = {
      turn: (yawDeg, pitchDeg) => {
        const c = goal.current ?? current()
        const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(c.q), THREE.MathUtils.degToRad(yawDeg))
        const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(c.q), THREE.MathUtils.degToRad(-pitchDeg))
        aim({ ...c, q: yaw.multiply(pitch).multiply(c.q.clone()) })
      },
      zoom: (factor) => {
        const c = goal.current ?? current()
        aim({ ...c, dist: c.dist * factor })
      },
      fit: () => aim(wholeModel((goal.current ?? current()).q)),
      // Drawn larger for one frame; the canvas is transparent, so the picture is too
      capture: () => {
        const ratio = gl.getPixelRatio()
        const size = gl.getSize(new THREE.Vector2())
        gl.setPixelRatio(Math.min(4, Math.max(ratio, CAPTURE_PX / Math.max(size.x, size.y, 1))))
        try {
          gl.render(scene, camera)
          return gl.domElement.toDataURL('image/png')
        } finally {
          gl.setPixelRatio(ratio)
          gl.render(scene, camera)
        }
      },
    }
    return () => {
      apiRef.current = null
    }
  })

  useFrame((_, dt) => {
    // The field of view holds on the narrower side, so a portrait phone, a rotated tablet or a view shrunk by the
    // details sheet keeps the model framed instead of cropping its sides
    const fov = camera.aspect < 1 ? 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / camera.aspect)) : FOV
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
    if (!controls) return
    const c = current()
    if (spinning) {
      // Turntable: the model turns about the screen's vertical, whatever angle it's being viewed from
      tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(c.q), -SPIN_SPEED * Math.min(dt, 0.05))
      c.q.premultiply(tmpQ)
    } else if (goal.current) {
      const g = goal.current
      const k = reduce || snap.current ? 1 : 1 - Math.exp(-7 * Math.min(dt, 0.05))
      snap.current = false
      c.q.slerp(g.q, k)
      c.target.lerp(g.target, k)
      c.dist += (g.dist - c.dist) * k
      if (c.q.angleTo(g.q) < 1e-3 && c.target.distanceToSquared(g.target) < 1e-6 * span * span && Math.abs(g.dist - c.dist) < 1e-3 * span) goal.current = null
    } else return
    controls.target.copy(c.target)
    camera.position.copy(c.target).addScaledVector(Z.clone().applyQuaternion(c.q), c.dist)
    camera.quaternion.copy(c.q)
    camera.up.set(0, 1, 0).applyQuaternion(c.q) // the trackball keeps this orientation on its next update
  })

  return null
}

type Props = {
  model: Model | null
  wireframe: boolean
  clip: number
  playing: boolean
  spinning: boolean
  onSpinChange: (on: boolean) => void
  viewKey: number // change to reframe the camera on the model
  controlsRef: RefObject<ViewControls | null>
  onRenderer: (gl: THREE.WebGLRenderer) => void
}

export default function Viewer({ model, wireframe, clip, playing, spinning, onSpinChange, viewKey, controlsRef, onRenderer }: Props) {
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const size = model?.size.length() ?? 1

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: FOV, position: [0, 1, 4] }}
      gl={{ antialias: true, toneMapping: THREE.NeutralToneMapping, toneMappingExposure: 1.05 }}
      onCreated={({ gl }) => onRenderer(gl)}
    >
      {/* A soft studio made of light panels, so reflective materials have something to mirror. Built in the
          browser: no HDR file to download. */}
      <Environment resolution={256} environmentIntensity={0.9}>
        <Lightformer form="rect" intensity={2.2} position={[0, 5, -2]} rotation-x={Math.PI / 2} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[-5, 1, 1]} rotation-y={Math.PI / 2} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[5, 1, 1]} rotation-y={-Math.PI / 2} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={1} position={[0, 0, 9]} scale={[14, 9, 1]} />
        <Lightformer form="ring" intensity={0.6} position={[0, -4, 2]} rotation-x={-Math.PI / 2} scale={3} />
      </Environment>
      <hemisphereLight args={[0xffffff, 0x404048, 0.8]} />
      <Headlight />
      {model && (
        <>
          <Piece model={model} wireframe={wireframe} clip={clip} playing={playing} />
          {/* Trackball, not orbit: no poles, so dragging turns the model freely in every direction */}
          <TrackballControls
            makeDefault
            keys={['', '', '']} // its A/S/D shortcuts listen on the whole window
            rotateSpeed={3.2}
            zoomSpeed={1.1}
            panSpeed={0.9}
            dynamicDampingFactor={reduce ? 1 : 0.14}
            minDistance={size * 0.02}
            maxDistance={size * 8}
          />
          <Rig model={model} fitKey={`${model.name}|${model.object.uuid}#${viewKey}`} apiRef={controlsRef} reduce={reduce} spinning={spinning} onSpinChange={onSpinChange} />
        </>
      )}
    </Canvas>
  )
}
