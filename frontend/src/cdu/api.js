// ─── CDU API CLIENT ─────────────────────────────────────────────────────────
// Talks to the SAME Flask backend (backend/app.py) as the classic panel UI
// (see ../App.jsx) — nothing on the backend changes for the CDU frontend.
// Deliberately duplicated rather than imported from App.jsx so the classic
// UI can't be broken by CDU-side changes (App.jsx keeps its own copies).
//
// Only the TPS side of the API is wired here (flightplan + generate). The
// Closeout flow depends on a local-network-only backend running on the ops
// Mac (see CLOSEOUT_API_BASE in App.jsx) and doesn't fit the CDU's simple
// keypad interaction model well — it isn't included in this pass.

export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";

export class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

export async function apiFlightplan(rawXml) {
  const res = await fetch(`${API_BASE}/api/flightplan`, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: rawXml,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to parse flight plan.", data.detail);
  return data;
}

export async function apiFlightplanBySimbrief(username) {
  const res = await fetch(`${API_BASE}/api/flightplan/simbrief`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Failed to fetch flight plan from SimBrief.", data.detail);
  return data;
}

// Fallback runway data for a DIVERSION airport — see backend/runway_index.py.
// The figures are less authoritative than the OFP's own landing block:
// `length_ft` is runway LENGTH (no displaced thresholds in the source, so it
// can overstate LDA) and no slope is provided. Flagged `source: "INDEX"`.
export async function apiRunways(icao) {
  const res = await fetch(`${API_BASE}/api/runways/${encodeURIComponent(icao)}`);
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "No runway data for that airport.", data.detail);
  return data;
}

export async function apiGenerateTps(payload) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Generation failed.", data.detail);
  return data;
}

// Forces a real download rather than an inline preview — same technique
// App.jsx uses (application/octet-stream, not text/plain, so Safari/iOS
// don't just open the blob in a new tab instead of saving it).
export function forceDownloadTxt(content, filename) {
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "output.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
