const { useEffect, useMemo, useRef, useState } = React;

function parseCsvLine(line) {
  const row = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (ch === ',' && !quoted) {
      row.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  row.push(current);
  return row;
}

function toCsvLine(values) {
  return values
    .map((value) => {
      const s = String(value == null ? '' : value);
      return `"${s.replace(/"/g, '""')}"`;
    })
    .join(',');
}

function mergeCsvTexts(csvTexts, dedupeSrn) {
  let primaryHeaders = null;
  const outputLines = [];
  const seen = new Set();
  let mergedCount = 0;
  let duplicateCount = 0;

  for (const text of csvTexts) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .filter((line) => line.trim());

    if (lines.length === 0) {
      continue;
    }

    const sourceHeaders = parseCsvLine(lines[0]).map((h) => h.trim());
    if (!primaryHeaders) {
      primaryHeaders = sourceHeaders;
      outputLines.push(toCsvLine(primaryHeaders));
    }

    const srnPrimaryIdx = primaryHeaders.indexOf('SRN');

    for (let i = 1; i < lines.length; i += 1) {
      const sourceValues = parseCsvLine(lines[i]);
      const mappedValues = primaryHeaders.map((header) => {
        const idx = sourceHeaders.indexOf(header);
        return idx >= 0 ? sourceValues[idx] || '' : '';
      });

      if (dedupeSrn && srnPrimaryIdx >= 0) {
        const key = String(mappedValues[srnPrimaryIdx] || '')
          .trim()
          .toUpperCase();
        if (key) {
          if (seen.has(key)) {
            duplicateCount += 1;
            continue;
          }
          seen.add(key);
        }
      }

      outputLines.push(toCsvLine(mappedValues));
      mergedCount += 1;
    }
  }

  if (!primaryHeaders) {
    throw new Error('Selected CSV files are empty or invalid.');
  }

  return {
    csv: `${outputLines.join('\n')}\n`,
    mergedCount,
    duplicateCount
  };
}

function App() {
  const [searchMode, setSearchMode] = useState('srn');
  const [query, setQuery] = useState('WRO0873000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [durationMs, setDurationMs] = useState(null);
  const [sourceMeta, setSourceMeta] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bulkRange, setBulkRange] = useState('WRO0942133 +1000');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [csvFiles, setCsvFiles] = useState([]);
  const [selectedCsvFiles, setSelectedCsvFiles] = useState([]);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeStatus, setMergeStatus] = useState('');
  const [dedupeSrn, setDedupeSrn] = useState(true);
  const [showBulkTools, setShowBulkTools] = useState(false);
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [loginLoading, setLoginLoading] = useState(false);
    const [loginError, setLoginError] = useState("");
  const [mergeSource, setMergeSource] = useState('manual');
  const [uploadedCsvFiles, setUploadedCsvFiles] = useState([]);
  const startTimeRef = useRef(0);
  const intervalRef = useRef(null);

  const cleanedSrn = useMemo(() => query.trim().toUpperCase(), [query]);
  const cleanedMobile = useMemo(() => query.replace(/\D/g, '').slice(-10), [query]);
  const filteredCourseRows = useMemo(() => {
    const rows = Array.isArray(result && result.courseRows) ? result.courseRows : [];
    return rows.filter((row) => row.level === 'FOUNDATION' || row.level === 'INTERMEDIATE');
  }, [result]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    async function loadCsvFiles() {
      try {
        const res = await fetch('/api/csv-files');
        const json = await res.json();
        if (!res.ok || !json.ok) {
          throw new Error(json.error || 'Unable to load CSV files');
        }
        const files = Array.isArray(json.files) ? json.files : [];
        setCsvFiles(files);
      } catch (err) {
        setMergeStatus(err.message || 'Unable to load CSV files');
      }
    }

    loadCsvFiles();
  }, []);

  async function onSearch(e) {
    e.preventDefault();
    setError('');
    setResult(null);
    setDurationMs(null);
    setSourceMeta('');
    setElapsedMs(0);
    setLoadingProgress(0);

    if (searchMode === 'srn') {
      if (!/^[A-Z]{3}\d{7}$/.test(cleanedSrn)) {
        setError('Valid SRN format dalo: WRO0873000');
        return;
      }
    } else if (!/^\d{10}$/.test(cleanedMobile)) {
      setError('Valid mobile number dalo: 10 digits');
      return;
    }

    setLoading(true);
    startTimeRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      setElapsedMs(elapsed);
      setLoadingProgress((current) => {
        const next = Math.min(92, current + (elapsed < 1500 ? 8 : elapsed < 5000 ? 4 : 2));
        return next;
      });
    }, 120);

    try {
      const endpoint =
        searchMode === 'srn'
          ? `/api/search?srn=${encodeURIComponent(cleanedSrn)}`
          : `/api/search-by-mobile?mobile=${encodeURIComponent(cleanedMobile)}`;

      const res = await fetch(endpoint);
      const json = await res.json();

      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Search failed');
      }

      setResult(json.data);
      setDurationMs(json.durationMs || 0);
      setElapsedMs(json.durationMs || Date.now() - startTimeRef.current);
      setLoadingProgress(100);
      if (json.sourceFile) {
        setSourceMeta(`Source: ${json.source || 'local'} (${json.sourceFile})`);
      } else {
        setSourceMeta('Source: live ICAI fetch');
      }
    } catch (err) {
      setError(err.message || 'Backend error');
      setLoadingProgress(0);
    } finally {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLoading(false);
    }
  }

  async function onBulkDownload(e) {
    e.preventDefault();
    setBulkStatus('');

    const expression = bulkRange.trim().toUpperCase();
    if (!/^[A-Z]{3}\d{7}\s*\+\s*\d{1,5}$/.test(expression)) {
      setBulkStatus('Format galat hai. Example: WRO0942133 +1000');
      return;
    }

    setBulkLoading(true);
    setBulkStatus('Preparing CSV... thoda time lag sakta hai.');

    try {
      const res = await fetch(`/api/export-range?range=${encodeURIComponent(expression)}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Export failed');
      }

      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^\"]+)"?/i);
      const fileName = match ? match[1] : `students_${Date.now()}.csv`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const total = res.headers.get('x-export-total');
      const okCount = res.headers.get('x-export-ok');
      const failed = res.headers.get('x-export-failed');
      setBulkStatus(`Downloaded: ${fileName} | Total: ${total || '-'} | OK: ${okCount || '-'} | Failed: ${failed || '-'}`);
    } catch (err) {
      setBulkStatus(err.message || 'Export failed');
    } finally {
      setBulkLoading(false);
    }
  }

  function toggleCsvFile(name) {
    setSelectedCsvFiles((prev) => {
      if (prev.includes(name)) {
        return prev.filter((item) => item !== name);
      }
      return [...prev, name];
    });
  }

  async function onMergeDownload(e) {
    e.preventDefault();
    setMergeStatus('');

    if (mergeSource === 'server') {
      if (selectedCsvFiles.length < 2) {
        setMergeStatus('Kam se kam 2 CSV files select karo.');
        return;
      }
    } else if (uploadedCsvFiles.length < 2) {
      setMergeStatus('Manual merge ke liye kam se kam 2 CSV files upload karo.');
      return;
    }

    setMergeLoading(true);
    setMergeStatus('Merging CSV files...');

    try {
      if (mergeSource === 'server') {
        const res = await fetch('/api/merge-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: selectedCsvFiles, dedupeSrn })
        });

        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error || 'CSV merge failed');
        }

        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^\"]+)"?/i);
        const fileName = match ? match[1] : `merged_${Date.now()}.csv`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        const rows = res.headers.get('x-merge-rows');
        const dups = res.headers.get('x-merge-duplicates');
        const files = res.headers.get('x-merge-files');
        setMergeStatus(
          `Downloaded: ${fileName} | Files: ${files || '-'} | Rows: ${rows || '-'} | Duplicates skipped: ${dups || '0'}`
        );
      } else {
        const texts = await Promise.all(uploadedCsvFiles.map((file) => file.text()));
        const merged = mergeCsvTexts(texts, dedupeSrn);
        const fileName = `merged_manual_${Date.now()}.csv`;

        const blob = new Blob([merged.csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setMergeStatus(
          `Downloaded: ${fileName} | Files: ${uploadedCsvFiles.length} | Rows: ${merged.mergedCount} | Duplicates skipped: ${merged.duplicateCount}`
        );
      }
    } catch (err) {
      setMergeStatus(err.message || 'CSV merge failed');
    } finally {
      setMergeLoading(false);
    }
  }

  // Simulate login API call
  async function handleLogin(e) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/login", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }
      setIsLoggedIn(true);
    } catch (err) {
      const errMsg = err.message || "Login failed. Try again.";
      console.error('[FRONTEND] Login error:', errMsg);
      setLoginError(errMsg);
      setIsLoggedIn(false);
    } finally {
      setLoginLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <h1>ICAI Instant Student Search</h1>
        <form onSubmit={handleLogin} style={{marginTop: 18, marginBottom: 18, display: 'flex', gap: 12, alignItems: 'center'}}>
          <button
            type="submit"
            className={
              "loginBtn" +
              (isLoggedIn ? " success" : "") +
              (loginLoading ? " loading" : "")
            }
            disabled={loginLoading || isLoggedIn}
            style={{minWidth: 120, minHeight: 44, fontSize: 18, fontWeight: 600}}
          >
            {loginLoading
              ? "Connecting to server..."
              : isLoggedIn
                ? "Connected"
                : "Login"}
          </button>
          {isLoggedIn && <span style={{color: '#0a8a3c', fontWeight: 600}}>● Connected</span>}
          {loginError && <span style={{color: '#b3261e', fontWeight: 500}}>{loginError}</span>}
        </form>
      </section>

      <button
        className={"cornerBulkBtn" + (showBulkTools ? " active" : "")}
        title={showBulkTools ? "Hide bulk tools" : "Show bulk tools"}
        onClick={() => setShowBulkTools((v) => !v)}
        aria-label="Show/hide bulk/merge tools"
      >
        <span style={{fontSize: 22, fontWeight: 700}}>≡</span>
      </button>

      <section className="searchCard">
        <div className="modeRow" role="tablist" aria-label="Search mode">
          <button
            type="button"
            className={searchMode === 'srn' ? 'modeBtn active' : 'modeBtn'}
            onClick={() => {
              setSearchMode('srn');
              setQuery('WRO0873000');
            }}
          >
            Search by SRN
          </button>
          <button
            type="button"
            className={searchMode === 'mobile' ? 'modeBtn active' : 'modeBtn'}
            onClick={() => {
              setSearchMode('mobile');
              setQuery('');
            }}
          >
            Search by Mobile
          </button>
        </div>

        <form className="searchRow" onSubmit={onSearch}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchMode === 'srn' ? 'WRO0873000' : '9876543210'}
            spellCheck="false"
            autoCapitalize={searchMode === 'srn' ? 'characters' : 'off'}
            disabled={!isLoggedIn}
            style={!isLoggedIn ? {background: '#f3f3f3', color: '#aaa'} : {}}
          />
          <button type="submit" disabled={loading || !isLoggedIn}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
        {!isLoggedIn && <div className="metaLine" style={{color: '#b3261e'}}>Please login to search.</div>}

        <div className="metaLine">
          {loading ? `Loading ${loadingProgress}% · ${(elapsedMs / 1000).toFixed(1)}s` : 'Ready'}
        </div>

        <div className="progressTrack" aria-hidden="true">
          <div className="progressFill" style={{ width: `${loadingProgress}%` }} />
        </div>

        {error && <div className="errorBox">{error}</div>}
      </section>


      <div className={"bulkToolsPanel" + (showBulkTools ? " visible" : "")}
        style={{display: showBulkTools ? undefined : 'none'}}>
        <section className="searchCard bulkCard">
          <h3>Bulk CSV Download (Range)</h3>
          <form className="searchRow" onSubmit={onBulkDownload}>
            <input
              value={bulkRange}
              onChange={(e) => setBulkRange(e.target.value)}
              placeholder="WRO0942133 +1000"
              spellCheck="false"
              autoCapitalize="characters"
            />
            <button type="submit" disabled={bulkLoading}>
              {bulkLoading ? 'Preparing...' : 'Download CSV'}
            </button>
          </form>
          <div className="metaLine">Example: WRO0942133 +1000 means 1000 SRN records from start SRN.</div>
          {bulkStatus ? <div className="metaLine">{bulkStatus}</div> : null}
        </section>

        <section className="searchCard bulkCard">
          <h3>Merge Multiple CSV Files</h3>
          <div className="modeRow" role="tablist" aria-label="Merge source mode">
            <button
              type="button"
              className={mergeSource === 'manual' ? 'modeBtn active' : 'modeBtn'}
              onClick={() => setMergeSource('manual')}
            >
              Manual Upload
            </button>
            <button
              type="button"
              className={mergeSource === 'server' ? 'modeBtn active' : 'modeBtn'}
              onClick={() => setMergeSource('server')}
            >
              Output Folder Files
            </button>
          </div>

          <form onSubmit={onMergeDownload}>
            <div className="mergeTools">
              <label className="checkRow">
                <input type="checkbox" checked={dedupeSrn} onChange={(e) => setDedupeSrn(e.target.checked)} />
                <span>Skip duplicate SRN rows</span>
              </label>
              <button
                type="submit"
                disabled={
                  mergeLoading ||
                  (mergeSource === 'server' ? selectedCsvFiles.length < 2 : uploadedCsvFiles.length < 2)
                }
                className="mergeBtn"
              >
                {mergeLoading ? 'Merging...' : 'Merge & Download'}
              </button>
            </div>

            {mergeSource === 'manual' ? (
              <>
                <div className="metaLine">Apne system se multiple CSV files upload karo:</div>
                <input
                  className="fileUploadInput"
                  type="file"
                  accept=".csv,text/csv"
                  multiple
                  onChange={(e) => setUploadedCsvFiles(Array.from(e.target.files || []))}
                />
                <div className="metaLine">Selected: {uploadedCsvFiles.length} file(s)</div>
              </>
            ) : (
              <>
                <div className="metaLine">Select multiple files from output folder:</div>
                <div className="fileList" role="group" aria-label="CSV files">
                  {csvFiles.length === 0 ? (
                    <div className="metaLine">No CSV files found.</div>
                  ) : (
                    csvFiles.map((name) => (
                      <label key={name} className="fileItem">
                        <input
                          type="checkbox"
                          checked={selectedCsvFiles.includes(name)}
                          onChange={() => toggleCsvFile(name)}
                        />
                        <span>{name}</span>
                      </label>
                    ))
                  )}
                </div>
              </>
            )}
          </form>
          {mergeStatus ? <div className="metaLine">{mergeStatus}</div> : null}
        </section>
      </div>

      {result && (
        <section className="resultCard">
          <div className="resultHead">
            <h2>{result.studentName || 'Student'}</h2>
            <div className="badge">{result.srn || 'N/A'}</div>
          </div>

          <div className="grid">
            <div className="field">
              <span>SRN</span>
              <strong>{result.srn || '-'}</strong>
            </div>
            <div className="field">
              <span>DOB</span>
              <strong>{result.dob || '-'}</strong>
            </div>
            <div className="field">
              <span>Sex</span>
              <strong>{result.sex || '-'}</strong>
            </div>
            <div className="field">
              <span>Aadhar Category</span>
              <strong>{result.aadharCategory || '-'}</strong>
            </div>
            <div className="field">
              <span>Father</span>
              <strong>{result.father || '-'}</strong>
            </div>
            <div className="field">
              <span>Mother</span>
              <strong>{result.mother || '-'}</strong>
            </div>
            <div className="field">
              <span>Email</span>
              <strong>{result.email || '-'}</strong>
            </div>
            <div className="field">
              <span>Mobile</span>
              <strong>{result.mobile || '-'}</strong>
            </div>
            <div className="field">
              <span>Correspondence Address</span>
              <strong>{result.correspondenceAddress || '-'}</strong>
            </div>
            <div className="field">
              <span>Permanent Address</span>
              <strong>{result.permanentAddress || '-'}</strong>
            </div>
            <div className="field">
              <span>PIN</span>
              <strong>{result.pin || '-'}</strong>
            </div>
          </div>

          <div className="courseSection">
            <h3>Foundation / Intermediate Details</h3>
            {filteredCourseRows.length === 0 ? (
              <div className="metaLine">Course details not found in this SRN.</div>
            ) : (
              <div className="tableWrap">
                <table className="courseTable">
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Course</th>
                      <th>Registration Date</th>
                      <th>Re-Registration Date</th>
                      <th>Marks</th>
                      <th>Max Marks</th>
                      <th>%</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCourseRows.map((row, idx) => (
                      <tr key={`${row.course}-${row.rollNo || idx}`}>
                        <td>{row.level || '-'}</td>
                        <td>{row.course || '-'}</td>
                        <td>{row.registrationDate || '-'}</td>
                        <td>{row.reRegistrationDate || '-'}</td>
                        <td>{row.mark || '-'}</td>
                        <td>{row.maxMark || '-'}</td>
                        <td>{row.percentage || '-'}</td>
                        <td>{row.resultStatus || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
