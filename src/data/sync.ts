import type { BaseRecord } from './types'

/**
 * Sync is not implemented — this file exists so that adding it later is a
 * matter of writing one adapter rather than reshaping the data model.
 *
 * The model is already sync-ready: every record has a globally-unique sortable
 * `id`, an `updatedAt` for last-write-wins conflict resolution, and a
 * `deletedAt` tombstone so deletions can propagate. A backend adapter needs to
 * push records changed since the last cursor and merge what comes back by
 * comparing `updatedAt` per record.
 */
export interface SyncAdapter {
  readonly name: string
  /** Records changed remotely since `cursor`. */
  pull(cursor: number): Promise<{ records: Record<string, BaseRecord[]>; cursor: number }>
  /** Send locally-changed records upstream. */
  push(records: Record<string, BaseRecord[]>): Promise<void>
  isConfigured(): boolean
}

export const noopSyncAdapter: SyncAdapter = {
  name: 'local-only',
  async pull() {
    return { records: {}, cursor: 0 }
  },
  async push() {
    // Local-only: nothing leaves the device.
  },
  isConfigured() {
    return false
  },
}

let active: SyncAdapter = noopSyncAdapter

export function getSyncAdapter(): SyncAdapter {
  return active
}

export function setSyncAdapter(adapter: SyncAdapter): void {
  active = adapter
}

/** Last-write-wins merge, the rule a future adapter should apply per record. */
export function mergeRecord<T extends BaseRecord>(local: T | undefined, remote: T): T {
  if (!local) return remote
  return remote.updatedAt > local.updatedAt ? remote : local
}
