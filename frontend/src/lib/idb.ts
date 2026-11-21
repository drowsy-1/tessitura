// Minimal IndexedDB key/value store for audio blobs. Every call fails soft: private windows,
// blocked storage or quota errors just mean audio isn't cached between visits.
const DB = 'tessitura'
const STORE = 'assets'
let dbp: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbp
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve) => {
        if (!d) return resolve(null)
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export const idbPut = (key: string, value: Blob) => run('readwrite', (s) => s.put(value, key))
export const idbGet = (key: string) => run<Blob>('readonly', (s) => s.get(key) as IDBRequest<Blob>)
export const idbKeys = () => run<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((k) => (k ?? []).map(String))
export const idbDelete = (key: string) => run('readwrite', (s) => s.delete(key))
