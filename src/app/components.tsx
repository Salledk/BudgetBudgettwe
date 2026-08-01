import { useEffect, type ReactNode } from 'react'
import { addMonths, formatMonthLabel, currentMonth, type IsoMonth } from '@/lib/dates'

export function Screen({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-full pb-safe">
      <header className="pt-safe sticky top-0 z-20 border-b border-ink-200 bg-ink-100/90 backdrop-blur dark:border-ink-800 dark:bg-ink-950/90">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-xl font-bold">{title}</h1>
          {action}
        </div>
      </header>
      <main className="space-y-4 p-4">{children}</main>
    </div>
  )
}

export function MonthPicker({ month, onChange }: { month: IsoMonth; onChange: (m: IsoMonth) => void }) {
  const isCurrent = month === currentMonth()
  return (
    <div className="flex items-center justify-between rounded-xl bg-white px-2 py-1.5 dark:bg-ink-900">
      <button
        type="button"
        className="rounded-lg px-3 py-1.5 text-lg leading-none text-ink-500"
        onClick={() => onChange(addMonths(month, -1))}
        aria-label="Forrige måned"
      >
        ‹
      </button>
      <span className="text-sm font-semibold">{formatMonthLabel(month)}</span>
      <button
        type="button"
        className="rounded-lg px-3 py-1.5 text-lg leading-none text-ink-500 disabled:opacity-25"
        onClick={() => onChange(addMonths(month, 1))}
        disabled={isCurrent}
        aria-label="Næste måned"
      >
        ›
      </button>
    </div>
  )
}

export function Empty({ icon, title, body, action }: { icon: string; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 py-10 text-center">
      <div className="text-4xl">{icon}</div>
      <h2 className="font-semibold">{title}</h2>
      <p className="max-w-xs text-sm text-ink-500">{body}</p>
      {action}
    </div>
  )
}

export function Spinner({ label = 'Indlæser…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-ink-500">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-ink-600" />
      {label}
    </div>
  )
}

/** Bottom sheet. Locks background scroll while open — otherwise iOS scrolls the page behind it. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-black/40" onClick={onClose} aria-label="Luk" />
      <div className="relative max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-ink-100 p-4 pb-8 shadow-2xl dark:bg-ink-950">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-300 dark:bg-ink-700" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose}>
            Luk
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ProgressBar({ ratio, color, over }: { ratio: number; color?: string; over?: boolean }) {
  const pct = Math.min(Math.max(ratio, 0), 1) * 100
  const overflow = ratio > 1 ? Math.min((ratio - 1) * 100, 100) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
      <div className="flex h-full">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: over ? '#dc2626' : (color ?? '#0f172a') }}
        />
        {overflow > 0 && <div className="h-full bg-red-600/50" style={{ width: `${overflow}%` }} />}
      </div>
    </div>
  )
}

/** Compact bar chart of monthly history. Purely decorative — values are in the text. */
export function Sparkline({ values, color = '#64748b' }: { values: number[]; color?: string }) {
  if (values.length === 0) return null
  const max = Math.max(...values, 1)
  return (
    <div className="flex h-6 items-end gap-0.5" aria-hidden>
      {values.map((v, i) => (
        <div
          key={i}
          className="w-full rounded-sm"
          style={{ height: `${Math.max((v / max) * 100, 4)}%`, backgroundColor: color, opacity: v === 0 ? 0.2 : 0.75 }}
        />
      ))}
    </div>
  )
}

export function Banner({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success'
  children: ReactNode
  action?: ReactNode
}) {
  const tones = {
    info: 'bg-blue-50 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200',
    warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    danger: 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200',
    success: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200',
  }
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${tones[tone]}`}>
      <div className="flex-1">{children}</div>
      {action}
    </div>
  )
}
