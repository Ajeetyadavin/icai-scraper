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
  const [bulkPrefix, setBulkPrefix] = useState('WRO');
  const [bulkStartNo, setBulkStartNo] = useState('0942133');
  const [bulkCount, setBulkCount] = useState('1000');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkProgress, setBulkProgress] = useState(null);
  const bulkEventSourceRef = useRef(null);
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

  // Background Jobs state
  const [jobsList, setJobsList] = useState([]);
  const [jobPolling, setJobPolling] = useState(false);
  const jobPollRef = useRef(null);

  // Find Latest state
  const [latestPrefix, setLatestPrefix] = useState('WRO');
  const [latestLoading, setLatestLoading] = useState(false);
  const [latestResult, setLatestResult] = useState(null);
  const [latestStatus, setLatestStatus] = useState('');
  const [latestCache, setLatestCache] = useState({});
  const [recentCount, setRecentCount] = useState('100');
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentRecords, setRecentRecords] = useState([]);
  const [recentStatus, setRecentStatus] = useState('');

  // Date-wise extraction state
  const [datePrefix, setDatePrefix] = useState('WRO');
  const [targetDate, setTargetDate] = useState(new Date().toISOString().split('T')[0]);
  const [dateLoading, setDateLoading] = useState(false);
  const [dateStatus, setDateStatus] = useState('');
  const [dateRecords, setDateRecords] = useState([]);

  const cleanedSrn = useMemo(() => query.trim().toUpperCase(), [query]);
  const cleanedMobile = useMemo(() => query.replace(/\D/g, '').slice(-10), [query]);
  const courseRows = useMemo(() => {
    return Array.isArray(result && result.courseRows) ? result.courseRows : [];
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

  useEffect(() => {
    let active = true;

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const json = await res.json();

        if (!active || !res.ok || !json.ok) {
          return;
        }

        const prefix = String(json.studentPrefix || 'WRO').trim().toUpperCase();
        const defaultStartNumber = String(json.defaultStartNumber || '0873000').trim();

        if (/^[A-Z]{3}$/.test(prefix)) {
          setBulkPrefix(prefix);
          setQuery(`${prefix}${defaultStartNumber}`);
        }
      } catch (_err) {
        // Keep the local defaults if the config endpoint is unavailable.
      }
    }

    loadConfig();

    return () => {
      active = false;
    };
  }, []);

  // Poll background jobs
  useEffect(() => {
    async function pollJobs() {
      try {
        const res = await fetch('/api/jobs');
        const json = await res.json();
        if (json.ok) setJobsList(json.jobs || []);
      } catch (_e) {}
    }
    pollJobs();
    jobPollRef.current = setInterval(pollJobs, 3000);
    return () => { if (jobPollRef.current) clearInterval(jobPollRef.current); };
  }, []);

  // Load latest cache
  useEffect(() => {
    async function loadCache() {
      try {
        var res = await fetch('/api/latest-cache');
        var json = await res.json();
        if (json.ok) setLatestCache(json.cache || {});
      } catch (_e) {}
    }
    loadCache();
  }, []);

  async function startBackgroundJob(e) {
    e.preventDefault();
    const prefix = bulkPrefix.trim().toUpperCase();
    const startNo = bulkStartNo.trim().padStart(7, '0');
    const count = Number(bulkCount);

    if (!/^[A-Z]{3}$/.test(prefix) || !/^\d{1,7}$/.test(bulkStartNo.trim()) || !Number.isFinite(count) || count < 1) {
      setBulkStatus('Invalid input');
      return;
    }

    setBulkStatus('Starting background job...');
    try {
      const res = await fetch('/api/jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, start: startNo, count })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to start job');
      setBulkStatus(`Job started: ${json.jobId}. Tab band karo — server pe chalti rahegi.`);
    } catch (err) {
      setBulkStatus(err.message || 'Failed to start job');
    }
  }

  async function cancelJob(jobId) {
    try {
      await fetch(`/api/jobs/cancel/${jobId}`, { method: 'POST' });
    } catch (_e) {}
  }

  function downloadJob(jobId) {
    window.open(`/api/jobs/download/${jobId}`, '_blank');
  }

  async function onFindLatest(prefix) {
    setLatestPrefix(prefix);
    setLatestLoading(true);
    setLatestResult(null);
    setRecentRecords([]);
    setRecentStatus('');

    var cached = latestCache[prefix];
    if (cached) {
      setLatestStatus(`${prefix}: Last known ${cached.srn} (${(cached.foundAt || '').split('T')[0] || ''}). Checking for new...`);
    } else {
      setLatestStatus(`${prefix} ka latest SRN search ho raha hai... (pehli baar — 30-60 sec lagega)`);
    }

    try {
      var res = await fetch('/api/find-latest?prefix=' + prefix);
      var json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed');
      setLatestResult(json);
      setLatestStatus(json.message);
      // Refresh cache
      var cacheRes = await fetch('/api/latest-cache');
      var cacheJson = await cacheRes.json();
      if (cacheJson.ok) setLatestCache(cacheJson.cache || {});
    } catch (err) {
      setLatestStatus(err.message || 'Failed to find latest');
    } finally {
      setLatestLoading(false);
    }
  }

  async function onExtractRecent() {
    if (!latestResult) return;
    setRecentLoading(true);
    setRecentStatus(`Extracting last ${recentCount} records from ${latestResult.latestSrn}...`);
    setRecentRecords([]);

    try {
      const res = await fetch(`/api/extract-recent?prefix=${latestResult.prefix}&latest=${latestResult.latestNumber}&count=${recentCount}`);
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed');
      setRecentRecords(json.records || []);
      setRecentStatus(`Found ${json.totalFound} records (${json.latestSrn} se backward)`);

      // Auto download CSV
      if (json.csv) {
        var csvBytes = atob(json.csv);
        var uint8Array = new Uint8Array(csvBytes.length);
        for (var i = 0; i < csvBytes.length; i++) {
          uint8Array[i] = csvBytes.charCodeAt(i);
        }
        var blob = new Blob([uint8Array], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = `latest_${latestResult.prefix}_${latestResult.latestNumber}_x${json.totalFound}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setRecentStatus(err.message || 'Extraction failed');
    } finally {
      setRecentLoading(false);
    }
  }

  async function onExtractByDate(e) {
    e.preventDefault();
    setDateLoading(true);
    setDateRecords([]);
    setDateStatus('Searching for ' + datePrefix + ' registrations on ' + targetDate + '...');

    try {
      var res = await fetch('/api/extract-by-date?prefix=' + datePrefix + '&date=' + targetDate);
      var json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed');
      setDateRecords(json.records || []);
      setDateStatus('Found ' + json.totalFound + ' records for ' + targetDate + ' (scanned ' + json.scanned + ' SRNs)');

      // Auto download CSV
      if (json.csv && json.totalFound > 0) {
        var csvBytes = atob(json.csv);
        var uint8Array = new Uint8Array(csvBytes.length);
        for (var i = 0; i < csvBytes.length; i++) {
          uint8Array[i] = csvBytes.charCodeAt(i);
        }
        var blob = new Blob([uint8Array], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = datePrefix + '_registrations_' + targetDate + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setDateStatus(err.message || 'Failed');
    } finally {
      setDateLoading(false);
    }
  }

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
        setError(`Valid SRN format dalo: ${bulkPrefix}0873000`);
        return;
      }
    } else if (!/^\d{10}$/.test(cleanedMobile)) {
      setError('Valid mobile number dalo: 10 digits');
      return;
    }

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
    setBulkProgress(null);

    const prefix = bulkPrefix.trim().toUpperCase();
    const startNo = bulkStartNo.trim();
    const count = Number(bulkCount);

    if (!/^[A-Z]{3}$/.test(prefix) || !/^\d{1,7}$/.test(startNo) || !Number.isFinite(count) || count < 1) {
      setBulkStatus('');
      return;
    }

    // Pad start number to 7 digits
    const paddedStart = startNo.padStart(7, '0');

    setBulkLoading(true);
    setBulkProgress({ completed: 0, total: count, ok: 0, failed: 0, elapsedMs: 0, etaMs: 0, lastSrn: '', lastName: '' });

    // Close any existing SSE connection
    if (bulkEventSourceRef.current) {
      bulkEventSourceRef.current.close();
      bulkEventSourceRef.current = null;
    }

    const params = new URLSearchParams({ prefix, start: paddedStart, count: String(count) });
    const eventSource = new EventSource(`/api/export-range-stream?${params.toString()}`);
    bulkEventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'error') {
          setBulkStatus(msg.error || 'Export failed');
          setBulkLoading(false);
          setBulkProgress(null);
          eventSource.close();
          return;
        }

        if (msg.type === 'start') {
          setBulkProgress((prev) => ({ ...prev, total: msg.total, concurrency: msg.concurrency }));
          return;
        }

        if (msg.type === 'progress') {
          setBulkProgress({
            completed: msg.completed,
            total: msg.total,
            ok: msg.ok,
            failed: msg.failed,
            elapsedMs: msg.elapsedMs,
            etaMs: msg.etaMs,
            lastSrn: msg.lastSrn || '',
            lastStatus: msg.lastStatus || '',
            lastName: msg.lastName || ''
          });
          return;
        }

        if (msg.type === 'throttle') {
          setBulkStatus(`⚠️ ${msg.message}`);
          return;
        }

        if (msg.type === 'complete') {
          // Decode base64 CSV and trigger download
          const csvBytes = atob(msg.csv);
          const uint8Array = new Uint8Array(csvBytes.length);
          for (let i = 0; i < csvBytes.length; i++) {
            uint8Array[i] = csvBytes.charCodeAt(i);
          }
          const blob = new Blob([uint8Array], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = msg.fileName || `students_${Date.now()}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);

          setBulkStatus(
            `✅ Done! ${msg.fileName} | Total: ${msg.total} | OK: ${msg.ok} | Failed: ${msg.failed} | Time: ${(msg.elapsedMs / 1000).toFixed(1)}s`
          );
          setBulkLoading(false);
          eventSource.close();
          return;
        }
      } catch (err) {
        // ignore parse errors
      }
    };

    eventSource.onerror = () => {
      setBulkStatus('Connection lost. Export may have failed.');
      setBulkLoading(false);
      eventSource.close();
    };
  }

  function onBulkCancel() {
    if (bulkEventSourceRef.current) {
      bulkEventSourceRef.current.close();
      bulkEventSourceRef.current = null;
    }
    setBulkLoading(false);
    setBulkStatus('Export cancelled.');
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
        // Upload files to server for merge (handles large files)
        const formData = new FormData();
        formData.append('dedupeSrn', String(dedupeSrn));
        for (const file of uploadedCsvFiles) {
          formData.append('files', file);
        }

        const res = await fetch('/api/merge-csv-upload', {
          method: 'POST',
          body: formData
        });

        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error || 'CSV merge failed');
        }

        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^\"]+)"?/i);
        const fileName = match ? match[1] : `merged_manual_${Date.now()}.csv`;

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
      <header className="appHeader">
        <div className="brandBlock">
          <div className="brandMark" aria-hidden="true">IC</div>
          <div>
            <div className="eyebrow">ICAI DATA WORKSPACE</div>
            <h1>Student Intelligence Console</h1>
            <p>Search profiles, locate recent registrations, and manage exports from one secure workspace.</p>
          </div>
        </div>

        <form className="sessionPanel" onSubmit={handleLogin}>
          <div className={"sessionIndicator" + (isLoggedIn ? " online" : "") }>
            <span className="statusDot" aria-hidden="true" />
            <span>{isLoggedIn ? "ICAI session active" : "Session disconnected"}</span>
          </div>
          <button
            type="submit"
            className={
              "loginBtn" +
              (isLoggedIn ? " success" : "") +
              (loginLoading ? " loading" : "")
            }
            disabled={loginLoading || isLoggedIn}
          >
            {loginLoading
              ? "Connecting..."
              : isLoggedIn
                ? "Connected"
                : "Connect ICAI"}
          </button>
          {loginError && <span className="sessionError">{loginError}</span>}
        </form>
      </header>

      <section className="overviewStrip" aria-label="Workspace overview">
        <div className="overviewItem">
          <span>Session</span>
          <strong>{isLoggedIn ? 'Online' : 'Offline'}</strong>
        </div>
        <div className="overviewItem">
          <span>Background jobs</span>
          <strong>{jobsList.length}</strong>
        </div>
        <div className="overviewItem">
          <span>Output files</span>
          <strong>{csvFiles.length}</strong>
        </div>
        <div className="overviewItem">
          <span>Cached regions</span>
          <strong>{Object.keys(latestCache).length}</strong>
        </div>
      </section>

      <button
        className={"cornerBulkBtn" + (showBulkTools ? " active" : "")}
        title={showBulkTools ? "Hide advanced tools" : "Show advanced tools"}
        onClick={() => setShowBulkTools((v) => !v)}
        aria-label="Show or hide advanced export tools"
        aria-expanded={showBulkTools}
      >
        <span className="toolsIcon" aria-hidden="true">{showBulkTools ? '×' : '≡'}</span>
      </button>

      <section className="searchCard primarySearchCard">
        <div className="sectionHeader">
          <div>
            <span className="sectionKicker">QUICK LOOKUP</span>
            <h2>Student Search</h2>
            <p>Retrieve a student profile using an SRN or a registered mobile number.</p>
          </div>
          <span className={"statusPill" + (isLoggedIn ? " success" : " warning")}>
            {isLoggedIn ? 'Ready' : 'Login required'}
          </span>
        </div>
        <div className="modeRow" role="tablist" aria-label="Search mode">
          <button
            type="button"
            className={searchMode === 'srn' ? 'modeBtn active' : 'modeBtn'}
            onClick={() => {
              setSearchMode('srn');
              setQuery(`${bulkPrefix}0873000`);
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
            placeholder={searchMode === 'srn' ? `${bulkPrefix}0873000` : '9876543210'}
            spellCheck="false"
            autoCapitalize={searchMode === 'srn' ? 'characters' : 'off'}
            disabled={!isLoggedIn}
            className={!isLoggedIn ? 'inputLocked' : ''}
          />
          <button type="submit" disabled={loading || !isLoggedIn}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
        {!isLoggedIn && <div className="metaLine dangerText">Connect your ICAI session to begin searching.</div>}

        <div className="searchStatusRow">
          <div className="metaLine">
            {loading ? `Loading ${loadingProgress}% · ${(elapsedMs / 1000).toFixed(1)}s` : 'Search service ready'}
          </div>
          {sourceMeta && <div className="metaLine sourceMeta">{sourceMeta}</div>}
        </div>

        <div className="progressTrack" aria-hidden="true">
          <div className="progressFill" style={{ width: `${loadingProgress}%` }} />
        </div>

        {error && <div className="errorBox">{error}</div>}
      </section>


      {/* ─── FIND LATEST REGISTRATION ─── */}
      {isLoggedIn && (
        <section className="searchCard featureCard latestCard">
          <div className="sectionHeader compact">
            <div>
              <span className="sectionKicker">REGISTRATION DISCOVERY</span>
              <h2>Find Latest Registration</h2>
              <p>
                Locate the newest SRN by region, then export the latest matching profiles.
                {Object.keys(latestCache).length > 0 && ' Saved checkpoints make repeat scans faster.'}
              </p>
            </div>
            <span className="statusPill info">{Object.keys(latestCache).length} cached</span>
          </div>
          <div className="regionGrid">
            {['WRO', 'CRO', 'ERO', 'SRO', 'NRO'].map(function(p) {
              var c = latestCache[p];
              return (
                <div key={p} className="regionOption">
                  <button
                    type="button"
                    className={"regionButton" + (latestPrefix === p ? " selected" : "")}
                    disabled={latestLoading}
                    onClick={function() { onFindLatest(p); }}
                  >
                    <span>{p}</span>
                    <small>{latestLoading && latestPrefix === p ? 'Searching' : 'Find latest'}</small>
                  </button>
                  {c && (
                    <span className="cacheStamp">
                      {c.srn} · {(c.foundAt || '').split('T')[0] || 'Saved'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {latestStatus && <div className="noticeLine">{latestStatus}</div>}

          {latestResult && (
            <div className="discoveryResult">
              <div className="discoverySummary">
                <div>
                  <span className="resultLabel">LATEST VERIFIED SRN</span>
                  <strong>{latestResult.latestSrn}</strong>
                </div>
                {latestResult.newRecordsSince > 0 && (
                  <span className="statusPill success">
                    +{latestResult.newRecordsSince} new
                  </span>
                )}
              </div>
              {latestResult.newRecordsSince > 0 && (
                <div className="inlineNotice successText">
                  New registrations since {latestResult.cachedDate ? latestResult.cachedDate.split('T')[0] : 'the last check'}.
                </div>
              )}
              {latestResult.cachedFrom && latestResult.newRecordsSince === 0 && (
                <div className="inlineNotice">
                  No new registrations since {latestResult.cachedDate ? latestResult.cachedDate.split('T')[0] : 'the last check'}.
                </div>
              )}
              <div className="actionRow">
                <label htmlFor="recentCount">Recent records</label>
                <input
                  id="recentCount"
                  className="compactInput"
                  value={recentCount}
                  onChange={function(e) { setRecentCount(e.target.value.replace(/\D/g, '').slice(0, 5)); }}
                  placeholder="100"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  className="primaryBtn"
                  disabled={recentLoading}
                  onClick={onExtractRecent}
                >
                  {recentLoading ? 'Preparing export...' : 'Extract & Download CSV'}
                </button>
              </div>
              {recentStatus && <div className="noticeLine">{recentStatus}</div>}
              {recentRecords.length > 0 && (
                <div className="recordsPreview">
                  <div className="previewHeader">
                    <strong>Recent registrations</strong>
                    <span>{recentRecords.length} records</span>
                  </div>
                  <div className="recordList">
                    {recentRecords.slice(0, 20).map(function(r, i) {
                      return (
                        <div key={i} className="recordRow">
                          <strong>{r.srn}</strong>
                          <span>{r.name}</span>
                          <small>{r.mobile || r.email || 'No contact'}</small>
                        </div>
                      );
                    })}
                    {recentRecords.length > 20 && (
                      <div className="recordMore">{recentRecords.length - 20} additional records are included in the CSV.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ─── DATE-WISE REGISTRATION DOWNLOAD ─── */}
      {isLoggedIn && (
        <section className="searchCard featureCard dateCard">
          <div className="sectionHeader compact">
            <div>
              <span className="sectionKicker">DATE-SPECIFIC EXPORT</span>
              <h2>Registration Timeline</h2>
              <p>Select a region and date to export only registrations recorded on that day.</p>
            </div>
            <span className="statusPill info">CSV export</span>
          </div>
          <form onSubmit={onExtractByDate} className="dateFilterRow">
            <label>
              <span>Region</span>
              <select
                value={datePrefix}
                onChange={function(e) { setDatePrefix(e.target.value); }}
              >
                <option value="WRO">WRO</option>
                <option value="CRO">CRO</option>
                <option value="ERO">ERO</option>
                <option value="SRO">SRO</option>
                <option value="NRO">NRO</option>
              </select>
            </label>
            <label>
              <span>Registration date</span>
              <input
                type="date"
                value={targetDate}
                onChange={function(e) { setTargetDate(e.target.value); }}
              />
            </label>
            <button
              type="submit"
              className="primaryBtn"
              disabled={dateLoading}
            >
              {dateLoading ? 'Scanning registrations...' : 'Download Date CSV'}
            </button>
          </form>
          {dateStatus && <div className="noticeLine">{dateStatus}</div>}
          {dateRecords.length > 0 && (
            <div className="recordsPreview">
              <div className="previewHeader">
                <strong>Matching registrations</strong>
                <span>{dateRecords.length} records</span>
              </div>
              <div className="recordList">
                {dateRecords.slice(0, 15).map(function(r, i) {
                  return (
                    <div key={i} className="recordRow">
                      <strong>{r.srn}</strong>
                      <span>{r.name}</span>
                      <small>{r.mobile || 'No mobile'}</small>
                    </div>
                  );
                })}
                {dateRecords.length > 15 && (
                  <div className="recordMore">{dateRecords.length - 15} additional records are included in the CSV.</div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <aside
        className={"bulkToolsPanel" + (showBulkTools ? " visible" : "")}
        aria-hidden={!showBulkTools}
        aria-label="Advanced export tools"
      >
        <div className="drawerHeader">
          <div>
            <span className="sectionKicker">ADVANCED WORKSPACE</span>
            <h2>Exports & Jobs</h2>
          </div>
          <button type="button" className="drawerClose" onClick={() => setShowBulkTools(false)} aria-label="Close advanced tools">×</button>
        </div>
        <section className="searchCard bulkCard">
          <h3>Bulk CSV Download (Range)</h3>
          <form className="bulkRow" onSubmit={onBulkDownload}>
            <input
              value={bulkPrefix}
              onChange={(e) => setBulkPrefix(e.target.value.toUpperCase())}
              placeholder="WRO"
              spellCheck="false"
              autoCapitalize="characters"
              maxLength={3}
            />
            <input
              value={bulkStartNo}
              onChange={(e) => setBulkStartNo(e.target.value.replace(/\D/g, '').slice(0, 7))}
              placeholder="0942133"
              spellCheck="false"
              inputMode="numeric"
              maxLength={7}
            />
            <input
              value={bulkCount}
              onChange={(e) => setBulkCount(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="1000"
              spellCheck="false"
              inputMode="numeric"
              maxLength={5}
            />
            <button type="submit" disabled={bulkLoading}>
              {bulkLoading ? 'Downloading...' : 'Download CSV'}
            </button>
            {bulkLoading && (
              <button type="button" className="cancelBtn" onClick={onBulkCancel}>
                Cancel
              </button>
            )}
          </form>

          {bulkLoading && bulkProgress && (
            <div className="bulkProgressBox">
              <div className="bulkProgressBar">
                <div
                  className="bulkProgressFill"
                  style={{ width: `${Math.round((bulkProgress.completed / (bulkProgress.total || 1)) * 100)}%` }}
                />
              </div>
              <div className="bulkProgressStats">
                <span className="bulkProgressCount">
                  <strong>{bulkProgress.completed}</strong> / {bulkProgress.total}
                </span>
                <span className="bulkProgressOk">✓ {bulkProgress.ok}</span>
                <span className="bulkProgressFail">✗ {bulkProgress.failed}</span>
                <span className="bulkProgressTime">
                  {(bulkProgress.elapsedMs / 1000).toFixed(1)}s elapsed
                </span>
                {bulkProgress.etaMs > 0 && (
                  <span className="bulkProgressEta">
                    ~{(bulkProgress.etaMs / 1000).toFixed(0)}s left
                  </span>
                )}
              </div>
              {bulkProgress.lastSrn && (
                <div className="bulkProgressLast">
                  Last: {bulkProgress.lastSrn}
                  {bulkProgress.lastName ? ` → ${bulkProgress.lastName}` : ''}
                  {bulkProgress.lastStatus === 'error' ? ' ❌' : ' ✅'}
                </div>
              )}
            </div>
          )}

          {bulkStatus ? <div className="metaLine">{bulkStatus}</div> : null}

          <div className="backgroundAction">
            <button
              type="button"
              className="primaryBtn fullWidth"
              onClick={startBackgroundJob}
            >
              Start Background Job
              <small>Continues after this tab is closed</small>
            </button>
          </div>
        </section>

        {/* Background Jobs List */}
        {jobsList.length > 0 && (
          <section className="searchCard bulkCard">
            <h3>Background Jobs</h3>
            <div style={{fontSize: 13, color: '#666', marginBottom: 8}}>
              Tab band karo, net band karo — server pe chalti rahegi. Wapas aake download karo.
            </div>
            {jobsList.map(function(job) {
              var pct = job.completed && job.count ? Math.round((job.completed / job.count) * 100) : 0;
              return (
                <div key={job.id} className="jobCard">
                  <div className="jobHeader">
                    <div>
                      <span>SRN RANGE</span>
                      <strong>{job.startSrn} + {job.count}</strong>
                    </div>
                    <span className={"jobStatus " + job.status}>
                      {job.status === 'complete' ? 'Complete' : job.status === 'running' ? 'Running' : job.status === 'failed' ? 'Failed' : job.status}
                    </span>
                  </div>
                  <div className="bulkProgressBar compactBar">
                    <div className="bulkProgressFill" style={{ width: pct + '%' }} />
                  </div>
                  <div className="jobStats">
                    <span><strong>{job.completed}</strong> / {job.count}</span>
                    <span className="successText">{job.ok} successful</span>
                    <span className="dangerText">{job.failed} failed</span>
                    <span>{(job.elapsedMs / 1000).toFixed(0)}s elapsed</span>
                  </div>
                  <div className="jobActions">
                    {job.status === 'complete' && (
                      <button type="button" className="primaryBtn compactBtn" onClick={function() { downloadJob(job.id); }}>
                        Download CSV
                      </button>
                    )}
                    {job.status === 'running' && (
                      <button type="button" className="cancelBtn compactBtn" onClick={function() { cancelJob(job.id); }}>
                        Cancel Job
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        )}

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
      </aside>

      {result && (
        <section className="resultCard">
          <div className="resultHead">
            <h2>{result.name || result.studentName || 'Student'}</h2>
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
            <h3>Foundation / Intermediate / Final Details</h3>
            {courseRows.length === 0 ? (
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
                    {courseRows.map((row, idx) => (
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
