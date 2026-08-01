import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DATE_FORMATS } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { Banner, Empty, Screen, Spinner } from '@/app/components'
import { useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import type { ImportBatch } from '@/data/types'
import { applyMapping, detectSignConvention, guessMapping, readFile, type ColumnMapping, type RawTable } from './parse'
import { runImport, type ImportSummary } from './runImport'

type Step = 'pick' | 'map' | 'done'

export function ImportScreen() {
  const { accounts, refresh, loading } = useAppData()
  const [step, setStep] = useState<Step>('pick')
  const [file, setFile] = useState<File | null>(null)
  const [table, setTable] = useState<RawTable | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [accountId, setAccountId] = useState<string>('')
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** True when a saved profile matched, so the wizard can be skipped. */
  const [knownProfile, setKnownProfile] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void repo.listImportBatches().then(setBatches)
  }, [summary])

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  async function onFile(f: File) {
    setError(null)
    setBusy(true)
    try {
      const parsed = await readFile(f)
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('Kunne ikke finde nogen rækker i filen. Er det et kontoudtog i CSV- eller Excel-format?')
        setBusy(false)
        return
      }

      // A layout seen before needs no wizard — this is what makes repeat
      // imports a two-tap operation.
      const saved = await repo.findBankProfile(parsed.headerSignature)
      setKnownProfile(!!saved)
      setMapping(saved ? toMapping(saved) : guessMapping(parsed))
      setTable(parsed)
      setFile(f)
      setStep('map')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke læse filen.')
    }
    setBusy(false)
  }

  async function doImport() {
    if (!table || !mapping || !file || !accountId) return
    setBusy(true)
    setError(null)
    try {
      const result = await runImport({
        table,
        mapping,
        accountId,
        fileName: file.name,
        saveProfile: true,
      })
      setSummary(result)
      setStep('done')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Importen fejlede.')
    }
    setBusy(false)
  }

  function reset() {
    setStep('pick')
    setFile(null)
    setTable(null)
    setMapping(null)
    setSummary(null)
    setError(null)
    setKnownProfile(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (loading) return <Screen title="Importér"><Spinner /></Screen>

  if (accounts.length === 0) {
    return (
      <Screen title="Importér">
        <Empty
          icon="🏦"
          title="Ingen konti"
          body="Opret en konto først, så ved jeg hvor transaktionerne hører til."
          action={<Link to="/settings" className="btn-primary mt-2">Gå til indstillinger</Link>}
        />
      </Screen>
    )
  }

  return (
    <Screen title="Importér">
      {error && <Banner tone="danger">{error}</Banner>}

      {step === 'pick' && (
        <>
          <div className="card space-y-3">
            <h2 className="font-semibold">Vælg konto</h2>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-500">
              Transaktionerne lægges på denne konto. Overførsler mellem dine egne konti finder jeg selv.
            </p>
          </div>

          <label className="card flex cursor-pointer flex-col items-center gap-2 border-2 border-dashed border-ink-300 py-10 text-center dark:border-ink-700">
            <span className="text-4xl" aria-hidden>📄</span>
            <span className="font-semibold">Vælg kontoudtog</span>
            <span className="text-sm text-ink-500">CSV eller Excel</span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xls,.xlsm,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onFile(f)
              }}
            />
          </label>

          {busy && <Spinner label="Læser filen…" />}

          {batches.length > 0 && (
            <section className="card">
              <h2 className="mb-3 font-semibold">Tidligere importer</h2>
              <ul className="space-y-2">
                {batches.slice(0, 8).map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{b.fileName}</div>
                      <div className="text-xs text-ink-500">
                        {new Date(b.importedAt).toLocaleDateString('da-DK')} · {b.insertedCount} nye
                        {b.duplicateCount > 0 && ` · ${b.duplicateCount} dubletter`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-red-600"
                      onClick={async () => {
                        if (!confirm(`Fortryd importen af "${b.fileName}"? Transaktionerne fjernes.`)) return
                        await repo.undoImportBatch(b.id)
                        setBatches(await repo.listImportBatches())
                        await refresh()
                      }}
                    >
                      Fortryd
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {step === 'map' && table && mapping && (
        <MappingWizard
          table={table}
          mapping={mapping}
          knownProfile={knownProfile}
          accountName={accounts.find((a) => a.id === accountId)?.name ?? ''}
          onChange={setMapping}
          onCancel={reset}
          onConfirm={doImport}
          busy={busy}
        />
      )}

      {step === 'done' && summary && (
        <>
          <Banner tone="success">
            <strong>{summary.inserted}</strong> transaktioner importeret.
          </Banner>

          <div className="card space-y-1.5 text-sm">
            <Row label="Rækker i filen" value={String(summary.totalRows)} />
            <Row label="Nye" value={String(summary.inserted)} />
            <Row label="Allerede importeret" value={String(summary.duplicates)} />
            <Row label="Overførsler koblet sammen" value={String(summary.transfersLinked)} />
            <Row label="Automatisk kategoriseret" value={`${summary.autoCategorised} af ${summary.inserted}`} />
            {summary.needsReview > 0 && <Row label="Til gennemgang" value={String(summary.needsReview)} />}
            {summary.issues.length > 0 && <Row label="Sprunget over" value={String(summary.issues.length)} />}
          </div>

          {summary.issues.length > 0 && (
            <details className="card">
              <summary className="cursor-pointer text-sm font-medium">
                {summary.issues.length} rækker kunne ikke læses
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-ink-500">
                {summary.issues.slice(0, 20).map((i) => (
                  <li key={i.sourceRow}>
                    Række {i.sourceRow}: {i.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex gap-2">
            <Link to="/transactions?filter=uncategorised" className="btn-primary flex-1">
              Kategorisér resten
            </Link>
            <button type="button" className="btn-secondary" onClick={reset}>
              Importér mere
            </button>
          </div>
        </>
      )}
    </Screen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ink-500">{label}</span>
      <span className="tnum font-semibold">{value}</span>
    </div>
  )
}

/**
 * Column mapping with a live preview.
 *
 * The preview is the point: it shows exactly what will be stored, so a wrong
 * amount column or a day/month swap is visible before it silently corrupts
 * six months of budget history.
 */
function MappingWizard({
  table,
  mapping,
  knownProfile,
  accountName,
  onChange,
  onCancel,
  onConfirm,
  busy,
}: {
  table: RawTable
  mapping: ColumnMapping
  knownProfile: boolean
  accountName: string
  onChange: (m: ColumnMapping) => void
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  const preview = applyMapping({ ...table, rows: table.rows.slice(0, 60) }, mapping)
  const sign = detectSignConvention(preview.rows)
  const set = (patch: Partial<ColumnMapping>) => onChange({ ...mapping, ...patch })

  const failureRate = table.rows.length > 0 ? preview.issues.length / Math.min(table.rows.length, 60) : 0

  return (
    <>
      {knownProfile ? (
        <Banner tone="success">Jeg genkender formatet fra sidst — tjek forhåndsvisningen og tryk importér.</Banner>
      ) : (
        <Banner tone="info">Nyt filformat. Tjek at kolonnerne er koblet rigtigt — så husker jeg det til næste gang.</Banner>
      )}

      {failureRate > 0.3 && (
        <Banner tone="danger">
          {preview.issues.length} af de første rækker kunne ikke læses. Prøv at ændre dato- eller beløbskolonnen.
        </Banner>
      )}

      {sign.likelyInverted && !mapping.invertSign && (
        <Banner
          tone="warn"
          action={
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => set({ invertSign: true })}>
              Vend fortegn
            </button>
          }
        >
          {sign.reason}
        </Banner>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold">Kolonner</h2>

        <Field label="Dato">
          <select className="field" value={mapping.dateColumn} onChange={(e) => set({ dateColumn: e.target.value })}>
            {table.headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </Field>

        <Field label="Datoformat">
          <select
            className="field"
            value={mapping.dateFormat}
            onChange={(e) => set({ dateFormat: e.target.value as ColumnMapping['dateFormat'] })}
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>

        <Field label="Beløb">
          <select
            className="field"
            value={mapping.amountMode}
            onChange={(e) => set({ amountMode: e.target.value as ColumnMapping['amountMode'] })}
          >
            <option value="single">Én beløbskolonne</option>
            <option value="debit-credit">Separate kolonner for ind og ud</option>
          </select>
        </Field>

        {mapping.amountMode === 'single' ? (
          <Field label="Beløbskolonne">
            <select
              className="field"
              value={mapping.amountColumn ?? ''}
              onChange={(e) => set({ amountColumn: e.target.value || null })}
            >
              <option value="">— vælg —</option>
              {table.headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Hævet (ud)">
              <select
                className="field"
                value={mapping.debitColumn ?? ''}
                onChange={(e) => set({ debitColumn: e.target.value || null })}
              >
                <option value="">— vælg —</option>
                {table.headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </Field>
            <Field label="Indsat (ind)">
              <select
                className="field"
                value={mapping.creditColumn ?? ''}
                onChange={(e) => set({ creditColumn: e.target.value || null })}
              >
                <option value="">— vælg —</option>
                {table.headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </Field>
          </>
        )}

        <Field label="Tekst (kan vælges flere)">
          <div className="flex flex-wrap gap-2">
            {table.headers.map((h) => {
              const on = mapping.descriptionColumns.includes(h)
              return (
                <button
                  key={h}
                  type="button"
                  className={on ? 'chip-on' : 'chip-off'}
                  onClick={() =>
                    set({
                      descriptionColumns: on
                        ? mapping.descriptionColumns.filter((c) => c !== h)
                        : [...mapping.descriptionColumns, h],
                    })
                  }
                >
                  {h}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Saldo (valgfri)">
          <select
            className="field"
            value={mapping.balanceColumn ?? ''}
            onChange={(e) => set({ balanceColumn: e.target.value || null })}
          >
            <option value="">— ingen —</option>
            {table.headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </Field>

        <Field label="Transaktions-ID (valgfri)">
          <select
            className="field"
            value={mapping.idColumn ?? ''}
            onChange={(e) => set({ idColumn: e.target.value || null })}
          >
            <option value="">— ingen —</option>
            {table.headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Bankens eget id. Bruges til at genkende transaktioner du allerede har importeret.
          </p>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={mapping.invertSign}
            onChange={(e) => set({ invertSign: e.target.checked })}
          />
          Vend fortegn (udgifter står som positive tal)
        </label>
      </section>

      <section className="card">
        <h2 className="mb-2 font-semibold">Sådan bliver det læst</h2>
        {preview.rows.length === 0 ? (
          <p className="text-sm text-red-600">Ingen rækker kunne læses med denne opsætning.</p>
        ) : (
          <ul className="space-y-2">
            {preview.rows.slice(0, 6).map((r) => (
              <li key={r.sourceRow} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.rawText}</span>
                  <span className="text-xs text-ink-500">{r.date}</span>
                </span>
                <span className={`tnum shrink-0 font-semibold ${r.amountMinor > 0 ? 'text-emerald-600' : ''}`}>
                  {formatMoney(r.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-500">
          {preview.rows.length} af {Math.min(table.rows.length, 60)} viste rækker kunne læses. Importeres til{' '}
          <strong>{accountName}</strong>.
        </p>
      </section>

      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" onClick={onConfirm} disabled={busy || preview.rows.length === 0}>
          {busy ? 'Importerer…' : 'Importér'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Annullér
        </button>
      </div>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
    </div>
  )
}

function toMapping(profile: {
  delimiter: string
  dateColumn: string
  dateFormat: ColumnMapping['dateFormat']
  amountMode: ColumnMapping['amountMode']
  amountColumn: string | null
  debitColumn: string | null
  creditColumn: string | null
  descriptionColumns: string[]
  balanceColumn: string | null
  idColumn?: string | null
  decimalSeparator: ColumnMapping['decimalSeparator']
  invertSign: boolean
  skipRows: number
}): ColumnMapping {
  return {
    delimiter: profile.delimiter,
    dateColumn: profile.dateColumn,
    dateFormat: profile.dateFormat,
    amountMode: profile.amountMode,
    amountColumn: profile.amountColumn,
    debitColumn: profile.debitColumn,
    creditColumn: profile.creditColumn,
    descriptionColumns: profile.descriptionColumns,
    balanceColumn: profile.balanceColumn,
    // Older saved profiles predate id-column support.
    idColumn: profile.idColumn ?? null,
    decimalSeparator: profile.decimalSeparator,
    invertSign: profile.invertSign,
    skipRows: profile.skipRows,
  }
}
