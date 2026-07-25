import { useState, useRef, useCallback } from "react";

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
  .gen-btn { background: #578E48; color: #fff; border: none; border-radius: 9px; font-size: 14px; font-weight: 600; font-family: inherit; padding: 9px 22px; cursor: pointer; }
  .gen-btn:active { opacity: 0.85; }
  .sec-btn { background: none; border: 1px solid rgba(0,0,0,0.18); border-radius: 9px; font-size: 13px; font-family: inherit; padding: 8px 14px; cursor: pointer; color: #007aff; }
  .sec-btn:active { background: rgba(0,0,0,0.05); }
  .gen-btn-row { display: flex; gap: 8px; align-items: center; padding: 10px 0 2px; justify-content: center; }
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
// Set VITE_API_BASE at build time (e.g. in Railway's frontend service env vars)
// to point at the deployed backend. Falls back to localhost for local dev.
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";

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

async function apiGenerate(payload) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Generation failed.", data.detail);
  return data;
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
  const [runway, setRunway]                 = useState(xmlData.plan_rwy);
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
  const [pax, setPax]       = useState(String(xmlData.pax_count_xml));
  const [cargo, setCargo]   = useState(String(xmlData.cargo_xml));
  const [ramp, setRamp]     = useState(String(xmlData.plan_ramp_xml));
  const [cg, setCg]         = useState("25.0");
  const [zfwOverride, setZfwOverride]       = useState(false);
  const [zfwOverrideVal, setZfwOverrideVal] = useState("");
  const [oooi, setOooi]     = useState(false);

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
  const ptowK  = (tow  / 1000).toFixed(1);
  const atowK  = (atow / 1000).toFixed(1);
  const zfwK   = (zfw  / 1000).toFixed(1);
  const fuelK  = ((rampN - xmlData.taxi_fuel) / 1000).toFixed(1);

  function handleGenerateClick() {
    onGenerate("closeout", {
      pax, cargo, ramp, cg, zfwOverride, zfwOverrideVal, oooi,
    });
  }

  return (
    <div className="panel">
      <div className="srow"><div className="lbl">Closeout — Passengers, Cargo &amp; Fuel</div></div>

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

      {/* OOOI */}
      <div className="srow">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle checked={oooi} onChange={setOooi} />
          <span className="lbl" style={{ fontSize: 12, textAlign: "left" }}>Auto-fill from OOOI log</span>
        </div>
        {oooi && (
          <div style={{ width: "100%", paddingTop: 4 }}>
            <span className="lbl-muted" style={{ fontSize: 11, textAlign: "left", display: "block" }}>
              OOOI auto-fill reads oooi_log.txt from a local Dropbox path on the
              original desktop app — that file isn't reachable from this server.
              Enter fuel and CG manually for now.
            </span>
          </div>
        )}
      </div>

      {/* Computed summary — muted */}
      <div className="srow">
        <div className="lbl-muted">Weight Summary</div>
        <div style={{ width: "100%" }}>
          {[["PTOW (klbs)", ptowK], ["ATOW (klbs)", atowK], ["ZFW  (klbs)", zfwK], ["Fuel (klbs)", `${fuelK}P`]].map(([l, v]) => (
            <div key={l} className="field-row">
              <span className="field-lbl-muted">{l}</span>
              <span className="ro-val-muted">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="gen-btn-row">
        <button className="gen-btn" onClick={handleGenerateClick} disabled={generating}>
          {generating ? "Generating…" : "▶  Generate Closeout"}
        </button>
      </div>
    </div>
  );
}

// ─── SETTINGS SHEET ───────────────────────────────────────────────────────────
function SettingsSheet({ onClose, folderName, onPickFolder, onClearFolder, autoSave, onAutoSaveChange }) {
  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;
  return (
    <div className="sheet-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">Settings</div>
        <div className="sheet-section">
          <div className="sheet-row">
            <span className="sheet-row-lbl">Auto-save on Generate</span>
            <Toggle checked={autoSave} onChange={onAutoSaveChange} disabled={!supported || !folderName} />
          </div>
          <div className="sheet-row">
            <span className="sheet-row-lbl">Save Folder</span>
            {folderName
              ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="folder-badge">
                    <div className="folder-badge-dot" />
                    <span className="folder-badge-txt">{folderName}</span>
                  </div>
                  <button className="sheet-action-btn" onClick={onClearFolder}>Clear</button>
                </div>
              : <button className="sheet-action-btn" onClick={onPickFolder} disabled={!supported}
                  style={{ opacity: supported ? 1 : 0.4 }}>
                  {supported ? "Choose Folder…" : "Not supported"}
                </button>
            }
          </div>
          {!supported && (
            <div className="sheet-row">
              <span className="sheet-hint">Requires Safari on iPadOS 16+ or Chrome/Edge on desktop. Files will download normally otherwise.</span>
            </div>
          )}
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
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError]   = useState(null);

  const [activeTab, setActiveTab]   = useState("tps");
  const [tpsPreview, setTpsPreview]             = useState("");
  const [closeoutPreview, setCloseoutPreview]   = useState("");
  const [tpsFilename, setTpsFilename]           = useState("");
  const [closeoutFilename, setCloseoutFilename] = useState("");
  const [tpsGenerated, setTpsGenerated]         = useState(false);
  const [closeoutGenerated, setCloseoutGenerated] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]     = useState(null);
  const [toastMsg, setToastMsg]     = useState("");
  const [toastOn, setToastOn]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [autoSave, setAutoSave]     = useState(false);
  const [folderName, setFolderName] = useState(() => localStorage.getItem("tps_folder_name") || "");
  const dirHandleRef                = useRef(null);

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
    } catch (e) {
      if (e.name !== "AbortError") showToast("Could not access folder");
    }
  }, []);

  const handleClearFolder = useCallback(() => {
    dirHandleRef.current = null;
    setFolderName("");
    setAutoSave(false);
    localStorage.removeItem("tps_folder_name");
  }, []);

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
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    if (!autoSave) showToast("⬇ Downloaded");
  }

  async function handleGenerate(type, formValues) {
    setGenerating(true);
    setGenError(null);
    try {
      const result = await apiGenerate({ xml_data: xmlData, mode: type, ...formValues });

      if (result.tps) {
        setTpsPreview(result.tps.content);
        setTpsFilename(result.tps.filename);
        setTpsGenerated(true);
        await saveFile(result.tps.content, result.tps.filename);
      }
      if (result.closeout) {
        setCloseoutPreview(result.closeout.content);
        setCloseoutFilename(result.closeout.filename);
        setCloseoutGenerated(true);
        await saveFile(result.closeout.content, result.closeout.filename);
      }
    } catch (e) {
      setGenError(e instanceof ApiError ? e.message : "Could not reach the server.");
      showToast("⚠ Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  function handleManualDownload() {
    const isTps    = activeTab === "tps";
    const content  = isTps ? tpsPreview : closeoutPreview;
    const filename = isTps ? tpsFilename : closeoutFilename;
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename || "output.txt"; a.click();
  }

  const preview   = activeTab === "tps" ? tpsPreview : closeoutPreview;
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
                Paste the raw SimBrief XML for this flight below.
              </span>
              <textarea
                value={xmlInput}
                onChange={e => setXmlInput(e.target.value)}
                placeholder="<OFP>...</OFP>"
                style={{
                  flex: 1, minHeight: 0, fontFamily: '"SF Mono","Courier New",monospace',
                  fontSize: 12, padding: 10, borderRadius: 10, border: "1px solid #d0d0d5",
                  resize: "none",
                }}
              />
              {planError && (
                <span style={{ fontSize: 13, color: "#c0392b" }}>{planError}</span>
              )}
              <button
                className="gen-btn"
                onClick={handleLoadFlightplan}
                disabled={loadingPlan || !xmlInput.trim()}
                style={{ alignSelf: "flex-start" }}
              >
                {loadingPlan ? "Loading…" : "▶  Load Flight Plan"}
              </button>
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
            <div className="preview-panel">
              {genError && (
                <div style={{ color: "#c0392b", marginBottom: 8, whiteSpace: "pre-wrap" }}>{genError}</div>
              )}
              {preview || "Nothing generated yet — fill in the panel on the left and press Generate."}
            </div>
          </div>

          {/* BOTTOM BAR */}
          <div className="bottom-bar">
            <button className="bot-btn" onClick={() => {
              if (activeTab === "tps") { setTpsPreview(""); setTpsGenerated(false); }
              else { setCloseoutPreview(""); setCloseoutGenerated(false); }
              setGenError(null);
            }}>Reset</button>
            <div className="bot-type">{xmlData.AC_name}</div>
            {generated
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
          ].map(({ id, label }) => (
            <button key={id} className="tab" onClick={() => setActiveTab(id)}>
              <PlaneIcon active={activeTab === id} />
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
        />
      )}
    </>
  );
}
