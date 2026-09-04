/**
 * Local-first storage. IndexedDB holds the document (elements, view, and image
 * files) because agent-drawn boards can outgrow localStorage. A small
 * synchronous localStorage backup of the elements is written when the tab
 * hides and after every agent write, because IndexedDB work started during
 * unload does not reliably finish; on load the newer of the two wins.
 */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';

const DB_NAME = 'agentdraw';
const STORE = 'documents';
const KEY = 'current-v1';
const BACKUP_KEY = 'agentdraw:backup-v1';

export interface StoredDocument {
  elements: readonly ExcalidrawElement[];
  appState: Partial<
    Pick<AppState, 'scrollX' | 'scrollY' | 'zoom' | 'viewBackgroundColor'>
  >;
  files: BinaryFiles;
  savedAt: string;
}

type BackupDocument = Omit<StoredDocument, 'files'>;

let databasePromise: Promise<IDBDatabase> | null = null;

/** One connection for the page's lifetime, so a late flush needs no async open. */
function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      request.result.onclose = () => {
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
}

async function loadFromDatabase(): Promise<StoredDocument | null> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as StoredDocument) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

function readBackup(): BackupDocument | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BackupDocument>;
    if (!Array.isArray(parsed.elements) || typeof parsed.savedAt !== 'string') return null;
    return { elements: parsed.elements, appState: parsed.appState ?? {}, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

/** Synchronous, so it survives pagehide. Silently skipped when over quota. */
export function writeBackup(document: StoredDocument) {
  try {
    const backup: BackupDocument = {
      elements: document.elements,
      appState: document.appState,
      savedAt: document.savedAt,
    };
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
}

export async function loadDocument(): Promise<StoredDocument | null> {
  const [stored, backup] = [await loadFromDatabase(), readBackup()];
  if (!backup) return stored;
  if (stored && stored.savedAt >= backup.savedAt) return stored;
  // The backup carries no image bytes; keep whatever files the database has.
  return { ...backup, files: stored?.files ?? {} };
}

export async function saveDocument(document: StoredDocument) {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(document, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  } catch {
    return false;
  }
}

export function createDebouncedSaver(delayMs = 400) {
  let timer: number | null = null;
  let pending: StoredDocument | null = null;
  const write = (document: StoredDocument, backup: boolean) => {
    if (backup) writeBackup(document);
    void saveDocument(document);
  };
  const flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const next = pending;
    pending = null;
    write(next, true);
  };
  return {
    /** Debounced save; a burst of edits costs one write. */
    schedule(document: StoredDocument) {
      pending = document;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!pending) return;
        const next = pending;
        pending = null;
        write(next, false);
      }, delayMs);
    },
    /** Writes now, including the synchronous backup. For agent writes and pagehide. */
    persistNow(document: StoredDocument) {
      pending = null;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      write(document, true);
    },
    flush,
  };
}
