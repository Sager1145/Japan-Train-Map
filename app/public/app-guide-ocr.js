// Lazy local OCR. Source images stay in the browser; each import releases its
// worker after recognition. Only LSTM cores and pinned Japanese/English data
// are used. Long screenshots are read in overlapping, bounded canvas tiles.
let guideOcrLibraryPromise = null;
let guideOcrWorker = null;

function cancelGuideOcr() {
  if (guideOcrWorker) {
    const worker = guideOcrWorker;
    guideOcrWorker = null;
    worker.terminate().catch(() => {});
  }
}

function loadGuideOcrLibrary() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!guideOcrLibraryPromise) {
    guideOcrLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("vendor/tesseract/tesseract.min.js", document.baseURI).href;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => { script.remove(); guideOcrLibraryPromise = null; reject(new Error("OCR library")); };
      document.head.appendChild(script);
    });
  }
  return guideOcrLibraryPromise;
}

function guideOcrRows(data) {
  const words = (data.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) =>
    (paragraph.lines || []).flatMap((line) => line.words || [])))
    .filter((word) => word.text?.trim() && word.bbox);
  if (!words.length) return [{ text: data.text || "", y: 0 }];
  words.sort((a, b) => (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1) || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  for (const word of words) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2;
    const height = word.bbox.y1 - word.bbox.y0;
    let row = rows[rows.length - 1];
    if (!row || Math.abs(row.y - center) > Math.max(4, Math.min(row.height, height) * .6)) {
      row = { y: center, height, words: [] }; rows.push(row);
    }
    row.words.push(word);
  }
  return rows.map((row) => ({ y: row.y, text: row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((word) => word.text).join(" ") }));
}

function stitchGuidePages(pages) {
  const rows = [];
  for (const page of pages) {
    const next = page.split(/\r?\n/).filter((row) => row.trim());
    let overlap = 0;
    const key = (row) => row.normalize("NFKC").replace(/\s+/g, "");
    for (let count = Math.min(rows.length, next.length, 80); count >= 2; count -= 1) {
      if (next.slice(0, count).every((row, index) => key(row) === key(rows[rows.length - count + index]))) {
        overlap = count; break;
      }
    }
    rows.push(...next.slice(overlap));
  }
  return rows.join("\n");
}

async function readGuideImages(files, token, onProgress) {
  const alive = () => token === guideReadToken;
  const library = await loadGuideOcrLibrary();
  if (!alive()) return null;
  const base = new URL("vendor/tesseract/", document.baseURI);
  let rejectStartup;
  const startupError = new Promise((_, reject) => { rejectStartup = reject; });
  const creation = library.createWorker(["jpn", "eng"], 1, {
    errorHandler: (error) => rejectStartup(new Error(String(error))),
    workerPath: new URL("worker.min.js", base).href,
    corePath: new URL("core/", base).href,
    langPath: new URL("lang/", base).href,
    logger: (message) => { if (alive()) onProgress({ page: 0, total: files.length, percent: Math.round((message.progress || 0) * 100) }); },
  });
  const worker = await Promise.race([creation, startupError]);
  if (!alive()) { await worker.terminate(); return null; }
  guideOcrWorker = worker;
  const pages = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    for (let page = 0; page < files.length && alive(); page += 1) {
      const bitmap = await createImageBitmap(files[page]);
      try {
        const scale = Math.min(1, 1600 / bitmap.width);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const tileSize = 1800;
        const overlap = 120;
        const rows = [];
        for (let top = 0; top < height && alive(); top += tileSize - overlap) {
          const tileHeight = Math.min(tileSize, height - top);
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = tileHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("OCR canvas");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, tileHeight);
          ctx.drawImage(bitmap, 0, top / scale, bitmap.width, tileHeight / scale, 0, 0, width, tileHeight);
          const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
          const last = top + tileHeight >= height;
          rows.push(...guideOcrRows(result.data).filter((row) =>
            (top === 0 || row.y >= overlap / 2) && (last || row.y < tileHeight - overlap / 2)).map((row) => row.text));
          canvas.width = canvas.height = 0;
          if (alive()) onProgress({ page: page + 1, total: files.length, percent: Math.round(100 * Math.min(height, top + tileHeight) / height) });
          if (last) break;
        }
        pages.push(rows.join("\n"));
      } finally { bitmap.close(); }
    }
    return alive() ? stitchGuidePages(pages) : null;
  } finally {
    if (guideOcrWorker === worker) { guideOcrWorker = null; await worker.terminate(); }
  }
}
