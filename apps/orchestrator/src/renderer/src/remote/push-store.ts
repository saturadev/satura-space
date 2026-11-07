import { PUSH_DB_NAME, PUSH_DB_STORE } from '../../../shared/remote-push'

let opening: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PUSH_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PUSH_DB_STORE)) req.result.createObjectStore(PUSH_DB_STORE)
    }
    req.onsuccess = () => {
      const d = req.result
      d.onversionchange = () => {
        d.close()
        opening = null
      }
      resolve(d)
    }
    req.onerror = () => {
      opening = null
      reject(req.error ?? new Error("IndexedDB didn't open"))
    }
    req.onblocked = () => {
      opening = null
      reject(new Error('IndexedDB is blocked'))
    }
  })
  return opening
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db()
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(PUSH_DB_STORE, mode)
    const req = fn(tx.objectStore(PUSH_DB_STORE))
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'))
  })
}

export function storeGet<T>(key: string): Promise<T | undefined> {
  return run<T>('readonly', (s) => s.get(key))
}

export async function storePut(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key))
}

export async function storeDelete(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key))
}

export interface StoredPushKey {
  key: CryptoKey
  endpoint: string
  at: number
}

export interface PendingOpen {
  link: unknown
  tag: string
  at: number
}

export interface StoredMacName {
  name: string
  at: number
}
