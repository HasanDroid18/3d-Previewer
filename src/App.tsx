import {
  ArrowArcLeftIcon,
  ArrowArcRightIcon,
  ArrowsCounterClockwiseIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  CameraIcon,
  CornersOutIcon,
  CubeIcon,
  CubeTransparentIcon,
  FlipVerticalIcon,
  FolderOpenIcon,
  InfoIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PauseIcon,
  PlayIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState } from 'react'
import type * as THREE from 'three'
import { ACCEPT, FORMATS, loadFiles, LoadError, sampleModel, type Model } from './load'
import Viewer, { type ViewControls } from './Viewer'

// Open a model by choosing or dropping it (with its textures, a folder or a zip), then turn it, spin it and
// inspect it. Nothing is uploaded; the files stay in the browser.

const tool =
  'grid size-11 shrink-0 place-items-center rounded-full text-ink transition-[background-color,color,transform] duration-150 ease-out hover:bg-ink/10 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-ink aria-pressed:text-paper'
const pill =
  'inline-flex h-11 items-center gap-2 rounded-full border border-ink/25 px-5 text-[0.9rem] transition-[background-color,color,border-color,transform] duration-200 ease-out hover:border-ink hover:bg-ink hover:text-paper active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40'
// Phones and tablets: no accept filter, because iOS and Android grey out extensions they have no file type for (.glb, .stl…)
const touch = window.matchMedia('(pointer: coarse)').matches
// Clear of the notch
const top = 'top-[max(0.75rem,env(safe-area-inset-top))]'
const card = 'rounded-2xl border border-line bg-paper-2/80 shadow-[0_8px_40px_-12px_rgb(0_0_0/0.25)] backdrop-blur-xl'

// A dropped folder arrives as an entry to walk, not as its files. The entries must be read before the first await,
// while the drop event still holds them.
async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (!entries.some((e) => e.isDirectory)) return [...dt.files]
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) return void out.push(await new Promise<File>((ok, fail) => (e as FileSystemFileEntry).file(ok, fail)))
    const reader = (e as FileSystemDirectoryEntry).createReader()
    // readEntries hands back a batch at a time until it returns none
    for (let batch; (batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail))).length; ) await Promise.all(batch.map(walk))
  }
  await Promise.all(entries.map(walk))
  return out
}

const num = (n: number) => n.toLocaleString()
const measure = (v: number) => Number(v.toPrecision(4)).toLocaleString()

export default function App() {
  const [model, setModel] = useState<Model | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [spinning, setSpinning] = useState(false)
  const [wireframe, setWireframe] = useState(false)
  const [clip, setClip] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [viewKey, setViewKey] = useState(0)
  const [panel, setPanel] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  const [fullscreen, setFullscreen] = useState(false)
  const renderer = useRef<THREE.WebGLRenderer | null>(null)
  const view = useRef<ViewControls | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const ticket = useRef(0) // the latest open wins when files are opened while another is loading
  const id = useId()

  useEffect(() => () => model?.dispose(), [model]) // free the GPU memory of the model being replaced
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const show = (m: Model) => {
    setSpinning(false)
    setWireframe(false)
    setClip(0)
    setPlaying(true)
    setModel(m)
  }

  const open = async (files: File[]) => {
    if (!files.length) return
    const t = ++ticket.current
    setError('')
    setLoading(true)
    try {
      const m = await loadFiles(files, renderer.current ?? undefined)
      if (t === ticket.current) show(m)
      else m.dispose()
    } catch (e) {
      if (t !== ticket.current) return
      if (!(e instanceof LoadError)) console.error(e)
      setError(e instanceof LoadError ? e.message : `Couldn't open ${files[0].name}.`)
    } finally {
      if (t === ticket.current) setLoading(false)
    }
  }

  // A button move replaces the turntable spin
  const move = (fn: (v: ViewControls) => void) => () => {
    setSpinning(false)
    if (view.current) fn(view.current)
  }
  const reset = () => {
    setSpinning(false)
    setViewKey((k) => k + 1)
  }
  const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})
  const saveImage = () => {
    const url = view.current?.capture()
    if (!url || !model) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${model.name.replace(/\.[^.]+$/, '')}.png`
    a.click()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest?.('input, select, textarea')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        return input.current?.click()
      }
      if (!model || e.metaKey || e.ctrlKey || e.altKey || (e.key === ' ' && t.closest?.('button'))) return
      const v = view.current
      const keys: Record<string, () => void> = {
        ArrowLeft: () => v?.turn(-30, 0),
        ArrowRight: () => v?.turn(30, 0),
        ArrowUp: () => v?.turn(0, 30),
        ArrowDown: () => v?.turn(0, -30),
        '+': () => v?.zoom(0.8),
        '=': () => v?.zoom(0.8),
        '-': () => v?.zoom(1.25),
        f: () => v?.fit(),
        r: reset,
        w: () => setWireframe((w) => !w),
        ' ': () => setSpinning((s) => !s),
      }
      const fn = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key]
      if (!fn) return
      e.preventDefault()
      if (e.key !== ' ' && e.key.toLowerCase() !== 'w') setSpinning(false)
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model])

  const s = model?.stats
  const details: [string, string][] = model
    ? [
        ['Format', model.format.toUpperCase()],
        ['Size', `${[model.size.x, model.size.y, model.size.z].map(measure).join(' × ')}${model.unit ? ` ${model.unit}` : ''}`],
        ...(s!.meshes ? ([['Triangles', num(s!.triangles)], ['Vertices', num(s!.vertices)], ['Meshes', num(s!.meshes)]] as [string, string][]) : []),
        ...(s!.points ? ([['Points', num(s!.points)]] as [string, string][]) : []),
        ['Materials', num(s!.materials)],
        ...(model.clips.length ? ([['Animations', num(model.clips.length)]] as [string, string][]) : []),
      ]
    : []

  return (
    <div
      className="stage relative flex h-dvh flex-col overflow-hidden text-ink"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setDragging(false)
        open(await droppedFiles(e.dataTransfer))
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={touch ? undefined : ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          open([...(e.target.files ?? [])])
          e.target.value = '' // allow choosing the same file again
        }}
      />

      {/* Everything over the 3D view. On phones the details sheet sits below it, and the view shrinks to make room. */}
      <div className="relative min-h-0 flex-1">
        <section
          aria-label="3D preview"
          aria-describedby={model ? `${id}-hint` : undefined}
          className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        >
          <Viewer
            model={model}
            wireframe={wireframe}
            clip={clip}
            playing={playing}
            spinning={spinning}
            onSpinChange={setSpinning}
            viewKey={viewKey}
            controlsRef={view}
            onRenderer={(gl) => (renderer.current = gl)}
          />
        </section>

        {/* Header */}
        <header className={`pointer-events-none absolute inset-x-0 ${top} flex items-start justify-between gap-3 px-[max(0.75rem,env(safe-area-inset-left))] sm:px-4`}>
          <div className={`${card} pointer-events-auto flex min-w-0 items-center gap-3 py-1.5 pr-4 pl-1.5`}>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-paper">
              <CubeIcon size={18} weight="bold" aria-hidden />
            </span>
            <div className="min-w-0 leading-tight">
              <h1 className="text-[0.95rem] font-semibold">3D Preview</h1>
              <p className="truncate text-[0.8rem] text-muted">{model ? model.name : 'Any 3D file, right in the browser'}</p>
            </div>
          </div>
          <div className="pointer-events-auto flex gap-2">
            <button className={`${pill} ${card} border-line max-sm:w-11 max-sm:justify-center max-sm:px-0`} aria-label="Open a model" onClick={() => input.current?.click()} aria-keyshortcuts="Meta+O Control+O">
              <FolderOpenIcon size={18} aria-hidden />
              <span className="hidden sm:inline">Open</span>
            </button>
            {model && (
              <button className={`${tool} ${card} size-11`} aria-pressed={panel} aria-label="Model details" title="Model details" onClick={() => setPanel((p) => !p)}>
                <InfoIcon size={20} aria-hidden />
              </button>
            )}
          </div>
        </header>

        {/* Empty state */}
        {!model && !loading && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
            <div className={`${card} pointer-events-auto flex max-h-full w-full max-w-md flex-col items-center gap-5 overflow-y-auto px-6 py-9 text-center sm:px-10 [@media(max-height:520px)]:gap-3 [@media(max-height:520px)]:py-5`}>
              <CubeTransparentIcon size={44} weight="thin" className="shrink-0 text-accent [@media(max-height:520px)]:hidden" aria-hidden />
              <div>
                <h2 className="text-[1.6rem] leading-tight font-semibold tracking-tight">{touch ? 'Open a 3D model' : 'Drop a 3D model'}</h2>
                <p className="mt-2 text-[0.95rem] leading-relaxed text-muted">
                  {touch ? 'Choose a file, or pick its textures and .bin files with it, or a .zip.' : 'Drag in a file, a whole folder or a .zip, so textures and .bin files come along.'}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <button className={`${pill} border-ink bg-ink text-paper hover:bg-ink/85`} onClick={() => input.current?.click()}>
                  <FolderOpenIcon size={18} aria-hidden />
                  Choose files
                </button>
                <button className={pill} onClick={() => show(sampleModel())}>
                  Try a sample
                </button>
              </div>
              <p className="text-[0.75rem] leading-relaxed tracking-wide text-muted uppercase [@media(max-height:520px)]:hidden">{FORMATS.join(' · ')}</p>
            </div>
          </div>
        )}

        {loading && (
          <p role="status" className="absolute inset-0 grid place-items-center bg-paper/60 text-muted backdrop-blur-sm">
            <span className="animate-pulse">Preparing the model</span>
          </p>
        )}

        {error && (
          <div role="alert" className={`${card} absolute bottom-3 left-1/2 sm:bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+4.25rem)] flex w-[min(30rem,calc(100%-1.5rem))] -translate-x-1/2 items-start gap-3 p-4 text-[0.9rem] leading-relaxed`}>
            <WarningIcon size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <p className="flex-1">{error}</p>
            <button className={`${tool} -m-2 size-9`} aria-label="Dismiss" onClick={() => setError('')}>
              <XIcon size={16} aria-hidden />
            </button>
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-3xl border-2 border-dashed border-accent bg-paper/70 backdrop-blur-sm sm:inset-4">
            <p className="text-[1.4rem] font-semibold">Drop to open</p>
          </div>
        )}
      </div>

      {/* Details */}
      {/* View toolbar: over the view from sm up; on phones a row of its own, so it never hides the model */}
      {model && (
        <div
          className={`pointer-events-none relative flex shrink-0 flex-col items-center gap-2 px-3 pt-2 ${panel ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'} sm:absolute sm:inset-x-0 sm:bottom-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-0 sm:px-3`}
        >
          <p id={`${id}-hint`} className={`rounded-full bg-paper/60 px-3 py-1 text-center text-[0.8rem] text-muted backdrop-blur-sm [@media(max-height:520px)]:hidden ${panel ? 'max-sm:hidden' : ''}`}>
            {touch ? 'Drag to turn. Pinch to zoom. Double-tap to look closer.' : 'Drag to turn. Pinch or scroll to zoom. Double-click to look closer.'}
          </p>
          <div role="toolbar" aria-label="View" className={`${card} pointer-events-auto flex max-w-full items-center overflow-x-auto rounded-full p-1 sm:gap-1`}>
            <button className={`${tool} max-sm:hidden`} aria-label="Turn left" title="Turn left (←)" onClick={move((v) => v.turn(-45, 0))}>
              <ArrowArcLeftIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={`${tool} max-sm:hidden`} aria-label="Turn right" title="Turn right (→)" onClick={move((v) => v.turn(45, 0))}>
              <ArrowArcRightIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={tool} aria-label="Turn over" title="Turn over" onClick={move((v) => v.turn(0, 180))}>
              <FlipVerticalIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={`${tool} max-md:hidden`} aria-label="Zoom in" title="Zoom in (+)" onClick={move((v) => v.zoom(0.75))}>
              <MagnifyingGlassPlusIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={`${tool} max-md:hidden`} aria-label="Zoom out" title="Zoom out (−)" onClick={move((v) => v.zoom(1.33))}>
              <MagnifyingGlassMinusIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={tool} aria-label="Fit in view" aria-keyshortcuts="F" title="Fit in view (F)" onClick={move((v) => v.fit())}>
              <CornersOutIcon size={20} weight="light" aria-hidden />
            </button>
            <button
              className={`${tool} w-auto px-2.5 text-[0.85rem] sm:px-3.5 font-medium tabular-nums`}
              aria-pressed={spinning}
              aria-label="Spin 360 degrees"
              aria-keyshortcuts="Space"
              title={spinning ? 'Stop spinning (Space)' : 'Spin 360° (Space)'}
              onClick={() => setSpinning((s) => !s)}
            >
              360°
            </button>
            <button className={tool} aria-pressed={wireframe} aria-label="Wireframe" aria-keyshortcuts="W" title="Wireframe (W)" onClick={() => setWireframe((w) => !w)}>
              <CubeTransparentIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={tool} aria-label="Reset view" aria-keyshortcuts="R" title="Reset view (R)" onClick={reset}>
              <ArrowsCounterClockwiseIcon size={20} weight="light" aria-hidden />
            </button>
            <button className={tool} aria-label="Save image" title="Save image" onClick={saveImage}>
              <CameraIcon size={20} weight="light" aria-hidden />
            </button>
            {document.fullscreenEnabled && (
              <button className={tool} aria-pressed={fullscreen} aria-label="Full screen" title="Full screen" onClick={toggleFullscreen}>
                {fullscreen ? <ArrowsInIcon size={20} weight="light" aria-hidden /> : <ArrowsOutIcon size={20} weight="light" aria-hidden />}
              </button>
            )}
          </div>
        </div>
      )}

      {model && panel && (
        <aside
          aria-label="Model details"
          className={`${card} mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] max-h-[42dvh] shrink-0 overflow-y-auto overscroll-contain p-5 sm:absolute sm:top-[calc(max(1rem,env(safe-area-inset-top))+4rem)] sm:right-[max(1rem,env(safe-area-inset-right))] sm:m-0 sm:max-h-[calc(100dvh-12rem)] sm:w-80`}
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[0.95rem] font-semibold break-all">{model.name}</h2>
            <button className={`${tool} -mt-2 -mr-2 size-9`} aria-label="Close details" onClick={() => setPanel(false)}>
              <XIcon size={16} aria-hidden />
            </button>
          </div>
          {model.clips.length > 0 && (
            <div className="mt-4">
              <label htmlFor={`${id}-clip`} className="block text-[0.8rem] text-muted">
                Animation
              </label>
              <div className="mt-2 flex items-center gap-2">
                <select
                  id={`${id}-clip`}
                  value={clip}
                  onChange={(e) => setClip(+e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-full border border-ink/25 bg-paper px-4 text-[0.9rem] text-ink"
                >
                  {model.clips.map((c, i) => (
                    <option key={i} value={i}>
                      {c.name || `Animation ${i + 1}`} ({c.duration.toFixed(1)} s)
                    </option>
                  ))}
                </select>
                <button className={`${tool} border border-ink/25`} aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
                  {playing ? <PauseIcon size={18} weight="fill" aria-hidden /> : <PlayIcon size={18} weight="fill" aria-hidden />}
                </button>
              </div>
            </div>
          )}

          <dl className={`mt-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[0.9rem] ${model.clips.length ? 'border-t border-line pt-4' : ''}`}>
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 border-t border-line pt-5 text-[0.85rem] leading-relaxed text-muted">
            <p className="mb-2 font-medium text-ink">Controls</p>
            <ul className="space-y-1">
              <li>Drag to turn in any direction</li>
              <li>{touch ? 'Two fingers to move' : 'Right-drag or two fingers to move'}</li>
              <li>{touch ? 'Pinch to zoom' : 'Scroll or pinch to zoom'}</li>
              <li>{touch ? 'Double-tap a spot to look closer' : 'Double-click a spot to look closer'}</li>
              <li className="pointer-coarse:hidden">
                <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> turn, <kbd>+</kbd> <kbd>−</kbd> zoom, <kbd>F</kbd> fit, <kbd>R</kbd> reset, <kbd>W</kbd> wireframe, <kbd>Space</kbd> 360°
              </li>
            </ul>
          </div>
        </aside>
      )}
    </div>
  )
}
