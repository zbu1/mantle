/**
 * Lays out every page of the PDF at `url` in `host`, one canvas each, sized
 * up front and drawn as it scrolls into view of `scroller`. Resolves once the
 * pages are laid out; returns a function that stops drawing and frees the PDF.
 *
 * ponytail: fetches the whole file, though the protocol answers range requests; stream with pdf.js's `url` loading if big PDFs get slow.
 */
export async function renderPdfPages(url: string, host: HTMLElement, scroller: HTMLElement | null, pageClass: string): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.mjs';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const task = pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) });
  const pdf = await task.promise;
  const scale = window.devicePixelRatio || 1;
  const pages = new Map<Element, number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const n = pages.get(entry.target);
        if (!entry.isIntersecting || n === undefined) continue;
        pages.delete(entry.target);
        observer.unobserve(entry.target);
        void pdf.getPage(n).then((page) => {
          const canvas = entry.target as HTMLCanvasElement;
          return page.render({ canvas, viewport: page.getViewport({ scale: 1.5 * scale }) }).promise;
        }).catch(() => undefined);
      }
    },
    { root: scroller, rootMargin: '200px' },
  );
  host.replaceChildren();
  for (let n = 1; n <= pdf.numPages; n++) {
    const viewport = (await pdf.getPage(n)).getViewport({ scale: 1.5 * scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `min(100% - 2rem, ${viewport.width / scale}px)`;
    canvas.className = pageClass;
    host.append(canvas);
    pages.set(canvas, n);
    observer.observe(canvas);
  }
  return () => {
    observer.disconnect();
    void task.destroy();
  };
}
