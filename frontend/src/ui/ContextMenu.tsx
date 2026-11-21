import { useEffect, useSyncExternalStore, type ReactNode } from 'react'

export interface CtxItem {
  label: string
  hint?: string
  onClick?: () => void
  danger?: boolean
  divider?: boolean
  swatches?: { color: string; onPick: () => void }[]
  icon?: ReactNode
}

let state: { x: number; y: number; items: CtxItem[] } | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((s) => s())

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: CtxItem[]) {
  e.preventDefault?.()
  state = { x: e.clientX, y: e.clientY, items }
  emit()
}
const close = () => { state = null; emit() }

export function ContextMenuHost() {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)
  useEffect(() => {
    if (!s) return
    const h = () => close()
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    setTimeout(() => window.addEventListener('pointerdown', h), 0)
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('keydown', k) }
  }, [s])
  if (!s) return null
  const x = Math.min(s.x, window.innerWidth - 220)
  const y = Math.min(s.y, window.innerHeight - s.items.length * 28 - 16)
  return (
    <div
      className="fixed z-[100] w-[210px] rounded-[7px] border border-line bg-ink-2 p-1 shadow-[0_14px_36px_rgba(0,0,0,0.6)]"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {s.items.map((it, i) =>
        it.divider ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : it.swatches ? (
          <div key={i} className="flex flex-wrap gap-[5px] px-2 py-[6px]">
            {it.swatches.map((sw) => (
              <button key={sw.color} className="size-[16px] rounded-full ring-1 ring-black/40 hover:scale-110" style={{ background: sw.color }} onClick={() => { sw.onPick(); close() }} aria-label={`Colour ${sw.color}`} />
            ))}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            onClick={() => { it.onClick?.(); close() }}
            className={`flex w-full items-center justify-between gap-3 rounded-[4px] px-2 py-[5px] text-left text-[12px] hover:bg-ink-3 ${it.danger ? 'text-rec' : 'text-fg'}`}
          >
            <span className="flex items-center gap-2">{it.icon}{it.label}</span>
            {it.hint && <span className="num text-[10px] text-fg-3">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}
