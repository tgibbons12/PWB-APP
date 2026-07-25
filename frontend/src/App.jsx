import { useState, useRef, useCallback, useEffect } from "react";

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; width: 100%; max-width: 100% !important; padding: 0 !important; overflow: hidden; text-align: left; }
  body { background: #E4E3EA; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: #000; -webkit-font-smoothing: antialiased; }
  .shell { height: 100dvh; width: 100%; display: flex; flex-direction: column; background: #E4E3EA; padding: 16px 16px 0; }
  .card { background: #9B9B9B; border: 1px solid #888888; border-radius: 12px; overflow: hidden; flex: 1; display: flex; flex-direction: column; min-height: 0; box-shadow: 0 1px 8px rgba(0,0,0,0.18); }
  .title-bar { background: #E4E3EA; display: flex; align-items: center; justify-content: center; padding: 7px 16px 6px; flex-shrink: 0; position: relative; }
  .title-bar h1 { font-size: 14px; font-weight: 400; color: #578E48; text-align: center; }
  .title-settings-btn { background: none; border: none; color: #007aff; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-family: inherit; position: absolute; right: 12px; top: 50%; transform: translateY(-50%); }
  .title-settings-btn:active { opacity: 0.5; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-height: 0; padding: 8px 8px 0; gap: 16px; }
  .panel { background: #ffffff; padding: 10px 18px 14px; display: flex; flex-direction: column; gap: 0; border: 1px solid #d0d0d5; border-radius: 10px; overflow-y: auto; min-height: 0; }
  .srow { display: flex; flex-direction: column; align-items: center; padding: 7px 0 6px; gap: 5px; }
  .srow + .srow { border-top: 1px solid #e5e5ea; }
  .lbl { font-size: 13px; font-weight: 400; color: #000; text-align: center; line-height: 1.3; }
  .lbl-muted { font-size: 11px; font-weight: 400; color: #8e8e93; text-align: center; line-height: 1.3; }
  .seg { display: inline-flex; background: rgba(118,118,128,0.12); border-radius: 9px; padding: 2px; }
  .seg-btn { background: transparent; border: none; border-radius: 7px; font-size: 13px; font-weight: 400; color: #3c3c43; padding: 5px 14px; cursor: pointer; font-family: inherit; min-width: 48px; text-align: center; white-space: nowrap; }
  .seg-btn.active { background: #ffffff; color: #000; font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,0.18); }
  .seg-btn:not(.active):active { background: rgba(0,0,0,0.05); }
  .ios-toggle { position: relative; width: 44px; height: 26px; display: block; flex-shrink: 0; }
  .ios-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
  .ios-track { position: absolute; inset: 0; background: #e5e5ea; border-radius: 26px; cursor: pointer; transition: background 0.22s; }
  .ios-track::before { content: ''; position: absolute; width: 22px; height: 22px; left: 2px; top: 2px; background: #fff; border-radius: 50%; box-shadow: 0 2px 5px rgba(0,0,0,0.28); transition: transform 0.22s; }
  .ios-toggle input:checked ~ .ios-track { background: #578E48; }
  .ios-toggle input:checked ~ .ios-track::before { transform: translateX(18px); }
  .ios-select { width: 100%; font-size: 13px; font-family: inherit; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.15); background: #fff; color: #000; -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23007aff' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; cursor: pointer; }
  .ios-input { width: 100%; font-size: 15px; font-family: inherit; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.15); background: #fff; color: #000; text-align: center; }
  .ios-input:focus { outline: 2px solid #007aff; outline-offset: 1px; }
  .ios-input:disabled { background: #f2f2f7; color: #8e8e93; }
  .scenario-row { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 4px 0; width: 100%; }
  .scenario-radio { display: flex; align-items: center; gap: 7px; font-size: 13px; color: #000; cursor: pointer; }
  .scenario-radio.dim { color: #8e8e93; }
  .scenario-radio input { accent-color: #007aff; width: 16px; height: 16px; }
  .field-row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; gap: 8px; width: 100%; }
  .field-lbl-active { font-size: 12px; color: #3c3c43; flex-shrink: 0; }
  .field-lbl-muted  { font-size: 12px; color: #c0c0c0; flex-shrink: 0; }
  .ro-val-muted { font-size: 12px; color: #c0c0c0; font-family: "SF Mono","Courier New",monospace; }
  .ro-val-green { font-size: 12px; font-weight: 600; color: #578E48; font-family: "SF Mono","Courier New",monospace; }
  .ro-val-red   { font-size: 12px; font-weight: 600; color: #c0392b; font-family: "SF Mono","Courier New",monospace; }
  .preview-panel { background: #ffffff; font-family: "SF Mono","Courier New",monospace; font-size: 11.5px; line-height: 1.55; color: #000; padding: 10px 14px; overflow-y: auto; white-space: pre; border: 1px solid #d0d0d5; border-radius: 10px; min-height: 0; }
  .fullscreen-preview-backdrop { position: fixed; inset: 0; background: #2c2c2e; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 48px; }
  .fullscreen-preview-frame { background: #ffffff; border-radius: 14px; width: 100%; height: 100%; max-width: 900px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,0.4); }
  .fullscreen-preview-text { flex: 1; overflow-y: auto; font-family: "SF Mono","Courier New",monospace; font-size: 15px; line-height: 1.6; color: #000; white-space: pre; padding: 28px 32px; }
  .fullscreen-preview-close { align-self: center; margin: 0 0 18px; background: #3a3a3c; color: #fff; border: none; border-radius: 9px; font-size: 14px; font-weight: 600; font-family: inherit; padding: 9px 22px; cursor: pointer; }
  .gen-btn { background: #578E48; color: #fff; border: none; border-radius: 9px; font-size: 14px; font-weight: 600; font-family: inherit; padding: 9px 22px; cursor: pointer; }
  .gen-btn:active { opacity: 0.85; }
  .sec-btn { background: none; border: 1px solid rgba(0,0,0,0.18); border-radius: 9px; font-size: 13px; font-family: inherit; padding: 8px 14px; cursor: pointer; color: #007aff; }
  .sec-btn:active { background: rgba(0,0,0,0.05); }
  .gen-btn-row { display: flex; gap: 8px; align-items: center; padding: 10px 0 2px; justify-content: center; position: sticky; bottom: 0; background: #ffffff; border-top: 1px solid #eee; margin-top: 8px; z-index: 2; }
  .bottom-bar { background: #ffffff; border-top: 1px solid #c6c6c8; margin: 0 8px 8px; border-radius: 0 0 8px 8px; padding: 8px 16px 10px; display: flex; align-items: center; justify-content: center; gap: 24px; flex-shrink: 0; }
  .bot-btn { background: none; border: none; color: #007aff; font-size: 14px; font-family: inherit; cursor: pointer; }
  .bot-btn:active { opacity: 0.5; }
  .bot-type { font-size: 16px; font-weight: 700; color: #578E48; }
  /* TAB BAR — naclandapp pattern */
  .tab-bar { background: transparent; display: flex; flex-shrink: 0; padding: 4px 0 env(safe-area-inset-bottom, 8px); }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 6px 10px 4px; cursor: pointer; gap: 3px; background: none; border: none; font-family: inherit; }
  .tab-lbl { font-size: 11px; color: #8e8e93; }
  .tab-lbl.on { color: #007aff; }
  .tab-bar-indicator { width: 36px; height: 4px; background: #000; border-radius: 2px; margin: 3px auto 0; }
  /* COLLAPSE */
  .collapse-section { overflow: hidden; transition: max-height 0.28s ease, opacity 0.28s ease; }
  .collapse-section.hidden { max-height: 0; opacity: 0; pointer-events: none; }
  .collapse-section.visible { max-height: 800px; opacity: 1; }
  /* TOAST */
  .toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.78); color: #fff; font-size: 13px; padding: 8px 18px; border-radius: 20px; white-space: nowrap; pointer-events: none; transition: opacity 0.4s; z-index: 100; }
  /* FOLDER BADGE */
  .folder-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(87,142,72,0.1); border-radius: 8px; padding: 3px 10px; }
  .folder-badge-dot { width: 7px; height: 7px; border-radius: 50%; background: #578E48; flex-shrink: 0; }
  .folder-badge-txt { font-size: 11px; color: #578E48; font-family: "SF Mono","Courier New",monospace; }
  /* SETTINGS SHEET */
  .sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 200; display: flex; align-items: flex-end; justify-content: center; }
  .sheet { background: #f2f2f7; border-radius: 20px 20px 0 0; width: 100%; max-width: 600px; padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 16px; }
  .sheet-handle { width: 36px; height: 4px; background: #c7c7cc; border-radius: 2px; margin: 0 auto 8px; }
  .sheet-title { font-size: 17px; font-weight: 600; text-align: center; }
  .sheet-section { background: #fff; border-radius: 12px; overflow: hidden; }
  .sheet-row { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; gap: 12px; }
  .sheet-row + .sheet-row { border-top: 1px solid #e5e5ea; }
  .sheet-row-lbl { font-size: 15px; }
  .sheet-hint { font-size: 12px; color: #8e8e93; line-height: 1.4; }
  .sheet-action-btn { background: none; border: none; color: #007aff; font-size: 15px; font-family: inherit; cursor: pointer; }
  .sheet-action-btn:active { opacity: 0.5; }
  .sheet-action-btn:disabled { opacity: 0.35; cursor: default; }
  .sheet-close-btn { background: #578E48; color: #fff; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; font-family: inherit; padding: 14px; cursor: pointer; width: 100%; }
  .sheet-close-btn:active { opacity: 0.85; }
`;

// ─── API ──────────────────────────────────────────────────────────────────────
// Two backends, two different jobs:
//
// API_BASE (Railway) handles TPS generation and SimBrief fetch — anything
// that needs to be reachable from any device (iPad, phone, etc) anywhere.
//
// CLOSEOUT_API_BASE is a Flask instance running LOCALLY on the ops machine
// (the same Mac that has the ACARS oooi_log.txt folder and the printer's
// watched folder). Closeout generation needs real filesystem access to
// read oooi_log.txt and write the output where the ACARS printer picks it
// up — that's not something a cloud server can ever do, regardless of any
// browser-side workaround, since the folder physically only exists on that
// one Mac. This is set separately (not just localhost) because the iPad
// reaches it over the local network by the Mac's LAN IP, not "localhost"
// (localhost from the iPad's browser means the iPad itself).
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";
const CLOSEOUT_API_BASE = import.meta.env.VITE_CLOSEOUT_API_BASE || API_BASE;

async function apiFlightplan(rawXml) {
  const res = await fetch(`${API_BASE}/api/flightplan`, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: rawXml,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to parse flight plan.", data.detail);
  return data;
}

async function apiFlightplanBySimbrief(username) {
  const res = await fetch(`${API_BASE}/api/flightplan/simbrief`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to fetch flight plan from SimBrief.", data.detail);
  return data;
}

async function apiGenerateTps(payload) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Generation failed.", data.detail);
  return data;
}

async function apiGenerateCloseout(payload) {
  let res;
  try {
    res = await fetch(`${CLOSEOUT_API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Distinct message from a generic network failure — this almost always
    // means the local closeout backend isn't running on this Mac, or the
    // iPad/device isn't on the same network as it.
    throw new ApiError(
      "Could not reach the closeout server.",
      `Checked ${CLOSEOUT_API_BASE} — make sure the local closeout app is running and this device is on the same network.`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Closeout generation failed.", data.detail);
  return data;
}

async function apiOooiStatus() {
  let res;
  try {
    res = await fetch(`${CLOSEOUT_API_BASE}/api/oooi/status`);
  } catch (e) {
    throw new ApiError(
      "Could not reach the closeout server.",
      `Checked ${CLOSEOUT_API_BASE} — make sure the local closeout app is running and this device is on the same network.`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to check OOOI status.", data.detail);
  return data;
}

async function apiRunwayIndexStatus() {
  const res = await fetch(`${API_BASE}/api/admin/runway-index`);
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to check runway index status.", data.detail);
  return data;
}

async function apiUploadRunwayIndex(rawText) {
  const res = await fetch(`${API_BASE}/api/admin/runway-index`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawText,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Upload failed.", data.detail);
  return data;
}

async function apiParseOooi(rawText) {
  const res = await fetch(`${API_BASE}/api/oooi/parse`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawText,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to parse OOOI log.", data.detail);
  return data;
}

// ─── FOLDER HANDLE PERSISTENCE ─────────────────────────────────────────────────
// localStorage can only store strings, so it can only remember the folder's
// NAME (cosmetic) — not a reusable handle. FileSystemDirectoryHandle objects
// are structured-cloneable, so IndexedDB (unlike localStorage) can actually
// store and later return a working handle. Keyed by SimBrief username since
// that's the closest thing this app has to a per-person identity — different
// pilots on the same shared machine/browser can each get their own
// remembered save folder.
const FOLDER_DB_NAME  = "tps_folders";
const FOLDER_STORE    = "handles";

function openFolderDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FOLDER_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FOLDER_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFolderHandleForUser(username, handle) {
  if (!username) return;
  const db = await openFolderDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readwrite");
    tx.objectStore(FOLDER_STORE).put(handle, username);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getFolderHandleForUser(username) {
  if (!username) return null;
  const db = await openFolderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readonly");
    const req = tx.objectStore(FOLDER_STORE).get(username);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearFolderHandleForUser(username) {
  if (!username) return;
  const db = await openFolderDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readwrite");
    tx.objectStore(FOLDER_STORE).delete(username);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Forces a real "Save As" / download action rather than letting the browser
// open the file inline. text/plain is NOT reliable for this — Safari on iOS
// and some Android browsers will preview a text/plain blob in a new tab
// instead of downloading it, even with the `download` attribute set.
// application/octet-stream tells the browser "unknown binary, don't try to
// render this" which is what actually forces the save dialog everywhere.
function forceDownloadTxt(content, filename) {
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename || "output.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL shortly after — some browsers cancel the download if
  // revoked immediately/synchronously, so this waits a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

const SCENARIO_DEFS = [
  { key: "DRY_PTOW",      surface: "DRY", cond: "PTOW",      label: "DRY — PTOW  (calm wind)" },
  { key: "DRY_PTOW+4000", surface: "DRY", cond: "PTOW+4000", label: "DRY — PTOW +4000 lbs"    },
  { key: "WET_PTOW",      surface: "WET", cond: "PTOW",      label: "WET — PTOW  (calm wind)" },
  { key: "WET_PTOW+4000", surface: "WET", cond: "PTOW+4000", label: "WET — PTOW +4000 lbs"    },
];

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled = false }) {
  return (
    <label className="ios-toggle" style={{ opacity: disabled ? 0.4 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={e => !disabled && onChange(e.target.checked)} />
      <span className="ios-track" />
    </label>
  );
}

function PlaneIcon({ active }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"
      style={{ color: active ? "#007aff" : "#8e8e93", opacity: active ? 1 : 0.4 }}>
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>
  );
}

// ─── TPS LEFT PANEL ───────────────────────────────────────────────────────────
function TpsPanel({ xmlData, onGenerate, generating }) {
  const [scenario, setScenario]             = useState("PLANNED");
  const [condOverride, setCondOverride]     = useState(false);
  const [oat, setOat]                       = useState(xmlData.temp);
  const [qnh, setQnh]                       = useState(xmlData.qnh);
  const [wind, setWind]                     = useState(xmlData.wind);
  const [antiIce, setAntiIce]               = useState(false);
  const [runway, setRunway]                 = useState(() => {
    const planRwy = xmlData.plan_rwy;
    const matches = xmlData.valid_runways.some(r => r.id === planRwy);
    return matches ? planRwy : (xmlData.valid_runways[0]?.id ?? "");
  });
  const [intersection, setIntersection]     = useState("FULL");
  const [speedOverrides, setSpeedOverrides] = useState({});
  const [forceMax, setForceMax]             = useState(false);

  const rwyData = xmlData.valid_runways.find(r => r.id === runway) || xmlData.valid_runways[0];
  // xml_data.valid_runways (from parse_xml_raw) has no 'intxn' field — the
  // backend computes intersections separately via get_intersection_groups()
  // and returns them as a runway-id-keyed map, since that data depends on
  // runway_index.dat rather than anything in the SimBrief XML itself.
  const intxnOptions = xmlData.intersections?.[rwyData.id] ?? ["FULL"];
  function getSpeed(k) { return speedOverrides[k] ?? rwyData[k] ?? ""; }
  function setSpeed(k, v) { setSpeedOverrides(p => ({ ...p, [k]: v })); }
  function tlrAvail(s, c) { return !!(xmlData.tlr_tables?.[s]?.[c]); }

  function handleGenerateClick() {
    onGenerate("tps", {
      scenario, condOverride, oat, qnh, wind, antiIce,
      runway, intersection, speedOverrides, forceMax,
    });
  }

  return (
    <div className="panel">
      {/* SECTION HEADER */}
      <div className="srow"><div className="lbl">TPS — Scenario &amp; Conditions</div></div>

      {/* TLR Scenario */}
      <div className="srow">
        <div className="lbl">TLR Scenario</div>
        <div className="scenario-row">
          <label className="scenario-radio">
            <input type="radio" name="sc" checked={scenario === "PLANNED"} onChange={() => setScenario("PLANNED")} />
            Planned  (SimBrief XML speeds)
          </label>
          {SCENARIO_DEFS.map(({ key, surface, cond, label }) => {
            const avail = tlrAvail(surface, cond);
            return (
              <label key={key} className={`scenario-radio${!avail ? " dim" : ""}`}>
                <input type="radio" name="sc" checked={scenario === key}
                  onChange={() => avail && setScenario(key)} disabled={!avail} />
                {label}{!avail ? "  (not in TLR)" : ""}
              </label>
            );
          })}
        </div>
      </div>

      {/* Conditions Override */}
      <div className="srow">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle checked={condOverride} onChange={v => { setCondOverride(v); if (!v) setAntiIce(false); }} />
          <span className="lbl">Override Conditions (manual)</span>
        </div>
        <div className={`collapse-section ${condOverride ? "visible" : "hidden"}`} style={{ width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 }}>
            {[["OAT (°C)", oat, setOat], ["QNH (in Hg)", qnh, setQnh], ["Wind (ddd/ss)", wind, setWind]].map(([l, v, s]) => (
              <div key={l} className="field-row">
                <span className="field-lbl-active" style={{ width: 110 }}>{l}</span>
                <input className="ios-input" style={{ maxWidth: 120 }} value={v} onChange={e => s(e.target.value)} />
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Toggle checked={antiIce} onChange={setAntiIce} />
              <span className="lbl" style={{ fontSize: 13 }}>Anti-Ice ON</span>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION HEADER */}
      <div className="srow"><div className="lbl">TPS — Runway, Speeds &amp; V-Speed Data</div></div>

      {/* Runway */}
      <div className="srow">
        <div className="lbl">Departure Runway</div>
        <select className="ios-select" value={runway}
          onChange={e => { setRunway(e.target.value); setIntersection("FULL"); setSpeedOverrides({}); }}>
          {xmlData.valid_runways.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
        </select>
      </div>

      {/* Intersection */}
      <div className="srow">
        <div className="lbl">Intersection</div>
        <select className="ios-select" value={intersection} onChange={e => setIntersection(e.target.value)}>
          {intxnOptions.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      {/* V-speeds */}
      <div className="srow">
        {[["V1","v1"],["VR","vr"],["V2","v2"],["FLEX / AT","flex"],["Flaps","flaps"]].map(([lbl, key]) => (
          <div key={key} className="field-row">
            <span className="field-lbl-active" style={{ width: 80 }}>{lbl}</span>
            <input className="ios-input" style={{ maxWidth: 100 }}
              value={key === "flex" && forceMax ? "" : getSpeed(key)}
              disabled={key === "flex" && forceMax}
              onChange={e => setSpeed(key, e.target.value)} />
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 2, width: "100%" }}>
          <Toggle checked={forceMax} onChange={v => { setForceMax(v); if (v) setSpeed("flex", ""); }} />
          <span className="lbl" style={{ fontSize: 13 }}>Select MAX (below FLEX)</span>
        </div>
      </div>

      {/* No pre-generation performance preview: generate_tps() returns
          finished text, not a structured N1/MTOW/ATOW object, so there's
          nothing authoritative to show until after Generate completes —
          the full result appears in the preview panel on the right. */}

      <div className="gen-btn-row">
        <button className="gen-btn" onClick={handleGenerateClick} disabled={generating}>
          {generating ? "Generating…" : "▶  Generate TPS"}
        </button>
      </div>
    </div>
  );
}

// ─── CLOSEOUT LEFT PANEL ──────────────────────────────────────────────────────
function CloseoutPanel({ xmlData, onGenerate, generating }) {
  // Manual-entry fields — start pre-filled from the flight plan as sane
  // defaults, but stay HIDDEN until CLOSEOUT REQUEST is pressed and no
  // OOOI data is found. Pax/cargo always come from the flight plan either
  // way (OOOI only ever reports fuel + ZFW, never pax/cargo) — those two
  // fields are shown in manual mode purely so the pilot can correct them
  // if the loadsheet changed after dispatch, not because OOOI would have
  // filled them.
  const [pax, setPax]       = useState(String(xmlData.pax_count_xml));
  const [cargo, setCargo]   = useState(String(xmlData.cargo_xml));
  const [ramp, setRamp]     = useState(String(xmlData.plan_ramp_xml));
  const [cg, setCg]         = useState("25.0");
  const [zfwOverride, setZfwOverride]       = useState(false);
  const [zfwOverrideVal, setZfwOverrideVal] = useState("");

  const [phase, setPhase] = useState("idle"); // idle | checking | manual | done
  const [statusMsg, setStatusMsg] = useState(null);
  const [statusMsgErr, setStatusMsgErr] = useState(false);

  const paxN   = parseInt(pax)   || 0;
  const cargoN = parseInt(cargo) || 0;
  const rampN  = parseInt(ramp)  || 0;
  // Live preview only — matches build_weights()'s formula exactly, but the
  // authoritative ZFW/TOW/ATOW (including lap-infant count, cargo distribution,
  // and any TLR-driven adjustments) come back from the server on Generate.
  const zfw    = zfwOverride && zfwOverrideVal
    ? parseInt(zfwOverrideVal) || 0
    : xmlData.oew + paxN * xmlData.pax_weight + cargoN;
  const tow    = zfw + (rampN - xmlData.taxi_fuel);
  const atow   = tow + 2000;
  const zfwOver = zfw > xmlData.max_zfw;

  // Single entry point: CLOSEOUT REQUEST. Checks the local closeout
  // backend for OOOI data first (only meaningful when that backend is
  // actually running on the ops Mac with Dropbox/ACARS synced — see
  // CLOSEOUT_API_BASE). Found → auto-fill fuel/ZFW from OOOI, pax/cargo
  // from the flight plan, generate + save immediately, nothing shown to
  // the pilot beyond a confirmation. Not found → reveal manual fields
  // pre-filled from the flight plan so the pilot can adjust and submit.
  async function handleCloseoutRequest() {
    setPhase("checking");
    setStatusMsg(null);
    setStatusMsgErr(false);
    try {
      const oooi = await apiOooiStatus();
      if (oooi.found) {
        const oooiRamp = oooi.total_fuel_lbs != null ? String(Math.round(oooi.total_fuel_lbs)) : ramp;
        setRamp(oooiRamp);
        await submitCloseout({ pax, cargo, ramp: oooiRamp, cg, zfwOverride, zfwOverrideVal });
        const parts = [];
        if (oooi.total_fuel_lbs != null) parts.push(`fuel ${Math.round(oooi.total_fuel_lbs).toLocaleString()} lbs`);
        if (oooi.zfw_lbs != null) parts.push(`ZFW ${Math.round(oooi.zfw_lbs).toLocaleString()} lbs`);
        setStatusMsg(`✓ Closeout generated from OOOI (${parts.join(", ")}) and saved.`);
        setStatusMsgErr(false);
        setPhase("done");
      } else {
        setStatusMsg("No OOOI data found yet — enter values manually below.");
        setStatusMsgErr(false);
        setPhase("manual");
      }
    } catch (e) {
      // Local closeout backend unreachable (not running, or this device
      // isn't on the same network as the ops Mac) — fall back to manual
      // entry rather than blocking the pilot from generating a closeout.
      setStatusMsg(e instanceof ApiError ? `${e.message} Enter values manually below.` : "Could not check OOOI — enter values manually below.");
      setStatusMsgErr(true);
      setPhase("manual");
    }
  }

  async function submitCloseout(formValues) {
    await onGenerate("closeout", formValues);
  }

  async function handleManualSubmit() {
    setPhase("checking");
    try {
      await submitCloseout({ pax, cargo, ramp, cg, zfwOverride, zfwOverrideVal });
      setStatusMsg("✓ Closeout generated and saved.");
      setStatusMsgErr(false);
      setPhase("done");
    } catch (e) {
      setStatusMsg(e instanceof ApiError ? e.message : "Closeout generation failed.");
      setStatusMsgErr(true);
      setPhase("manual");
    }
  }

  if (phase === "idle" || phase === "checking" || phase === "done") {
    return (
      <div className="panel">
        <div className="srow"><div className="lbl">Closeout</div></div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
          <span className="lbl-muted" style={{ textAlign: "left" }}>
            Checks for an OOOI message automatically. If found, the closeout
            generates and saves without any manual entry. If not found,
            you'll be asked to fill in pax/cargo/fuel/CG yourself.
          </span>
          <button
            className="gen-btn"
            onClick={handleCloseoutRequest}
            disabled={phase === "checking" || generating}
          >
            {phase === "checking" ? "Checking…" : "▶  CLOSEOUT REQUEST"}
          </button>
          {statusMsg && (
            <span style={{ fontSize: 13, color: statusMsgErr ? "#c0392b" : "#578E48", whiteSpace: "pre-wrap" }}>
              {statusMsg}
            </span>
          )}
          {phase === "done" && (
            <button
              className="sheet-action-btn"
              onClick={() => { setPhase("idle"); setStatusMsg(null); }}
            >
              Request Again
            </button>
          )}
        </div>
      </div>
    );
  }

  // phase === "manual" — OOOI wasn't found (or the local backend wasn't
  // reachable), so fall back to the full manual entry form.
  return (
    <div className="panel">
      <div className="srow"><div className="lbl">Closeout — Passengers, Cargo &amp; Fuel</div></div>
      {statusMsg && (
        <div className="srow">
          <span style={{ fontSize: 12, color: statusMsgErr ? "#c0392b" : "#8e8e93" }}>{statusMsg}</span>
        </div>
      )}

      {[
        ["Passenger Count",          pax,   setPax,   "numeric"],
        ["Cargo Weight (lbs)",       cargo, setCargo, "numeric"],
        ["Planned Ramp Fuel (lbs)",  ramp,  setRamp,  "numeric"],
        ["CG % MAC",                 cg,    setCg,    "decimal"],
      ].map(([lbl, val, setter, mode]) => (
        <div key={lbl} className="srow">
          <div className="lbl">{lbl}</div>
          <input className="ios-input" value={val} onChange={e => setter(e.target.value)} inputMode={mode} />
        </div>
      ))}

      {/* Calculated ZFW */}
      <div className="srow">
        <div className="lbl">Calculated ZFW</div>
        <span className={zfwOver ? "ro-val-red" : "ro-val-green"} style={{ fontSize: 15 }}>
          {zfw.toLocaleString()} lbs{zfwOver ? "  ⚠ OVER MAX" : ""}
        </span>
      </div>

      {/* ZFW Override */}
      <div className="srow">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle checked={zfwOverride} onChange={v => { setZfwOverride(v); if (!v) setZfwOverrideVal(""); }} />
          <span className="lbl" style={{ fontSize: 13 }}>Override ZFW (manual)</span>
        </div>
        <div className="field-row">
          <span className="field-lbl-active" style={{ width: 130 }}>Override ZFW Value</span>
          <input className="ios-input" style={{ maxWidth: 110 }} value={zfwOverrideVal}
            disabled={!zfwOverride} onChange={e => setZfwOverrideVal(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      <div className="srow">
        <button
          className="gen-btn"
          onClick={handleManualSubmit}
          disabled={phase === "checking" || generating}
        >
          {phase === "checking" ? "Generating…" : "▶  Generate Closeout"}
        </button>
      </div>
    </div>
  );
}

// ─── SETTINGS SHEET ───────────────────────────────────────────────────────────
function SettingsSheet({ onClose, folderName, onPickFolder, onClearFolder, autoSave, onAutoSaveChange, folderNeedsReconnect, onReconnectFolder, closeoutEnabled, onCloseoutEnabledChange }) {
  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

  const [rwyStatus, setRwyStatus]   = useState(null);
  const [rwyStatusErr, setRwyStatusErr] = useState(null);
  const [rwyUploading, setRwyUploading] = useState(false);
  const [rwyMsg, setRwyMsg]         = useState(null);
  const [rwyMsgErr, setRwyMsgErr]   = useState(false);

  useEffect(() => {
    apiRunwayIndexStatus()
      .then(setRwyStatus)
      .catch(e => setRwyStatusErr(e instanceof ApiError ? e.message : "Could not reach the server."));
  }, []);

  async function handleFileChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-choosing the same filename later
    if (!file) return;
    setRwyUploading(true);
    setRwyMsg(null);
    setRwyMsgErr(false);
    try {
      const text = await file.text();
      const result = await apiUploadRunwayIndex(text);
      setRwyStatus({ exists: true, entry_count: result.entry_count });
      setRwyMsg(`✓ Loaded ${result.entry_count} runway entries (${result.valid_data_lines} lines). Not permanent — see note below.`);
      setRwyMsgErr(false);
    } catch (e) {
      setRwyMsg(e instanceof ApiError ? (e.message + (e.detail ? `\n${e.detail}` : "")) : "Could not reach the server.");
      setRwyMsgErr(true);
    } finally {
      setRwyUploading(false);
    }
  }
  return (
    <div className="sheet-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">Settings</div>
        <div className="sheet-section">
          <div className="sheet-row">
            <span className="sheet-row-lbl">Closeout Tab</span>
            <Toggle checked={closeoutEnabled} onChange={onCloseoutEnabledChange} />
          </div>
          <div className="sheet-row">
            <span className="sheet-hint">
              Off hides the Closeout tab from the tab bar. Turn it on when the local
              closeout backend is set up and reachable for this device.
            </span>
          </div>
        </div>
        <div className="sheet-section">
          <div className="sheet-row">
            <span className="sheet-row-lbl">Auto-save on Generate</span>
            <Toggle checked={autoSave} onChange={onAutoSaveChange} disabled={!supported || !folderName} />
          </div>
          <div className="sheet-row">
            <span className="sheet-row-lbl">Save Folder</span>
            {folderName
              ? <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div className="folder-badge">
                    <div className="folder-badge-dot" style={folderNeedsReconnect ? { background: "#c0392b" } : undefined} />
                    <span className="folder-badge-txt">{folderName}{folderNeedsReconnect ? " (disconnected)" : ""}</span>
                  </div>
                  {folderNeedsReconnect && (
                    <button className="sheet-action-btn" onClick={onReconnectFolder}>Reconnect</button>
                  )}
                  <button className="sheet-action-btn" onClick={onClearFolder}>Clear</button>
                </div>
              : <button className="sheet-action-btn" onClick={onPickFolder} disabled={!supported}
                  style={{ opacity: supported ? 1 : 0.4 }}>
                  {supported ? "Choose Folder…" : "Not supported"}
                </button>
            }
          </div>
          {folderName && !folderNeedsReconnect && (
            <div className="sheet-row">
              <span className="sheet-hint">Remembered for this SimBrief username — no need to re-pick it next time.</span>
            </div>
          )}
          {!supported && (
            <div className="sheet-row">
              <span className="sheet-hint">Requires Safari on iPadOS 16+ or Chrome/Edge on desktop. Files will download normally otherwise.</span>
            </div>
          )}
        </div>

        <div className="sheet-section">
          <div className="sheet-row">
            <span className="sheet-row-lbl">Runway Data (runway_index.dat)</span>
            <span style={{ fontSize: 13, color: "#8e8e93" }}>
              {rwyStatusErr ? "Status unknown" :
               rwyStatus === null ? "Checking…" :
               rwyStatus.exists ? `${rwyStatus.entry_count} entries loaded` : "Not loaded"}
            </span>
          </div>
          <div className="sheet-row">
            <label className="sheet-action-btn" style={{ display: "inline-block", cursor: rwyUploading ? "default" : "pointer", opacity: rwyUploading ? 0.5 : 1 }}>
              {rwyUploading ? "Uploading…" : "Upload runway_index.dat…"}
              <input
                type="file"
                accept=".dat,.txt,text/plain"
                onChange={handleFileChosen}
                disabled={rwyUploading}
                style={{ display: "none" }}
              />
            </label>
          </div>
          {rwyMsg && (
            <div className="sheet-row">
              <span className="sheet-hint" style={{ color: rwyMsgErr ? "#c0392b" : "#578E48", whiteSpace: "pre-wrap" }}>{rwyMsg}</span>
            </div>
          )}
          <div className="sheet-row">
            <span className="sheet-hint">
              Uploads apply immediately to this running server, but do NOT persist —
              the next deploy resets to whatever runway_index.dat is committed in the repo.
              For a permanent update, commit the file and redeploy.
            </span>
          </div>
        </div>

        <button className="sheet-close-btn" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  // xmlData is null until a flight plan is loaded — there's no mock fallback,
  // since generating against fabricated data would silently produce a
  // correctly-formatted but meaningless TPS/closeout.
  const [xmlData, setXmlData]       = useState(null);
  const [xmlInput, setXmlInput]     = useState("");
  const [simbriefUsername, setSimbriefUsername] = useState(
    () => localStorage.getItem("tps_simbrief_username") || ""
  );
  const [showPasteXml, setShowPasteXml] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError]   = useState(null);

  const [activeTab, setActiveTab]   = useState("tps");
  const [tpsPreview, setTpsPreview]             = useState("");
  const [tpsFilename, setTpsFilename]           = useState("");
  const [closeoutFilename, setCloseoutFilename] = useState("");
  const [tpsGenerated, setTpsGenerated]         = useState(false);
  const [closeoutGenerated, setCloseoutGenerated] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]     = useState(null);
  const [toastMsg, setToastMsg]     = useState("");
  const [toastOn, setToastOn]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fullscreenPreview, setFullscreenPreview] = useState(false);
  const [closeoutEnabled, setCloseoutEnabled] = useState(
    () => localStorage.getItem("tps_closeout_enabled") !== "false" // default ON
  );

  function handleCloseoutEnabledChange(v) {
    setCloseoutEnabled(v);
    localStorage.setItem("tps_closeout_enabled", v ? "true" : "false");
    if (!v && activeTab === "closeout") setActiveTab("tps");
  }
  const [autoSave, setAutoSave]     = useState(false);
  const [folderName, setFolderName] = useState(() => localStorage.getItem("tps_folder_name") || "");
  const [folderNeedsReconnect, setFolderNeedsReconnect] = useState(false);
  const dirHandleRef                = useRef(null);
  // iPad Safari's touch double-tap doesn't reliably fire the browser's
  // native onDoubleClick — that event is built for mouse/trackpad. This
  // does manual timing-based double-tap detection so the fullscreen
  // preview gesture actually works on the iPad, not just desktop testing.
  const lastTapRef = useRef(0);
  function handlePreviewTap() {
    const now = Date.now();
    if (now - lastTapRef.current < 350) {
      if (preview) setFullscreenPreview(true);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }


  async function handleLoadFlightplan() {
    if (!xmlInput.trim()) return;
    setLoadingPlan(true);
    setPlanError(null);
    try {
      const data = await apiFlightplan(xmlInput);
      setXmlData(data);
    } catch (e) {
      setPlanError(e instanceof ApiError ? e.message : "Could not reach the server.");
    } finally {
      setLoadingPlan(false);
    }
  }

  async function handleLoadFromSimbrief() {
    const username = simbriefUsername.trim();
    if (!username) return;
    setLoadingPlan(true);
    setPlanError(null);
    try {
      const data = await apiFlightplanBySimbrief(username);
      setXmlData(data);
      localStorage.setItem("tps_simbrief_username", username);
    } catch (e) {
      setPlanError(e instanceof ApiError ? e.message : "Could not reach the server.");
    } finally {
      setLoadingPlan(false);
    }
  }

  function showToast(msg) {
    setToastMsg(msg); setToastOn(true);
    setTimeout(() => setToastOn(false), 2500);
  }

  const handlePickFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      dirHandleRef.current = handle;
      setFolderName(handle.name);
      localStorage.setItem("tps_folder_name", handle.name);
      setAutoSave(true);
      showToast(`📁 Folder set: ${handle.name}`);
      // Remember this handle against the current SimBrief username so it
      // doesn't need to be re-picked next session — see restoreFolderHandle
      // below for the other half of this.
      const username = simbriefUsername.trim();
      if (username) {
        try { await saveFolderHandleForUser(username, handle); } catch {}
      }
    } catch (e) {
      if (e.name !== "AbortError") showToast("Could not access folder");
    }
  }, [simbriefUsername]);

  const handleClearFolder = useCallback(() => {
    dirHandleRef.current = null;
    setFolderName("");
    setAutoSave(false);
    localStorage.removeItem("tps_folder_name");
    const username = simbriefUsername.trim();
    if (username) {
      clearFolderHandleForUser(username).catch(() => {});
    }
  }, [simbriefUsername]);

  // Try to restore a remembered folder handle for a given username. Browsers
  // require a user gesture to re-request permission on a previously-granted
  // handle in some cases — so this checks silently first (query mode, no
  // prompt) and only shows a "reconnect" toast if that's not enough, rather
  // than surprising the user with a permission popup on page load.
  const restoreFolderHandle = useCallback(async (username) => {
    if (!username) return;
    let handle;
    try {
      handle = await getFolderHandleForUser(username);
    } catch {
      return;
    }
    if (!handle) return;

    try {
      const queryPerm = await handle.queryPermission({ mode: "readwrite" });
      if (queryPerm === "granted") {
        dirHandleRef.current = handle;
        setFolderName(handle.name);
        localStorage.setItem("tps_folder_name", handle.name);
        showToast(`📁 Reconnected: ${handle.name}`);
        return;
      }
    } catch {
      return; // handle no longer usable (e.g. folder deleted) — ignore
    }

    // Permission needs re-confirming. Store the handle for a manual
    // "Reconnect Folder" action in Settings rather than prompting
    // unsolicited — see the folderNeedsReconnect flag used in SettingsSheet.
    dirHandleRef.current = handle;
    setFolderName(handle.name);
    setFolderNeedsReconnect(true);
  }, []);

  // Attempt to restore a remembered folder for this username once, whenever
  // the username changes (covers both: returning with a saved username
  // already in localStorage on first render, and right after picking a
  // flight plan by a freshly-typed username).
  useEffect(() => {
    const username = simbriefUsername.trim();
    if (username) restoreFolderHandle(username);
  }, [simbriefUsername, restoreFolderHandle]);

  const handleReconnectFolder = useCallback(async () => {
    if (!dirHandleRef.current) return;
    try {
      const perm = await dirHandleRef.current.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        setFolderNeedsReconnect(false);
        setAutoSave(true);
        showToast(`📁 Reconnected: ${folderName}`);
      } else {
        showToast("Permission denied");
      }
    } catch {
      showToast("Could not reconnect folder");
    }
  }, [folderName]);

  async function saveFile(content, filename) {
    if (autoSave && dirHandleRef.current) {
      try {
        const fh = await dirHandleRef.current.getFileHandle(filename, { create: true });
        const w  = await fh.createWritable();
        await w.write(content); await w.close();
        showToast(`✓ Saved → ${folderName}/${filename}`);
        return;
      } catch {
        try {
          const perm = await dirHandleRef.current.requestPermission({ mode: "readwrite" });
          if (perm === "granted") { await saveFile(content, filename); return; }
        } catch {}
        showToast("⚠ Folder access lost — downloaded instead");
      }
    }
    forceDownloadTxt(content, filename);
    if (!autoSave) showToast("⬇ Downloaded");
  }

  async function handleGenerate(type, formValues) {
    setGenerating(true);
    setGenError(null);
    try {
      if (type === "tps") {
        const result = await apiGenerateTps({ xml_data: xmlData, mode: "tps", ...formValues });
        if (result.tps) {
          setTpsPreview(result.tps.content);
          setTpsFilename(result.tps.filename);
          setTpsGenerated(true);
          // Auto-save to a chosen folder is an explicit opt-in (autoSave
          // toggle, File System Access API) — that still fires here. A plain
          // browser download does NOT fire here; it only fires when the user
          // presses the Download button (handleManualDownload below), after
          // reviewing the preview.
          if (autoSave && dirHandleRef.current) {
            await saveFile(result.tps.content, result.tps.filename);
          }
        }
      } else {
        // Closeout hits the LOCAL backend (CLOSEOUT_API_BASE), which runs
        // directly on the ops Mac with real filesystem access — it writes
        // the closeout straight to OUTPUT_DIR (configured to be the ACARS
        // print-watch folder) itself. There is nothing for the browser to
        // download or save here; the file already landed where it needs to
        // be the moment this call succeeds. This is what makes "generate
        // and save to a folder for printing, without showing the file"
        // actually possible — a cloud server (Railway) could never write to
        // that folder, only a process running on the same Mac can.
        const result = await apiGenerateCloseout({ xml_data: xmlData, mode: "closeout", ...formValues });
        if (result.closeout) {
          setCloseoutFilename(result.closeout.filename);
          setCloseoutGenerated(true);
        }
      }
    } catch (e) {
      setGenError(e instanceof ApiError ? e.message : "Could not reach the server.");
      showToast("⚠ Generation failed");
      throw e; // let CloseoutPanel's CLOSEOUT REQUEST flow react (fall back to manual entry)
    } finally {
      setGenerating(false);
    }
  }

  function handleManualDownload() {
    if (!tpsPreview) return;
    forceDownloadTxt(tpsPreview, tpsFilename);
    showToast("⬇ Downloaded");
  }

  const preview   = tpsPreview;
  const generated = activeTab === "tps" ? tpsGenerated : closeoutGenerated;

  // ── No flight plan loaded yet: show the input screen instead of the panels ──
  if (!xmlData) {
    return (
      <>
        <style>{css}</style>
        <div className="shell">
          <div className="card">
            <div className="title-bar">
              <h1>Takeoff Performance System — Load Flight Plan</h1>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
              <span className="lbl-muted" style={{ textAlign: "left" }}>
                Enter your SimBrief username to pull your latest OFP.
              </span>
              <input
                type="text"
                value={simbriefUsername}
                onChange={e => setSimbriefUsername(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleLoadFromSimbrief(); }}
                placeholder="SimBrief username"
                autoCapitalize="off"
                autoCorrect="off"
                style={{
                  fontFamily: '"SF Mono","Courier New",monospace',
                  fontSize: 14, padding: 10, borderRadius: 10, border: "1px solid #d0d0d5",
                }}
              />
              {planError && (
                <span style={{ fontSize: 13, color: "#c0392b" }}>{planError}</span>
              )}
              <button
                className="gen-btn"
                onClick={handleLoadFromSimbrief}
                disabled={loadingPlan || !simbriefUsername.trim()}
                style={{ alignSelf: "flex-start" }}
              >
                {loadingPlan ? "Loading…" : "▶  Load Flight Plan"}
              </button>

              <button
                onClick={() => setShowPasteXml(v => !v)}
                style={{
                  alignSelf: "flex-start", background: "none", border: "none",
                  color: "#578E48", fontSize: 12, cursor: "pointer", padding: 0, marginTop: 8,
                }}
              >
                {showPasteXml ? "▲ Hide manual XML paste" : "Paste raw XML instead ▾"}
              </button>

              {showPasteXml && (
                <>
                  <textarea
                    value={xmlInput}
                    onChange={e => setXmlInput(e.target.value)}
                    placeholder="<OFP>...</OFP>"
                    style={{
                      flex: 1, minHeight: 120, fontFamily: '"SF Mono","Courier New",monospace',
                      fontSize: 12, padding: 10, borderRadius: 10, border: "1px solid #d0d0d5",
                      resize: "none",
                    }}
                  />
                  <button
                    className="gen-btn"
                    onClick={handleLoadFlightplan}
                    disabled={loadingPlan || !xmlInput.trim()}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {loadingPlan ? "Loading…" : "▶  Load From Pasted XML"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{css}</style>
      <div className="shell">
        <div className="card">

          {/* TITLE BAR */}
          <div className="title-bar">
            <h1>{xmlData.AC_name} Takeoff Performance System — FLT {xmlData.flight_number} {xmlData.origin_iata}→{xmlData.dest_iata}</h1>
            <button className="title-settings-btn" onClick={() => setShowSettings(true)}>⚙︎</button>
          </div>

          {/* FOLDER BADGE */}
          {folderName && (
            <div style={{ display: "flex", justifyContent: "center", padding: "2px 0 3px", background: "#E4E3EA" }}>
              <div className="folder-badge">
                <div className="folder-badge-dot" />
                <span className="folder-badge-txt">Auto-save → {folderName}</span>
              </div>
            </div>
          )}

          {/* PANELS */}
          <div className="panels">
            {activeTab === "tps"
              ? <TpsPanel      xmlData={xmlData} onGenerate={handleGenerate} generating={generating} />
              : <CloseoutPanel xmlData={xmlData} onGenerate={handleGenerate} generating={generating} />
            }
            {activeTab === "tps" && (
              <div
                className="preview-panel"
                onDoubleClick={() => preview && setFullscreenPreview(true)}
                onTouchEnd={handlePreviewTap}
                style={{ cursor: preview ? "zoom-in" : "default" }}
              >
                {genError && (
                  <div style={{ color: "#c0392b", marginBottom: 8, whiteSpace: "pre-wrap" }}>{genError}</div>
                )}
                {preview || "Nothing generated yet — fill in the panel on the left and press Generate."}
              </div>
            )}
          </div>

          {fullscreenPreview && (
            <div className="fullscreen-preview-backdrop" onDoubleClick={() => setFullscreenPreview(false)}>
              <div className="fullscreen-preview-frame">
                <div className="fullscreen-preview-text">{preview}</div>
                <button className="fullscreen-preview-close" onClick={() => setFullscreenPreview(false)}>✕ Close</button>
              </div>
            </div>
          )}

          {/* BOTTOM BAR */}
          <div className="bottom-bar">
            <button className="bot-btn" onClick={() => {
              if (activeTab === "tps") { setTpsPreview(""); setTpsGenerated(false); }
              else { setCloseoutGenerated(false); }
              setGenError(null);
            }}>Reset</button>
            <div className="bot-type">{xmlData.AC_name}</div>
            {activeTab === "tps" && generated
              ? <button className="bot-btn" onClick={handleManualDownload}>Download</button>
              : <span style={{ fontSize: 14, color: "#8e8e93" }}>Audit</span>
            }
          </div>
        </div>

        {/* TAB BAR */}
        <div className="tab-bar">
          {[
            { id: "tps",      label: "Normal"   },
            { id: "closeout", label: "Closeout" },
          ].filter(t => t.id !== "closeout" || closeoutEnabled).map(({ id, label }) => (
            <button key={id} className="tab" onClick={() => setActiveTab(id)}>
              <span className={`tab-lbl${activeTab === id ? " on" : ""}`}>{label}</span>
              {activeTab === id && <div className="tab-bar-indicator" />}
            </button>
          ))}
        </div>
      </div>

      <div className="toast" style={{ opacity: toastOn ? 1 : 0 }}>{toastMsg}</div>

      {showSettings && (
        <SettingsSheet
          onClose={() => setShowSettings(false)}
          folderName={folderName}
          onPickFolder={handlePickFolder}
          onClearFolder={handleClearFolder}
          autoSave={autoSave}
          onAutoSaveChange={setAutoSave}
          folderNeedsReconnect={folderNeedsReconnect}
          onReconnectFolder={handleReconnectFolder}
          simbriefUsername={simbriefUsername}
          dirHandleRef={dirHandleRef}
          closeoutEnabled={closeoutEnabled}
          onCloseoutEnabledChange={handleCloseoutEnabledChange}
        />
      )}
    </>
  );
}
