function openReferenceStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("closetai-local-reference", 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("images")) request.result.createObjectStore("images"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeReferenceImage(blob: Blob) {
  const db = await openReferenceStore();
  try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction("images", "readwrite"); transaction.objectStore("images").put(blob, "reference"); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); }
  finally { db.close(); }
}

export async function hasSavedReferenceImage() {
  const db = await openReferenceStore();
  try { return await new Promise<boolean>((resolve, reject) => { const transaction = db.transaction("images", "readonly"); const request = transaction.objectStore("images").count("reference"); request.onsuccess = () => resolve(request.result > 0); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}

export async function deleteSavedReferenceImage() {
  const db = await openReferenceStore();
  try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction("images", "readwrite"); transaction.objectStore("images").delete("reference"); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); }
  finally { db.close(); }
}
