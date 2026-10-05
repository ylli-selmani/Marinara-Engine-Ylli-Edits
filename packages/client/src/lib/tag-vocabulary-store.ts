import type { TagRecord } from "@marinara-engine/shared";

/**
 * Persists the imported tag vocabulary across reloads.
 *
 * A Danbooru export is ~126k tags and several megabytes, which blows past the
 * localStorage quota the settings store uses, so the vocabulary lives in
 * IndexedDB instead. No dependency is added: this mirrors the raw-IDB approach
 * already used by `tts-audio-cache.ts`.
 *
 * Every operation degrades to "no vocabulary" rather than throwing — autocomplete
 * is a convenience, and a blocked or unavailable database must not break a prompt
 * field.
 */
const DB_NAME = "marinara-tag-autocomplete";
const DB_VERSION = 1;
const STORE_NAME = "vocabulary";
const RECORD_KEY = "current";

interface StoredVocabulary {
  key: string;
  sourceName: string;
  tags: TagRecord[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      resolve(null);
    };
    request.onblocked = () => {
      dbPromise = null;
      resolve(null);
    };
  });

  return dbPromise;
}

/** Reads the stored vocabulary, or null when none is saved or storage fails. */
export async function loadStoredVocabulary(): Promise<{ tags: TagRecord[]; sourceName: string } | null> {
  try {
    const db = await openDb();
    if (!db) return null;

    const tx = db.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise<StoredVocabulary | undefined>(tx.objectStore(STORE_NAME).get(RECORD_KEY));
    if (!record || !Array.isArray(record.tags) || record.tags.length === 0) return null;

    return { tags: record.tags, sourceName: record.sourceName };
  } catch {
    return null;
  }
}

/** Saves the vocabulary. Returns false when it could not be persisted. */
export async function saveStoredVocabulary(tags: TagRecord[], sourceName: string): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;

    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      key: RECORD_KEY,
      sourceName,
      tags,
      savedAt: Date.now(),
    } satisfies StoredVocabulary);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
    return true;
  } catch {
    return false;
  }
}

/** Removes the stored vocabulary. */
export async function clearStoredVocabulary(): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
  } catch {
    // Nothing to clean up.
  }
}
