import React, { useRef, useEffect, useState, useCallback } from 'react';
import Layout from '../components/layout';

const lightboxStyles = `
.lightbox-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  cursor: zoom-out;
  animation: fadeIn 0.2s ease;
}

.lightbox-overlay img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 4px;
  box-shadow: 0 4px 32px rgba(0,0,0,0.5);
  animation: scaleIn 0.2s ease;
}

.lightbox-overlay .close-btn {
  position: absolute;
  top: 16px;
  right: 24px;
  color: #fff;
  font-size: 32px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s;
  background: none;
  border: none;
  font-family: sans-serif;
}
.lightbox-overlay .close-btn:hover { opacity: 1; }

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes scaleIn { from { transform: scale(0.9); } to { transform: scale(1); } }
`;

export default function DocTemplate({ pageContext }) {
  const { html } = pageContext;
  const contentRef = useRef(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') setLightboxSrc(null);
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const imgs = el.querySelectorAll('img');
    const handlers = [];

    imgs.forEach((img) => {
      if (img.closest('.anchor-link') || img.closest('a')) return;
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
  }, [html, handleKeyDown]);

  return (
    <Layout>
      <style>{lightboxStyles}</style>
      <div ref={contentRef} className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
      {lightboxSrc && (
        <div className="lightbox-overlay" onClick={() => setLightboxSrc(null)}>
          <button className="close-btn" onClick={() => setLightboxSrc(null)}>&times;</button>
          <img src={lightboxSrc} alt="enlarged view" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </Layout>
  );
}
