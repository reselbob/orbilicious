import React, { useRef, useEffect, useState, useCallback } from 'react';
import Layout from '../components/layout';

const svgOverlayStyles = `
.svg-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: #1a1a2e;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  animation: fadeIn 0.2s ease;
}

.svg-overlay .toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #0f172a;
  border-bottom: 1px solid #334155;
  flex-shrink: 0;
}

.svg-overlay .toolbar .title {
  color: #94a3b8;
  font-size: 13px;
  font-family: sans-serif;
}

.svg-overlay .toolbar .controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.svg-overlay .toolbar button {
  background: #334155;
  color: #e2e8f0;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  font-family: sans-serif;
  transition: background 0.15s;
}

.svg-overlay .toolbar button:hover {
  background: #475569;
}

.svg-overlay .toolbar .close-btn {
  font-size: 18px;
  padding: 4px 10px;
  background: transparent;
  color: #94a3b8;
}

.svg-overlay .toolbar .close-btn:hover {
  color: #fff;
  background: #334155;
}

.svg-overlay .viewer {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.svg-overlay .viewer svg {
  display: block;
}

.svg-overlay .hint {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.75);
  color: #cbd5e1;
  font-size: 12px;
  padding: 6px 16px;
  border-radius: 6px;
  pointer-events: none;
  font-family: sans-serif;
  opacity: 0;
  transition: opacity 0.3s;
}

.svg-overlay .hint.visible {
  opacity: 1;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;

export default function DocTemplate({ pageContext }) {
  const { html } = pageContext;
  const contentRef = useRef(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [svgOverlayOpen, setSvgOverlayOpen] = useState(false);
  const viewerRef = useRef(null);
  const panZoomRef = useRef(null);
  const scriptLoadedRef = useRef(false);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      setLightboxSrc(null);
      setSvgOverlayOpen(false);
    }
  }, []);

  const openWorkflowOverlay = useCallback((e) => {
    e.preventDefault();
    setSvgOverlayOpen(true);
  }, []);

  const closeSvgOverlay = useCallback(() => {
    setSvgOverlayOpen(false);
  }, []);

  const zoomIn = useCallback(() => {
    if (panZoomRef.current) panZoomRef.current.zoomIn();
  }, []);

  const zoomOut = useCallback(() => {
    if (panZoomRef.current) panZoomRef.current.zoomOut();
  }, []);

  const resetZoom = useCallback(() => {
    if (panZoomRef.current) {
      panZoomRef.current.reset();
      panZoomRef.current.fit();
      panZoomRef.current.center();
    }
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const imgs = el.querySelectorAll('img');
    const handlers = [];

    imgs.forEach((img) => {
      if (img.closest('.anchor-link') || img.closest('a')) return;
      if (img.alt === 'ORB Trading Pipeline') {
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', openWorkflowOverlay);
        handlers.push([img, openWorkflowOverlay]);
        return;
      }
      img.style.cursor = 'zoom-in';
      const handler = () => setLightboxSrc(img.src);
      img.addEventListener('click', handler);
      handlers.push([img, handler]);
    });

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      handlers.forEach(([img, h]) => img.removeEventListener('click', h));
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [html, handleKeyDown, openWorkflowOverlay]);

  useEffect(() => {
    if (!svgOverlayOpen) return;

    const loadLibrary = () => {
      return new Promise((resolve) => {
        if (typeof svgPanZoom !== 'undefined' || scriptLoadedRef.current) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js';
        script.onload = () => {
          scriptLoadedRef.current = true;
          resolve();
        };
        document.body.appendChild(script);
      });
    };

    const initViewer = async () => {
      await loadLibrary();

      const viewer = viewerRef.current;
      if (!viewer) return;

      viewer.innerHTML = '';

      try {
        const resp = await fetch('docs/workflow.svg');
        const svgText = await resp.text();
        viewer.innerHTML = svgText;

        const svg = viewer.querySelector('svg');
        if (!svg) return;

        svg.style.maxWidth = '100vw';
        svg.style.maxHeight = '100vh';

        if (panZoomRef.current) {
          panZoomRef.current.destroy();
          panZoomRef.current = null;
        }

        requestAnimationFrame(() => {
          panZoomRef.current = svgPanZoom(svg, {
            zoomEnabled: true,
            controlIconsEnabled: false,
            fit: true,
            center: true,
            minZoom: 0.3,
            maxZoom: 20,
            customEventsHandler: {
              haltEventListeners: [],
              init: function (o) { this.options = o; },
              destroy: function () {}
            }
          });

          const hint = viewer.parentNode.querySelector('.hint');
          if (hint) {
            hint.classList.add('visible');
            setTimeout(() => hint.classList.remove('visible'), 4000);
          }
        });
      } catch (err) {
        viewer.textContent = 'Failed to load workflow diagram.';
      }
    };

    initViewer();

    return () => {
      if (panZoomRef.current) {
        panZoomRef.current.destroy();
        panZoomRef.current = null;
      }
    };
  }, [svgOverlayOpen]);

  return (
    <Layout>
      <style>{svgOverlayStyles}</style>
      <div ref={contentRef} className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
      {lightboxSrc && (
        <div className="lightbox-overlay" onClick={() => setLightboxSrc(null)}>
          <button className="close-btn" onClick={() => setLightboxSrc(null)}>&times;</button>
          <img src={lightboxSrc} alt="enlarged view" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
      {svgOverlayOpen && (
        <div className="svg-overlay" onClick={closeSvgOverlay}>
          <div className="toolbar" onClick={(e) => e.stopPropagation()}>
            <span className="title">ORB Trading Pipeline — Workflow Diagram</span>
            <div className="controls">
              <button onClick={zoomOut}>−</button>
              <button onClick={resetZoom}>Fit</button>
              <button onClick={zoomIn}>+</button>
              <button className="close-btn" onClick={closeSvgOverlay}>&times;</button>
            </div>
          </div>
          <div className="viewer" ref={viewerRef} onClick={(e) => e.stopPropagation()} />
          <div className="hint">Drag to pan · Scroll to zoom</div>
        </div>
      )}
    </Layout>
  );
}
