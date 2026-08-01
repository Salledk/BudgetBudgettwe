# Budget

A mobile-first budgeting app driven by bank statement uploads. Everything runs
in the browser and all data stays on the device — no server, no login, no bank
credentials.

## Running it

```bash
npm install
npm run dev        # development
npm run build      # production build into dist/
npm run preview    # serve the production build
npm test           # 156 tests
```

`dist/` is static — it can be hosted anywhere, and installs to a phone home
screen as a PWA that works offline.

## How it works

### Importing

Drop a CSV or Excel export from your bank onto the Import screen. The app:

1. **Detects the encoding.** Danish exports are frequently Windows-1252 rather
   than UTF-8; decoding wrongly turns every `Føtex` into `FÃ¸tex` and poisons
   every rule that depends on merchant names.
2. **Guesses the column mapping** from header names, then sanity-checks the
   guess against actual cell contents and shows a preview of what will be
   stored. A wrong amount column is silent corruption, not a visible error, so
   it is worth confirming before importing.
3. **Remembers the layout.** The mapping is saved against the file's header
   signature, so every subsequent import from the same bank is two taps.
4. **Skips duplicates.** Re-importing an overlapping statement adds only the
   new rows. Two genuinely identical purchases on the same day both survive —
   the fingerprint includes an occurrence index.
5. **Pairs transfers between your own accounts** (see below).
6. **Categorises** what it can.

Every import can be undone as a batch.

### Accounts

Three are created by default (budget, spending, savings) and more can be added.
They exist for three concrete reasons, not as bookkeeping ceremony:

- imports and duplicate detection are inherently per-account;
- **transfer detection** needs them — when 9.000 kr moves from budget to
  spending, that is not 9.000 kr of income and 9.000 kr of expense. Matching
  the two halves (equal amount, opposite sign, different accounts, within three
  days) and excluding them is what keeps every total honest;
- the savings balance is what makes "am I actually saving?" answerable.

Budgets and categories are **global**, not per-account, so accounts stay out of
the way in daily use.

### Categorisation

Three layers, first match wins:

1. **Your rules** — always beat everything else.
2. **Built-in Danish merchant rules** — Netto, Føtex, Rema, Circle K, DSB,
   Spotify, Ørsted, Tryg and around 150 others.
3. **Learned** — a merchant you have categorised consistently before. Requires
   at least two past transactions agreeing at 70%+, and the result lands in a
   review queue rather than being applied silently.

Matching runs against a normalised *merchant key*, not raw bank text. All three
of these collapse to `netto`:

```
NETTO 1234 KØBENHAVN DEN 12.03
Netto 5521 Aarhus C  Den 03.04
VISA/DANKORT NETTO 1234
```

Store numbers, embedded dates, card references, receipt numbers and trailing
city names are all stripped, because they vary per transaction and would
otherwise make every visit look like a different shop.

MobilePay payments to people are deliberately left uncategorised — "MobilePay
Anders" could be rent, a shared dinner or a gift, and guessing wrong is worse
than leaving it blank.

When you recategorise something manually, the app offers to remember it. Saying
yes creates a rule and back-fills matching past transactions immediately.

### Budget suggestions

Derived from your history, per category, over the months that actually contain
data — not the last N calendar months, since statements are usually uploaded
weeks late.

A plain average is wrong in two opposite directions: an annual insurance
premium makes one month look catastrophic and eleven look cheap, while steady
rent needs no smoothing at all. So categories are classified first:

| Pattern | Test | Estimator |
|---|---|---|
| **Recurring** | present in ≥80% of months, spread <15% | median |
| **Variable** | everything else with regular activity | trimmed mean, plus a 75th-percentile "safe" figure |
| **Sparse** | present in <50% of months | total spread evenly across the window |

Large irregular payments are detected with a median-absolute-deviation test and
held **out** of the monthly figure, then surfaced separately as an amount to set
aside each month — so the annual insurance and the summer holiday are
provisioned for instead of arriving as a surprise.

Every suggested figure is editable before it is saved.

### Projections

For the current month, per category:

- **Recurring** categories whose bill has already landed project to exactly
  what was paid. The naive approach — scale spending so far by days remaining —
  would project rent paid on the 1st to 8.500 × 30 by month end.
- **Recurring** categories still unpaid project to their usual amount.
- **Variable** categories extrapolate the daily rate across the remaining days,
  blended toward the historical median for the first ten days (one 800 kr shop
  on the 2nd would otherwise project to 12.400 kr).

Categories are flagged **on track**, **at risk** or **over**, and the dashboard
shows the most urgent in plain language:

> Dagligvarer: 2.480 kr brugt af 2.200 kr — allerede 280 kr over.

A month with nothing imported yet reports no forecast at all, rather than
showing expected income with no expenses beside it.

## Your data

Stored in IndexedDB in this browser on this device. Nothing is transmitted
anywhere. **Take a backup from Settings before changing phone or browser** —
there is no copy anywhere else.

The schema is sync-ready: every record carries a globally-unique sortable id,
an `updatedAt` for last-write-wins merging, and a `deletedAt` tombstone so
deletions could propagate. `src/data/sync.ts` defines the adapter interface;
only the no-op local implementation exists today. Adding a backend later is a
matter of writing one adapter, not reshaping the data.

## Layout

```
src/
  lib/            money, dates, stats, text normalisation  — pure, heavily tested
  data/           Dexie schema, repository layer, seeds, sync interface
  features/
    import/       parsing, column mapping, dedup, transfer pairing
    categorize/   the three-layer engine and its UI
    transactions/ list, filters, bulk categorisation
    budget/       suggestion engine and budget screen
    projections/  forecasting, dashboard, alerts
    settings/     accounts, categories, rules, backup
  app/            shell, routing, shared components, data context
```

`src/data/repo.ts` is the only module that touches the database.

## Conventions

- **Money is never a float.** Amounts are signed integers in øre; negative means
  money left the account. Formatting happens only at render time.
- **Dates are plain ISO days** (`2026-03-14`) with no time and no timezone. A
  transaction happens on a day, and attaching a zone to it only creates
  opportunities for it to drift into the previous month.
- **Nothing is hard-deleted.** Everything is soft-deleted with a tombstone.

## Notes

The importer handles CSV and Excel. PDF statements are not supported — parsing
them reliably is a substantially different problem, and every Danish bank offers
a CSV export.
