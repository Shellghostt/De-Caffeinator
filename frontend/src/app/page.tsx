'use client';

import { useState } from 'react';

type ArtifactResult = {
  endpoints: any[];
  secrets: any[];
  comments: any[];
};

export default function Home() {
  const [url, setUrl] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<ArtifactResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setIsScanning(true);
    setError(null);
    setResults(null);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to scan target');
      }

      setResults(data.results);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <>
      <nav className="navbar">
        <div className="logo">
          <div className="logo-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
              <line x1="12" y1="22.08" x2="12" y2="12"></line>
            </svg>
          </div>
          Blob Unpacker
        </div>
        <div className="nav-links">
          <a href="https://github.com/shellghostt/De-Caffeinator" target="_blank" rel="noreferrer" className="nav-link">GitHub</a>
          <a href="#" className="nav-link">Documentation</a>
        </div>
      </nav>

      <div className="container">
        <section className="hero">
          <h1 className="title">Reverse Engineer <span>JavaScript</span> at Scale</h1>
          <p className="subtitle">
            Automated discovery, de-obfuscation, and security artifact extraction pipeline. Now available in your browser.
          </p>

          <div className="scanner-box">
            <form onSubmit={handleScan} className="input-group">
              <input 
                type="url" 
                className="url-input" 
                placeholder="https://example.com" 
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                disabled={isScanning}
              />
              <button type="submit" className="scan-btn" disabled={isScanning || !url}>
                {isScanning ? 'Scanning...' : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"></circle>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    Analyze
                  </>
                )}
              </button>
            </form>
            {error && (
              <div style={{ color: '#ef4444', marginTop: '1rem', textAlign: 'left', fontWeight: 500 }}>
                Error: {error}
              </div>
            )}
          </div>
        </section>

        {isScanning && (
          <div className="loader-container">
            <div className="loader-ring"></div>
            <div className="loader-text">Analyzing target, crawling assets, and unpacking blobs...</div>
          </div>
        )}

        {results && !isScanning && (
          <div className="results-container">
            <div className="results-header">
              <h2 className="results-title">Analysis Report</h2>
              <div className="badge badge-medium">Scan Complete</div>
            </div>

            <div className="grid">
              <div className="stat-card endpoints">
                <div className="stat-header">
                  <div className="stat-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                    </svg>
                  </div>
                  <div className="stat-label">API Endpoints</div>
                </div>
                <div className="stat-value">{results.endpoints.length}</div>
              </div>

              <div className="stat-card secrets">
                <div className="stat-header">
                  <div className="stat-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                  </div>
                  <div className="stat-label">Hardcoded Secrets</div>
                </div>
                <div className="stat-value">{results.secrets.length}</div>
              </div>

              <div className="stat-card comments">
                <div className="stat-header">
                  <div className="stat-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                  </div>
                  <div className="stat-label">Dev Comments</div>
                </div>
                <div className="stat-value">{results.comments.length}</div>
              </div>
            </div>

            <div className="data-section">
              <div className="data-header">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
                Discovered Endpoints
              </div>
              {results.endpoints.length > 0 ? (
                <div className="data-list">
                  {results.endpoints.slice(0, 50).map((ep: any, idx: number) => (
                    <div key={idx} className="data-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600 }}>{ep.method || 'GET'} {ep.endpoint || ep.url || ep.value}</span>
                        <span className={`badge badge-${ep.confidence === 'high' ? 'high' : 'medium'}`}>
                          {ep.confidence || 'medium'}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Found in: {ep.source || ep.file}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No endpoints discovered.</div>
              )}
            </div>

            <div className="data-section">
              <div className="data-header" style={{ borderBottomColor: 'rgba(239, 68, 68, 0.2)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                <span style={{ color: '#ef4444' }}>Potential Secrets</span>
              </div>
              {results.secrets.length > 0 ? (
                <div className="data-list">
                  {results.secrets.map((sec: any, idx: number) => (
                    <div key={idx} className="data-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <span style={{ fontWeight: 600 }}>{sec.type || 'Secret'}</span>
                        <span className="badge badge-high">Entropy: {sec.entropy?.toFixed(2) || 'N/A'}</span>
                      </div>
                      <div className="code-block">{sec.value}</div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>Found in: {sec.source || sec.file}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No hardcoded secrets found.</div>
              )}
            </div>
            
            <div className="data-section">
              <div className="data-header" style={{ borderBottomColor: 'rgba(16, 185, 129, 0.2)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span style={{ color: '#10b981' }}>Developer Comments</span>
              </div>
              {results.comments.length > 0 ? (
                <div className="data-list">
                  {results.comments.slice(0, 50).map((cmt: any, idx: number) => (
                    <div key={idx} className="data-item">
                       <div className="code-block" style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                        // {cmt.value || cmt.text}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>Found in: {cmt.source || cmt.file}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No security-relevant comments found.</div>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}
