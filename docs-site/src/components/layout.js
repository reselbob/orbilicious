import React from 'react';

const TOC_HEADINGS = [
  { id: 'setup', label: 'Setup' },
  { id: 'startup-scripts', label: 'Startup Scripts' },
  { id: 'user-manual', label: 'User Manual', children: [
    { id: 'system-requirements', label: 'System Requirements' },
    { id: 'runtime-controls', label: 'Runtime Controls' },
    { id: 'how-to-use-the-breakout-confirmation-and-quality-filters', label: 'Breakout Confirmation & Quality Filters' },
    { id: 'trade-monitor', label: 'Trade Monitor' },
    { id: 'daily-summary', label: 'Daily Summary' },
    { id: 'reports', label: 'Reports' },
    { id: 'reports-weekly-summary', label: 'Reports Weekly Summary' },
    { id: 'reports-daily-detail', label: 'Reports Daily Detail' },
  ]},
  { id: 'developer-notes', label: 'Developer Notes', children: [
    { id: 'workflow', label: 'Workflow' },
    { id: 'trading-architecture', label: 'Trading Architecture' },
    { id: 'strategy-rules', label: 'Strategy Rules' },
    { id: 'operational-rules', label: 'Operational Rules' },
    { id: 'resilience-and-stability', label: 'Resilience and Stability' },
    { id: 'logging', label: 'Logging' },
    { id: 'environment-variables', label: 'Environment Variables' },
    { id: 'report-modes-and-scheduling', label: 'Report Modes and Scheduling' },
    { id: 'tests', label: 'Tests' },
  ]},
  { id: 'notes', label: 'Notes' },
  { id: 'recommended-next-upgrades', label: 'Recommended Next Upgrades' },
];

const globalStyles = `
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body, #___gatsby, #gatsby-focus-wrapper {
    height: 100%;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    color: #1a1a2e;
    background: #f8f9fa;
    line-height: 1.6;
    font-size: 15px;
  }

  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .app {
    display: flex;
    height: 100vh;
  }

  .sidebar {
    width: 280px;
    min-width: 280px;
    background: #1a1a2e;
    color: #e0e0e0;
    overflow-y: auto;
    padding: 24px 0;
    border-right: 1px solid #2a2a4a;
  }

  .sidebar-header {
    padding: 0 20px 20px;
    border-bottom: 1px solid #2a2a4a;
    margin-bottom: 12px;
  }

  .sidebar-header h1 {
    font-size: 18px;
    color: #fff;
    font-weight: 700;
  }

  .sidebar-header .subtitle {
    font-size: 12px;
    color: #94a3b8;
    margin-top: 4px;
  }

  .toc-list {
    list-style: none;
  }

  .toc-list li { margin: 0; }

  .toc-link {
    display: block;
    padding: 6px 20px;
    color: #cbd5e1;
    font-size: 13px;
    transition: background 0.15s, color 0.15s;
    border-left: 3px solid transparent;
  }

  .toc-link:hover {
    background: #2a2a4a;
    color: #fff;
    text-decoration: none;
  }

  .toc-link.active {
    background: #2a2a4a;
    color: #60a5fa;
    border-left-color: #60a5fa;
  }

  .toc-section-header {
    display: block;
    padding: 8px 20px 4px;
    color: #94a3b8;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .toc-children {
    list-style: none;
  }

  .toc-child-link {
    display: block;
    padding: 4px 20px 4px 36px;
    color: #94a3b8;
    font-size: 12px;
    transition: color 0.15s;
  }

  .toc-child-link:hover {
    color: #fff;
    text-decoration: none;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 40px 48px;
    max-width: 960px;
  }

  .content h1 { font-size: 32px; margin: 0 0 24px; color: #111; }
  .content h2 {
    font-size: 24px;
    margin: 40px 0 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e2e8f0;
    color: #1a1a2e;
  }
  .content h3 { font-size: 18px; margin: 28px 0 12px; color: #334155; }
  .content h4 { font-size: 15px; margin: 20px 0 8px; color: #475569; }

  .content p { margin: 0 0 16px; }

  .content ul, .content ol { margin: 0 0 16px; padding-left: 24px; }
  .content li { margin-bottom: 4px; }

  .content code {
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, monospace;
    color: #2563eb;
  }

  .content pre {
    background: #1e293b;
    color: #e2e8f0;
    padding: 16px 20px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0 0 20px;
    font-size: 13px;
    line-height: 1.5;
  }

  .content pre code {
    background: none;
    padding: 0;
    color: inherit;
  }

  .content blockquote {
    border-left: 4px solid #2563eb;
    padding: 8px 16px;
    margin: 0 0 16px;
    background: #f8fafc;
    color: #475569;
  }

  .content table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 20px;
    font-size: 14px;
  }

  .content th, .content td {
    padding: 8px 12px;
    border: 1px solid #e2e8f0;
    text-align: left;
  }

  .content th {
    background: #f1f5f9;
    font-weight: 600;
  }

  .content tr:nth-child(even) { background: #f8fafc; }

  .content img { max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }

  .content hr { border: none; border-top: 1px solid #e2e8f0; margin: 32px 0; }

  .content .anchor-link { margin-left: 8px; opacity: 0.3; font-size: 16px; }
  .content .anchor-link:hover { opacity: 1; text-decoration: none; }

  .content strong { color: #0f172a; }

  .content li > p { margin: 0; }

  .content .gatsby-highlight { margin-bottom: 20px; }

  .content .md-content h2:first-of-type { margin-top: 0; }

  @media (max-width: 768px) {
    .sidebar { display: none; }
    .content { padding: 24px; max-width: 100%; }
  }
`;

export default function Layout({ children }) {
  return (
    <>
      <style>{globalStyles}</style>
      <div className="app">
        <nav className="sidebar">
          <div className="sidebar-header">
            <h1>ORBilicious</h1>
            <div className="subtitle">Documentation v0.0.8</div>
          </div>
          <ul className="toc-list">
            {TOC_HEADINGS.map((section) => (
              <li key={section.id}>
                {section.children ? (
                  <>
                    <span className="toc-section-header">{section.label}</span>
                    <ul className="toc-children">
                      {section.children.map((child) => (
                        <li key={child.id}>
                          <a className="toc-child-link" href={`#${child.id}`}>
                            {child.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <a className="toc-link" href={`#${section.id}`}>
                    {section.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <main className="content">
          {children}
        </main>
      </div>
    </>
  );
}
