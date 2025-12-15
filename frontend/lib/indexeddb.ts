// IndexedDB utility for storing recorded video blobs
// Using IndexedDB instead of LocalStorage because:
// 1. LocalStorage has ~5MB size limit (too small for video)
// 2. LocalStorage only stores strings (would need base64 encoding)
// 3. IndexedDB can store binary data (Blobs) directly

const DB_NAME = 'ScreenRecorderDB';
const STORE_NAME = 'recordings';
const DB_VERSION = 1;

// Recording metadata type
export interface RecordingMeta {
  id: string;        // Unique timestamp-based ID
  name: string;      // User-editable name (default: "Recording – HH:MM AM/PM")
  timestamp: number; // Unix timestamp when recorded
  duration: number;  // Recording duration in seconds
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

// Generate default name based on current time (e.g., "Recording – 2:45 PM")
export function generateDefaultName(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Recording – ${timeStr}`;
}

// Save video blob to IndexedDB with metadata
export async function saveVideo(
  id: string, 
  blob: Blob, 
  duration: number,
  name?: string
): Promise<RecordingMeta> {
  const db = await openDB();
  const meta: RecordingMeta = {
    id,
    name: name || generateDefaultName(),
    timestamp: Date.now(),
    duration,
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

// Update recording metadata (for renaming)
export async function updateRecordingMeta(
  id: string, 
  updates: Partial<Pick<RecordingMeta, 'name'>>
): Promise<RecordingMeta | null> {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const metaKey = `${id}-meta`;
    
    // First get the existing metadata
    const getRequest = store.get(metaKey);
    
    getRequest.onsuccess = () => {
      const existingMeta = getRequest.result as RecordingMeta | undefined;
      if (!existingMeta) {
        resolve(null);
        return;
      }
      
      // Merge updates with existing metadata
      const updatedMeta: RecordingMeta = { ...existingMeta, ...updates };
      
      // Save updated metadata
      const putRequest = store.put(updatedMeta, metaKey);
      putRequest.onsuccess = () => resolve(updatedMeta);
      putRequest.onerror = () => reject(putRequest.error);
    };
    
    getRequest.onerror = () => reject(getRequest.error);
    transaction.oncomplete = () => db.close();
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