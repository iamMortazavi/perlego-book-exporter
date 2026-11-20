/**
 * @file IndexedDB persistence layer (`PerlegoDownloaderDB`).
 * Provides O(1) per-book chapter caching, metadata tracking, and storage estimates.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});
  const DB_NAME = 'PerlegoDownloaderDB';
  const DB_VERSION = 1;
  const LEGACY_DB_NAME = 'MyDatabase';

  let dbPromise = null;

  /**
   * Opens (or returns cached) IndexedDB v2 singleton connection.
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', {
            keyPath: ['bookId', 'index'],
          });
          itemStore.createIndex('byBook', 'bookId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Failed to open IndexedDB'));
      };
    });

    return dbPromise;
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function bookKeyRange(bookId) {
    return IDBKeyRange.bound(
      [bookId, Number.MIN_SAFE_INTEGER],
      [bookId, Number.MAX_SAFE_INTEGER]
    );
  }

  /**
   * Saves or updates metadata for a book safely within a single IndexedDB transaction.
   * @param {object} meta
   * @returns {Promise<void>}
   */
  async function saveBookMeta(meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['books'], 'readwrite');
      const store = tx.objectStore('books');
      const getReq = store.get(meta.bookId);

      getReq.onsuccess = () => {
        const existing = getReq.result || {};
        const merged = {
          ...existing,
          ...meta,
          updatedAt: Date.now(),
        };
        store.put(merged);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save book metadata'));
      tx.onabort = () => reject(tx.error || new Error('Save book metadata aborted'));
    });
  }

  /**
   * Retrieves stored metadata for a book.
   * @param {string} bookId
   * @returns {Promise<object|null>}
   */
  async function getBookMeta(bookId) {
    const db = await openDB();
    const tx = db.transaction(['books'], 'readonly');
    const result = await promisifyRequest(tx.objectStore('books').get(bookId));
    return result || null;
  }

  /**
   * Lists all cached books sorted by most recently updated.
   * @returns {Promise<Array<object>>}
   */
  async function listBooks() {
    const db = await openDB();
    const tx = db.transaction(['books'], 'readonly');
    const books = await promisifyRequest(tx.objectStore('books').getAll());
    return (books || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Returns origin storage usage and quota estimates (if supported).
   * @returns {Promise<{ usage: number, quota: number }>}
   */
  async function getStorageEstimate() {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function') {
        const est = await navigator.storage.estimate();
        return {
          usage: Number(est?.usage || 0),
          quota: Number(est?.quota || 0),
        };
      }
    } catch {
      // Ignore estimate failures
    }
    return { usage: 0, quota: 0 };
  }

  /**
   * Stores a single captured chapter/page in O(1) and updates book capturedCount & sizeBytes.
   * @param {{ bookId: string, index: number, title?: string, level?: number, html: string, assetUrls?: string[], assetFallbacks?: Record<string, string> }} item
   * @returns {Promise<number>} Updated captured count
   */
  async function putItem(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'books'], 'readwrite');
      const itemsStore = tx.objectStore('items');
      const booksStore = tx.objectStore('books');

      let capturedCount = 0;
      const htmlStr = String(item.html || '');
      const htmlBytes = htmlStr.length;

      const record = {
        bookId: item.bookId,
        index: item.index,
        title: item.title || `Section ${item.index + 1}`,
        level: Number.isFinite(item.level) ? item.level : 0,
        html: htmlStr,
        htmlBytes,
        assetUrls: Array.isArray(item.assetUrls) ? item.assetUrls : [],
        assetFallbacks: item.assetFallbacks && typeof item.assetFallbacks === 'object'
          ? item.assetFallbacks
          : {},
        capturedAt: Date.now(),
      };

      const existingItemReq = itemsStore.get([item.bookId, item.index]);
      existingItemReq.onsuccess = () => {
        const prevBytes = existingItemReq.result?.htmlBytes || existingItemReq.result?.html?.length || 0;
        const deltaBytes = htmlBytes - prevBytes;

        const putReq = itemsStore.put(record);
        putReq.onsuccess = () => {
          const countReq = itemsStore.count(bookKeyRange(item.bookId));
          countReq.onsuccess = () => {
            capturedCount = countReq.result;
            const getBookReq = booksStore.get(item.bookId);
            getBookReq.onsuccess = () => {
              const book = getBookReq.result || { bookId: item.bookId };
              const nextSize = Math.max(0, (book.sizeBytes || 0) + deltaBytes);
              booksStore.put({
                ...book,
                capturedCount,
                sizeBytes: nextSize,
                updatedAt: Date.now(),
              });
            };
          };
        };
      };

      tx.oncomplete = () => resolve(capturedCount);
      tx.onerror = () => reject(tx.error || new Error('Failed to store item'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  /**
   * Returns a Set of already captured item indices for a book without loading HTML payloads.
   * @param {string} bookId
   * @returns {Promise<Set<number>>}
   */
  async function getCapturedIndices(bookId) {
    const db = await openDB();
    const tx = db.transaction(['items'], 'readonly');
    const keys = await promisifyRequest(
      tx.objectStore('items').getAllKeys(bookKeyRange(bookId))
    );
    const set = new Set();
    for (const key of keys) {
      if (Array.isArray(key) && typeof key[1] === 'number') {
        set.add(key[1]);
      }
    }
    return set;
  }

  /**
   * Returns all captured items for a book sorted by index ascending.
   * @param {string} bookId
   * @returns {Promise<Array<object>>}
   */
  async function getBookItems(bookId) {
    const db = await openDB();
    const tx = db.transaction(['items'], 'readonly');
    const items = await promisifyRequest(
      tx.objectStore('items').getAll(bookKeyRange(bookId))
    );
    items.sort((a, b) => a.index - b.index);
    return items;
  }

  /**
   * Deletes cached metadata and items for a single book.
   * @param {string} bookId
   * @returns {Promise<void>}
   */
  async function clearBook(bookId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'books'], 'readwrite');
      tx.objectStore('items').delete(bookKeyRange(bookId));
      tx.objectStore('books').delete(bookId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to clear book cache'));
      tx.onabort = () => reject(tx.error || new Error('Clear book cache aborted'));
    });
  }

  /**
   * Removes legacy v3.0 IndexedDB database if present.
   */
  function deleteLegacyDB() {
    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.deleteDatabase === 'function') {
        indexedDB.deleteDatabase(LEGACY_DB_NAME);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Clears all cached books and deletes legacy v3.0 DB.
   * @returns {Promise<void>}
   */
  async function clearAll() {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'books'], 'readwrite');
      tx.objectStore('items').clear();
      tx.objectStore('books').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to clear all caches'));
      tx.onabort = () => reject(tx.error || new Error('Clear all caches aborted'));
    });
    deleteLegacyDB();
  }

  PD.db = {
    DB_NAME,
    openDB,
    saveBookMeta,
    getBookMeta,
    listBooks,
    getStorageEstimate,
    putItem,
    getCapturedIndices,
    getBookItems,
    clearBook,
    clearAll,
    deleteLegacyDB,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.db;
  }
})();
