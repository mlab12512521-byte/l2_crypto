// The "legacy" build of pdf.js includes polyfills, so the viewer also works in
// browsers that are a few versions behind (common in managed environments).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import { type FormEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/** A rectangle in PDF points, measured from the top-left of the page. */
export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfViewerHandle {
  /** Scroll to and highlight boxes (forward SyncTeX search). */
  highlight(boxes: PdfBox[]): void;
}

interface Props {
  /** URL of the PDF to show; changing it reloads while keeping zoom and scroll position. */
  url: string | null;
  downloadUrl: string | null;
  /** Double-click on a page (inverse SyncTeX search), coordinates in PDF points from the top-left. */
  onPageDoubleClick?: (page: number, x: number, y: number) => void;
  placeholder?: React.ReactNode;
}

const ZOOM_PRESETS = [
  { value: 'page-width', label: 'Fit width' },
  { value: 'page-fit', label: 'Fit page' },
  { value: '0.5', label: '50%' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
  { value: '2', label: '200%' },
  { value: '3', label: '300%' },
];

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { url, downloadUrl, onPageDoubleClick, placeholder },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewer = useRef<PDFViewer | null>(null);
  const eventBus = useRef<EventBus | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  /** Loading task of the document on screen; destroying it releases the document. */
  const taskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const zoomRef = useRef<string>('page-width');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState('page-width');
  const [scalePercent, setScalePercent] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [findStatus, setFindStatus] = useState('');
  const dblRef = useRef(onPageDoubleClick);
  dblRef.current = onPageDoubleClick;

  // Create the viewer once.
  useEffect(() => {
    if (!containerRef.current || !viewerRef.current) return;
    const bus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus: bus,
      externalLinkTarget: 2,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    const findController = new PDFFindController({ eventBus: bus, linkService });
    const viewer = new PDFViewer({
      container: containerRef.current,
      viewer: viewerRef.current,
      eventBus: bus,
      linkService,
      findController,
      removePageBorders: false,
      // No scripting and no annotation editing: documents are untrusted.
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    });
    linkService.setViewer(viewer);
    bus.on('pagechanging', (e: { pageNumber: number }) => setPage(e.pageNumber));
    bus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
      setScalePercent(Math.round(e.scale * 100));
      const v = e.presetValue ?? String(e.scale);
      zoomRef.current = v;
      setZoom(v);
    });
    bus.on('pagesinit', () => {
      viewer.currentScaleValue = zoomRef.current;
    });
    bus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => {
      setFindStatus(e.matchesCount.total ? `${e.matchesCount.current} / ${e.matchesCount.total}` : 'No matches');
    });
    bus.on('updatefindcontrolstate', (e: { matchesCount?: { current: number; total: number }; state: number }) => {
      if (e.state === 1) setFindStatus('No matches');
      else if (e.matchesCount?.total) setFindStatus(`${e.matchesCount.current} / ${e.matchesCount.total}`);
    });
    pdfViewer.current = viewer;
    eventBus.current = bus;
    linkRef.current = linkService;
    return () => {
      pdfViewer.current = null;
      void taskRef.current?.destroy();
    };
  }, []);

  // Load (or reload) the document, preserving scroll position.
  useEffect(() => {
    const viewer = pdfViewer.current;
    if (!viewer || !url) return;
    let cancelled = false;
    const container = containerRef.current!;
    const scrollTop = container.scrollTop;
    const scrollLeft = container.scrollLeft;
    const task = pdfjsLib.getDocument({ url, enableXfa: false, withCredentials: true });
    task.promise.then(
      (doc) => {
        if (cancelled) return;
        const old = taskRef.current;
        taskRef.current = task;
        viewer.setDocument(doc);
        linkRef.current?.setDocument(doc);
        setPages(doc.numPages);
        setError(null);
        const restore = () => {
          container.scrollTop = scrollTop;
          container.scrollLeft = scrollLeft;
          eventBus.current?.off('pagesloaded', restore);
        };
        eventBus.current?.on('pagesloaded', restore);
        if (old && old !== task) void old.destroy();
      },
      (err: Error) => {
        if (!cancelled) setError(`Could not display the PDF: ${err.message}`);
      },
    );
    return () => {
      cancelled = true;
      // Only abort if this load never became the displayed document.
      if (taskRef.current !== task) void task.destroy();
    };
  }, [url]);

  // Inverse search: double-click on a page.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onDbl = (e: MouseEvent) => {
      const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.page');
      const viewer = pdfViewer.current;
      if (!pageEl || !viewer || !dblRef.current) return;
      const pageNumber = Number(pageEl.dataset.pageNumber);
      const view = viewer.getPageView(pageNumber - 1) as {
        viewport: pdfjsLib.PageViewport;
        pdfPage: pdfjsLib.PDFPageProxy;
      };
      const rect = pageEl.getBoundingClientRect();
      const [px, py] = view.viewport.convertToPdfPoint(
        e.clientX - rect.left - pageEl.clientLeft,
        e.clientY - rect.top - pageEl.clientTop,
      ) as [number, number];
      const pageHeight = view.pdfPage.view[3]!;
      dblRef.current(pageNumber, px, pageHeight - py);
    };
    container.addEventListener('dblclick', onDbl);
    return () => container.removeEventListener('dblclick', onDbl);
  }, []);

  useImperativeHandle(ref, () => ({
    highlight(boxes: PdfBox[]) {
      const viewer = pdfViewer.current;
      const first = boxes[0];
      if (!viewer || !first || first.page > viewer.pagesCount) return;
      const view = viewer.getPageView(first.page - 1) as {
        viewport: pdfjsLib.PageViewport;
        pdfPage: pdfjsLib.PDFPageProxy;
        div: HTMLElement;
      };
      const pageHeight = view.pdfPage.view[3]!;
      viewer.scrollPageIntoView({
        pageNumber: first.page,
        destArray: [null, { name: 'XYZ' }, first.x, pageHeight - first.y + 60, null],
        allowNegativeOffset: true,
      });
      // Draw temporary highlight rectangles on the page.
      for (const b of boxes.filter((x) => x.page === first.page)) {
        const [x1, y1] = view.viewport.convertToViewportPoint(b.x, pageHeight - b.y - b.height) as [number, number];
        const [x2, y2] = view.viewport.convertToViewportPoint(b.x + b.width, pageHeight - b.y) as [number, number];
        const el = document.createElement('div');
        el.className = 'synctex-highlight';
        el.style.left = `${Math.min(x1, x2)}px`;
        el.style.top = `${Math.min(y1, y2)}px`;
        el.style.width = `${Math.abs(x2 - x1)}px`;
        el.style.height = `${Math.abs(y2 - y1)}px`;
        view.div.appendChild(el);
        setTimeout(() => el.remove(), 2500);
      }
    },
  }));

  const setScale = useCallback((value: string) => {
    zoomRef.current = value;
    setZoom(value);
    if (pdfViewer.current) pdfViewer.current.currentScaleValue = value;
  }, []);

  const step = (factor: number) => {
    const v = pdfViewer.current;
    if (!v) return;
    const next = Math.min(5, Math.max(0.25, v.currentScale * factor));
    setScale(String(Math.round(next * 100) / 100));
  };

  const find = (e: FormEvent | null, previous = false) => {
    e?.preventDefault();
    eventBus.current?.dispatch('find', {
      source: null,
      type: e ? '' : 'again',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const gotoPage = (n: number) => {
    const v = pdfViewer.current;
    if (v && n >= 1 && n <= v.pagesCount) v.currentPageNumber = n;
  };

  const zoomOptions = ZOOM_PRESETS.some((z) => z.value === zoom)
    ? ZOOM_PRESETS
    : [...ZOOM_PRESETS, { value: zoom, label: `${scalePercent}%` }];

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => gotoPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          ‹
        </button>
        <input
          className="pdf-page-input"
          aria-label="Page number"
          value={page}
          onChange={(e) => setPage(Number(e.target.value) || 1)}
          onKeyDown={(e) => e.key === 'Enter' && gotoPage(page)}
        />
        <span className="muted small">/ {pages || '–'}</span>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => gotoPage(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
        >
          ›
        </button>
        <span className="pdf-toolbar-sep" />
        <button type="button" className="btn btn-ghost btn-small" onClick={() => step(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <select aria-label="Zoom" value={zoom} onChange={(e) => setScale(e.target.value)}>
          {zoomOptions.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => step(1.2)} aria-label="Zoom in">
          +
        </button>
        <span className="pdf-toolbar-sep" />
        <button
          type="button"
          className={`btn btn-ghost btn-small${findOpen ? ' active' : ''}`}
          onClick={() => setFindOpen((o) => !o)}
          aria-label="Search in PDF"
        >
          Find
        </button>
        {downloadUrl && (
          <a className="btn btn-ghost btn-small" href={downloadUrl} download>
            Download
          </a>
        )}
      </div>
      {findOpen && (
        <form className="pdf-find" onSubmit={(e) => find(e)}>
          <input
            autoFocus
            type="search"
            placeholder="Search the PDF…"
            aria-label="Search the PDF"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                find(null, true);
              } else if (e.key === 'Escape') setFindOpen(false);
            }}
          />
          <button type="button" className="btn btn-small" onClick={() => find(null, true)} aria-label="Previous match">
            ↑
          </button>
          <button type="submit" className="btn btn-small" aria-label="Next match">
            ↓
          </button>
          <span className="muted small">{findStatus}</span>
        </form>
      )}
      {error && <div className="banner banner-error">{error}</div>}
      <div className="pdf-stage">
        {/* pdf.js requires an absolutely positioned scroll container. */}
        <div className="pdf-scroll" ref={containerRef}>
          <div ref={viewerRef} className="pdfViewer" />
        </div>
      </div>
      {!url && <div className="pdf-empty">{placeholder}</div>}
    </div>
  );
});
