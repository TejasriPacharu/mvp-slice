const DB_NAME = 'ScreenRecorderDB';
const STORE_NAME = 'recordings';
const DB_VERSION = 1;

// Recording metadata type
export interface RecordingMeta {
  id: string;        // Unique timestamp-based ID
  timestamp: number; // Unix timestamp when recorded
  size: number;      // File size in bytes
}

// Open or create the IndexedDB database
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    // Create object store on first run or version upgrade
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Generate a unique key based on timestamp
export function generateRecordingId(): string {
  return `recording-${Date.now()}`;
}

// Save video blob to IndexedDB with metadata
export async function saveVideo(id: string, blob: Blob): Promise<RecordingMeta> {
  const db = await openDB();
  const meta: RecordingMeta = {
    id,
    timestamp: Date.now(),
    size: blob.size,
  };
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // Store both the blob and its metadata
    store.put(blob, id);
    store.put(meta, `${id}-meta`);
    
    transaction.oncomplete = () => {
      db.close();
      resolve(meta);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

// Retrieve video blob from IndexedDB by key
export async function getVideo(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

// Get all recording metadata (sorted by newest first)
export async function getAllRecordings(): Promise<RecordingMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    
    request.onsuccess = async () => {
      const keys = request.result as string[];
      // Filter for metadata keys only
      const metaKeys = keys.filter(k => k.endsWith('-meta'));
      
      // Fetch all metadata
      const metaPromises = metaKeys.map(key => {
        return new Promise<RecordingMeta>((res, rej) => {
          const req = store.get(key);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      });
      
      try {
        const recordings = await Promise.all(metaPromises);
        // Sort by timestamp descending (newest first)
        recordings.sort((a, b) => b.timestamp - a.timestamp);
        resolve(recordings);
      } catch (err) {
        reject(err);
      }
    };
    
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

// Delete video and its metadata from IndexedDB
export async function deleteVideo(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // Delete both blob and metadata
    store.delete(id);
    store.delete(`${id}-meta`);
    
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}