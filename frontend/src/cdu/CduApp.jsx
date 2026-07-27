import { useState, useCallback } from "react";
import CduEmulator, { DELETE_TOKEN } from "./CduEmulator.jsx";
import { apiFlightplanBySimbrief, apiGenerateTps, forceDownloadTxt, ApiError } from "./api.js";

// ─── PWB: STANDALONE MCDU EMULATOR ──────────────────────────────────────────
// Real backend, real data — every value on screen comes from this repo's own
// backend/app.py (/api/flightplan/simbrief and /api/generate routes). Nothing
// here is mocked. PWB runs independently of the TPS repo — separate backend,
// separate deploy, no shared runtime code (App.jsx / Root.jsx from the
// original TPS-derived copy are unused leftovers here and can be deleted).
//
// The backend generates AERODATA.py's original single-file COMBINED output
// (generate_combined_output — ACARS-style TAKEOFF DATA + loadsheet summary
// in one printout), not the later TPS-app's split generate_tps()/
// generate_closeout(). See backend/takeoff_perf_core.py.
//
// Page flow and field layout are confirmed against real E-Jet cockpit
// footage of the Honeywell Primus Epic MCDU running this exact software
// (highest-fidelity source — takes precedence over the ERJ-170 POH excerpt
// and the printed COMBINED.txt sample where they disagree on wording):
// Real navigation tree (POH ch.9 sec.16 p.9-59 "ACARS Navigation Windows",
// with page contents from cockpit footage where the two disagree):
//
//   MENU  --DLK-->  ACARS MAIN MENU  --PERFORMANCE>-->  ACARS RWY PERF/W&B
//                          |                                  |
//                     <PRE FLT                    <CONDITIONS / <LOADSHEET
//                          |                            / <RWY DATA
//                   ACARS INITIALIZE
//
// Menu items belonging to ACARS applications this app doesn't implement
// (ENROUTE, POST FLT, ATC/ATS/SYS MENU, MISC, MSG LOG, REPORTS, REQUESTS,
// and both LANDING pages) are drawn greyed-out rather than omitted, so each
// page still matches the real screen line-for-line and it's obvious what
// exists versus what's wired up.
//
//   MENU                 — real top-level MENU page (matches a live WebFMC
//                          screenshot exactly: ◂MISC/◂BKUP RADIO/MCDU
//                          MAINT▸/MCDU STAT▸, none implemented). Starting
//                          page; DLK opens the ACARS MAIN MENU.
//   ACARS MAIN MENU      — <PRE FLT and PERFORMANCE> are live
//   ACARS RWY PERF/W&B   — TAKEOFF <CONDITIONS, W&B <LOADSHEET, TAKEOFF
//                          <RWY DATA; LANDING pages greyed out
//   ACARS LOADSHEET      — AD/CH A/B/C, BAG/WT FWD/AFT, TTL FA/ACM, CLOSET,
//                          T/O FUEL, BLST FUEL. Pre-filled from the OFP but
//                          fully editable; entries override the OFP's
//                          pax/cargo/fuel on the next send, same as the real
//                          system (where the loadsheet supersedes PTOW).
//   ACARS INITIALIZE     — enter a SimBrief username, fetch + parse the OFP
//   ACARS TO CONDITIONS 1/2 — KLAX RWY 1/2/3 (departure ICAO + slot; a bare
//                          runway id, or "RWY/INTXN" for an intersection
//                          takeoff — up to 3 requested runways at once),
//                          SURFACE, LEVEL, WIND, OAT C/QNH, PTOW, plus the
//                          W&B LOADSHEET> / T/O DATA> shortcuts and
//                          DATALINK SEND* (POH p.9-70)
//   ACARS TO CONDITIONS 2/2 — ANTI-ICE (AUTO/ON), FLAPS (OPTIMUM/1/2/4),
//                          THRUST (OPTIMUM/MAX), LLWS ADVISORY (NO/YES,
//                          informational only) — DLK/EXEC sends the
//                          request, same as the real DATALINK SEND* key
//   ACARS T/O RWY DATA   — loadsheet summary (FLT/RLS/SECT A/B/C/GTOW-CG/
//                          ZFW-CG/FOB/TOT PAX), REMARKS, then one TAKEOFF
//                          PERFORMANCE page per requested runway
// The generated .txt is downloadable via the FPL key; it is deliberately NOT
// a browsable page — real CDUs don't display a raw report dump.
//
// Known simplifications vs. the real system:
//   - No raw-XML paste fallback — SimBrief username only.
//   - No separate ACARS LOADSHEET request — the backend returns loadsheet
//     summary + takeoff performance together in one call, so there's no
//     standalone "W&B LOADSHEET>" shortcut page.
//   - PTOW is cosmetic only (not sent to the backend) — the real system
//     discards it too once real loadsheet data exists, which ours always has.
//   - No contamination depth (LEVEL 1/2/3) for SURFACE — the backend's TLR
//     interpolation only has DRY/WET tables, not compacted-snow/wet-ice.
//   - ANTI-ICE only has AUTO/ON (not AUTO/ON/OFF) and THRUST only has
//     OPTIMUM/MAX — the backend's anti-ice and thrust-mode flags are each
//     a single boolean, so a 3rd state wouldn't do anything different.
//   - LLWS ADVISORY is UI-only — it's an informational flag on the real
//     system too and never affects the computed takeoff numbers.
//   - No Closeout tab — that flow depends on a LOCAL backend running on the
//     ops Mac and doesn't map onto the keypad-driven commit model well.

const SCENARIO_DEFS = [
  { key: "DRY_PTOW", surface: "DRY", cond: "PTOW", label: "DRY" },
  { key: "WET_PTOW", surface: "WET", cond: "PTOW", label: "WET" },
];

function tlrAvail(xmlData, surface, cond) {
  return !!(xmlData?.tlr_tables?.[surface]?.[cond]);
}

// Real ACARS SURFACE field: PLANNED (no override — use computed/XML
// defaults) plus whichever of DRY/WET this flight plan has TLR data for.
function availableSurfaces(xmlData) {
  return ["PLANNED", ...SCENARIO_DEFS.filter(d => tlrAvail(xmlData, d.surface, d.cond)).map(d => d.key)];
}

const SURFACE_LABELS = { PLANNED: "PLANNED", ...Object.fromEntries(SCENARIO_DEFS.map(d => [d.key, d.label])) };
const SURFACE_SHORTHAND = { PLANNED: "PLANNED", DRY: "DRY_PTOW", WET: "WET_PTOW" };

const LINES_PER_PRINT_PAGE = 11;

export default function CduApp() {
  // MENU | ACARSMENU | PERFWB | LOADSHEET | IDENT | COND1 | COND2 | ACARS | PRINT
  const [page, setPage] = useState("MENU");
  const [acarsPageIndex, setAcarsPageIndex] = useState(0); // 0=summary 1=remarks 2..=perf per runway

  const [xmlData, setXmlData] = useState(null);
  const [simbriefUsername, setSimbriefUsername] = useState(
    () => localStorage.getItem("tps_simbrief_username") || ""
  );
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [identStatus, setIdentStatus] = useState("ENTER SIMBRIEF ID");
  const [identStatusErr, setIdentStatusErr] = useState(false);

  // ACARS TO CONDITIONS 1/2 — RWY 1/2/3, SURFACE, WIND, OAT/QNH, PTOW
  const [runway1, setRunway1] = useState("");
  const [runway2, setRunway2] = useState("");
  const [runway3, setRunway3] = useState("");
  const [surface, setSurface] = useState("PLANNED");
  const [oat, setOat] = useState("");
  const [qnh, setQnh] = useState("");
  const [wind, setWind] = useState("");
  // No GUST field — the real page has none (POH p.9-71: gust is typed into
  // WIND itself, and only for a tailwind).
  //
  // REL VERSION is the dispatch release number the crew reads off the paper
  // release. AeroData refuses to compute against a stale release, so this is
  // checked against the release in the SimBrief OFP (xml_data.RLS) and a
  // mismatch blocks the send rather than silently producing numbers for the
  // wrong plan.
  const [relVersion, setRelVersion] = useState("");
  const [ptow, setPtow] = useState(""); // cosmetic only — real system discards this once real loadsheet data exists, which ours always has

  // ACARS TO CONDITIONS 2/2 — ANTI-ICE, FLAPS, THRUST, LLWS ADVISORY
  const [flapSel, setFlapSel] = useState("OPTIMUM"); // OPTIMUM | 1 | 2 | 4
  const [antiIce, setAntiIce] = useState(false); // AUTO | ON
  const [forceMax, setForceMax] = useState(false); // OPTIMUM (flex) | MAX
  const [llwsAdvisory, setLlwsAdvisory] = useState(false); // NO | YES — advisory only, not sent to the backend

  const [generating, setGenerating] = useState(false);
  const [perfStatus, setPerfStatus] = useState("");
  const [perfStatusErr, setPerfStatusErr] = useState(false);

  const [tpsResult, setTpsResult] = useState(null); // { content, filename, atow, runway_results, loadsheet_summary }
  const [printPageIndex, setPrintPageIndex] = useState(0);
  const [resetArmed, setResetArmed] = useState(false); // ACARS RESET confirm latch

  // ACARS LOADSHEET (ERJ-170 POH ch.9 sec.16 p.9-73/74) — "AD/CH" is
  // adults/children per cabin section, "BAG/WT" is bag count / freight
  // weight per hold. Stored as raw "a/b" strings exactly as typed, and
  // only parsed when building the request payload.
  const [adChA, setAdChA] = useState("");
  const [adChB, setAdChB] = useState("");
  const [adChC, setAdChC] = useState("");
  const [bagFwd, setBagFwd] = useState("");
  const [bagAft, setBagAft] = useState("");
  const [faAcm, setFaAcm] = useState("2/0");  // POH default: 2 F/A, 0 ACM
  const [closet, setCloset] = useState("65"); // POH default: 65 lb
  const [toFuel, setToFuel] = useState("");
  const [blstFuel, setBlstFuel] = useState("");
  // ACARS LOADSHEET 2/2 — the POH's "PAX DETAIL" page (p.9-75): per-section
  // EXTRA or TOTAL passenger weight, used for charter ops where actual
  // weights are required. CG lives here too: the backend needs a CG% to
  // compute weight & balance and there's nowhere else in this page set to
  // type one (the real system gets it from the host, we don't).
  const [paxWtA, setPaxWtA] = useState("");
  const [paxWtB, setPaxWtB] = useState("");
  const [paxWtC, setPaxWtC] = useState("");
  const [cgPercent, setCgPercent] = useState("25.0");

  // ── Data helpers ──────────────────────────────────────────────────────────
  const runwayIds = xmlData?.valid_runways?.map(r => r.id) ?? [];
  const surfaceChoices = availableSurfaces(xmlData);
  const conditionsEdited = !!xmlData && (oat !== xmlData.temp || qnh !== xmlData.qnh || wind !== xmlData.wind);
  // Authoritative post-EXEC results — one entry per requested runway, matches
  // the {airport,runway,length,v1,vr,v2,vfs,flex,flaps,trim_stab,mrtw,mtow,
  // gtow_cg,acc_alt,...} shape computed server-side by generate_combined_output().
  const runwayResults = tpsResult?.runway_results ?? [];
  // Authentic ACARS T/O RWY DATA loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH,
  // SECT A/B/C, GTOW/CG, ZFW/CG, FOB, TOT PAX, REMARKS) — field names and
  // groupings confirmed against a live-generated COMBINED.txt sample.
  const loadsheetSummary = tpsResult?.loadsheet_summary ?? null;
  // Dispatch release number straight off the SimBrief OFP — REL VERSION on
  // the conditions page must match this before anything can be sent.
  const ofpRelease = xmlData?.RLS ?? "";
  const relOk = !!relVersion && relVersion === String(ofpRelease);

  // ── MENU page — the app's starting page, matches the real Honeywell/
  // WebFMC top-level MENU screen exactly: ◂MISC and ◂BKUP RADIO on the
  // left (rows 1 and 5), MCDU MAINT▸ and MCDU STAT▸ on the right (rows 5
  // and 6). None of those four are implemented (they're not part of the
  // ACARS takeoff workflow this app covers) so their LSKs just report
  // NOT AVAIL, same convention as the unimplemented function keys. The
  // real way into the ACARS app from here is the DLK (datalink) key.
  // ACARS RESET — clears the whole session (flight plan, conditions,
  // loadsheet, results) back to a cold start. Destructive, so it's two-press:
  // the first press arms it and the line changes to CONFIRM RESET*, the
  // second carries it out. Anything else navigating away disarms it.
  function resetAll() {
    setXmlData(null);
    // Wipe the SimBrief ID too, including the persisted copy — otherwise a
    // "reset" unit still comes up pre-filled with the last crew's username.
    setSimbriefUsername("");
    try { localStorage.removeItem("tps_simbrief_username"); } catch { /* private mode */ }
    setRunway1(""); setRunway2(""); setRunway3("");
    setSurface("PLANNED");
    setOat(""); setQnh(""); setWind(""); setPtow(""); setRelVersion("");
    setFlapSel("OPTIMUM"); setAntiIce(false); setForceMax(false); setLlwsAdvisory(false);
    setAdChA(""); setAdChB(""); setAdChC(""); setBagFwd(""); setBagAft("");
    setFaAcm("2/0"); setCloset("65"); setToFuel(""); setBlstFuel("");
    setPaxWtA(""); setPaxWtB(""); setPaxWtC(""); setCgPercent("25.0");
    setTpsResult(null); setAcarsPageIndex(0); setPrintPageIndex(0);
    setPerfStatus(""); setPerfStatusErr(false);
    setIdentStatus("ENTER SIMBRIEF ID"); setIdentStatusErr(false);
    setResetArmed(false);
  }

  function handleMenuCommit(key) {
    if (key !== "acarsreset") return; // every other MENU item is dim
    if (!resetArmed) {
      setResetArmed(true);
      return { error: "CONFIRM ACARS RESET" };
    }
    resetAll();
    return { error: "ACARS RESET COMPLETE" };
  }

  const menuFields = [
    { key: "misc",      label: "", value: "◂MISC",        side: "L", dim: true, dimLabel: "MISC" },
    { key: "_blank1",   label: "", value: "",              side: "L", editable: false },
    { key: "_blank2",   label: "", value: "",              side: "L", editable: false },
    { key: "_blank3",   label: "", value: "",              side: "L", editable: false },
    { key: "bkupradio", label: "", value: "◂BKUP RADIO",   side: "L", dim: true, dimLabel: "BKUP RADIO" },
    { key: "_blank4",   label: "", value: "",              side: "R", editable: false },
    { key: "_blank5",   label: "", value: "",              side: "R", editable: false },
    { key: "_blank6",   label: "", value: "",              side: "R", editable: false },
    { key: "acarsreset",label: "", value: resetArmed ? "CONFIRM RESET*" : "ACARS RESET>",
      side: "R", editable: true, selectable: true, tone: resetArmed ? undefined : "white", error: resetArmed },
    { key: "mcdumaint", label: "", value: "MCDU MAINT▸",   side: "R", dim: true, dimLabel: "MCDU MAINT" },
    { key: "mcdustat",  label: "", value: "MCDU STAT▸",    side: "R", dim: true, dimLabel: "MCDU STAT" },
  ];

  // ── ACARS MAIN MENU ────────────────────────────────────────────────────────
  // Line-for-line from real E-Jet cockpit footage of this exact software.
  // (The POH's p.9-60 diagram shows an older variant — <IN FLT/<FREE TEXT/
  // <FLT TIMES with PERF/W&B at 4R — so the footage wins, per the same rule
  // used everywhere else here.) Only <PRE FLT and PERFORMANCE> are wired:
  // everything else is a different ACARS application this app doesn't cover,
  // so it's drawn greyed-out rather than omitted, keeping the page honest.
  function handleAcarsMenuCommit(key) {
    if (key === "preflt") { setPage("IDENT"); return; }
    if (key === "perf")   { setPage(xmlData ? "PERFWB" : "IDENT"); return; }
  }

  const acarsMenuFields = [
    { key: "preflt",  label: "", value: "<PRE FLT",     side: "L", editable: true, selectable: true, tone: "white" },
    { key: "enroute", label: "", value: "<ENROUTE",     side: "L", dim: true, dimLabel: "ENROUTE" },
    { key: "postflt", label: "", value: "<POST FLT",    side: "L", dim: true, dimLabel: "POST FLT" },
    { key: "atc",     label: "", value: "<ATC MENU",    side: "L", dim: true, dimLabel: "ATC MENU" },
    { key: "ats",     label: "", value: "<ATS MENU",    side: "L", dim: true, dimLabel: "ATS MENU" },
    { key: "sys",     label: "", value: "<SYS MENU",    side: "L", dim: true, dimLabel: "SYS MENU" },
    { key: "_r1",     label: "", value: "",              side: "R", editable: false },
    { key: "misc2",   label: "", value: "MISC>",         side: "R", dim: true, dimLabel: "MISC" },
    { key: "msglog",  label: "", value: "MSG LOG>",      side: "R", dim: true, dimLabel: "MSG LOG" },
    { key: "reports", label: "", value: "REPORTS>",      side: "R", dim: true, dimLabel: "REPORTS" },
    { key: "requests",label: "", value: "REQUESTS>",     side: "R", dim: true, dimLabel: "REQUESTS" },
    { key: "perf",    label: "", value: "PERFORMANCE>",  side: "R", editable: true, selectable: true, tone: "white" },
  ];

  // ── ACARS RWY PERF/W&B ─────────────────────────────────────────────────────
  // Exactly the POH's p.9-69 layout: TAKEOFF <CONDITIONS / W&B <LOADSHEET /
  // TAKEOFF <RWY DATA on the left, LANDING CONDITIONS> and LANDING RWY DATA>
  // on the right (both greyed — this app computes takeoff performance only),
  // and RETURN TO <ACARS MENU at 6L.
  function handlePerfWbCommit(key) {
    if (key === "toconditions") { setPage("COND1"); return; }
    if (key === "loadsheet")    { setPage("LOADSHEET"); return; }
    if (key === "torwydata") {
      // T/O DATA> only VIEWS a result — it doesn't request one. Say what's
      // actually missing rather than the bare "NO TAKEOFF DATA AVAIL", which
      // reads like a failure when nothing has been sent yet.
      if (!tpsResult) {
        if (![runway1, runway2, runway3].some(r => r.trim())) return { error: "ENTER RUNWAY 1" };
        if (!relVersion) return { error: "ENTER RLS VERSION 2/2" };
        if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
        return { error: "PRESS SEND FIRST" };
      }
      setAcarsPageIndex(0); setPage("ACARS");
      return;
    }
    if (key === "acarsmenu") { setPage("ACARSMENU"); return; }
    // DATA REQ* here is scoped to ROUTE data only — the flight's identity and
    // planned weight. Conditions and loadsheet each have their own request on
    // their own page, so one button no longer overwrites everything at once.
    if (key === "datareq") {
      if (!xmlData) return { error: "NO FLIGHT PLAN" };
      setPtow(xmlData.est_tow_xml ? fmtWeightK(Number(xmlData.est_tow_xml)) : "");
      if (!runway1 && xmlData.plan_rwy && runwayIds.includes(xmlData.plan_rwy)) setRunway1(xmlData.plan_rwy);
      return { error: "ROUTE DATA LOADED" };
    }
  }

  const perfWbFields = [
    { key: "toconditions", label: "TAKEOFF",    value: "<CONDITIONS", side: "L", editable: true, selectable: true, tone: "white" },
    { key: "loadsheet",    label: "W&B",        value: "<LOADSHEET",  side: "L", editable: true, selectable: true, tone: "white" },
    { key: "torwydata",    label: "TAKEOFF",    value: "<RWY DATA",   side: "L", editable: true, selectable: true, tone: "white" },
    { key: "_p1",          label: "",           value: "",             side: "L", editable: false },
    { key: "_p2",          label: "",           value: "",             side: "L", editable: false },
    { key: "acarsmenu",    label: "RETURN TO",  value: "<ACARS MENU", side: "L", editable: true, selectable: true, tone: "white" },
    { key: "ldgconditions",label: "LANDING",    value: "CONDITIONS>", side: "R", dim: true, dimLabel: "LANDING COND" },
    { key: "_p3",          label: "",           value: "",             side: "R", editable: false },
    { key: "ldgrwydata",   label: "LANDING",    value: "RWY DATA>",   side: "R", dim: true, dimLabel: "LANDING RWY DATA" },
    { key: "_p4",          label: "",           value: "",             side: "R", editable: false },
    { key: "_p5",          label: "",           value: "",             side: "R", editable: false },
    // 6R is "Reserved for future use" on the real page (POH p.9-69) — the
    // natural home for DATA REQ*, which pre-loads BOTH the conditions and
    // loadsheet pages from the OFP in one press. It can't live on those pages
    // themselves: every one of their twelve LSKs is already taken, and the
    // middle column has no key next to it.
    { key: "datareq",      label: "",           value: "DATA REQ*",   side: "R", editable: true, selectable: true, tone: "white" },
  ];

  // ── ACARS LOADSHEET (POH p.9-73/74) ────────────────────────────────────────
  // The real page is the crew's manual weight & balance entry. Ours starts
  // pre-filled from the SimBrief OFP (so it's usable as-is) but every field
  // is editable, and whatever is entered here overrides the OFP numbers on
  // the next send. Amber = mandatory entry, cyan = optional, per the POH's
  // color-coding note.
  //
  // The backend takes totals (pax / cargo / ramp fuel), so the per-section
  // entries are summed on send. Bag COUNT is converted at the FAA standard
  // 30 lb/bag checked-baggage weight and added to the freight WT figure.
  const LB_PER_BAG = 30;

  // Slashed fields (AD/CH, BAG/WT, ACM/FFA/AFA) accept either side on its own
  // and keep whatever is already in the other. "20/2" then "/3" -> "20/3";
  // "5" -> "5/2". An omitted side is left as-is rather than being blanked,
  // which is how the real entry behaves.
  function mergeSlashed(current, entry) {
    const cur = String(current || "").split("/");
    const inc = String(entry || "").split("/");
    const parts = inc.map((p, i) => (p.trim() === "" ? (cur[i] ?? "") : p.trim()));
    // Preserve any trailing segments the entry didn't mention at all.
    for (let i = inc.length; i < cur.length; i++) parts[i] = cur[i];
    return parts.join("/");
  }

  // Weights accept either raw pounds or thousands-with-a-decimal — "76300"
  // and "76.3" are the same number. Anything containing a "." (or under 1000)
  // is read as thousands, matching how the crew reads PTOW off the release.
  function parseWeightLb(s) {
    const t = String(s).trim();
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return (t.includes(".") || n < 1000) ? Math.round(n * 1000) : Math.round(n);
  }
  // Display form used by the real pages: thousands, one decimal.
  function fmtWeightK(lb) {
    return lb == null ? "" : (lb / 1000).toFixed(1);
  }

  function sumPair(s) {
    // "24/0" -> 24 + 0 ; "24" -> 24 ; "" -> 0
    return String(s).split("/").reduce((t, p) => t + (parseInt(p, 10) || 0), 0);
  }
  function bagWeight(s) {
    const [count, wt] = String(s).split("/");
    return (parseInt(count, 10) || 0) * LB_PER_BAG + (parseInt(wt, 10) || 0);
  }

  function handleLoadsheetCommit(key, value) {
    if (key === "perfwb") { setPage("PERFWB"); return; }
    // W/B REQ* — loads only this page's weight & balance figures from the OFP.
    // Section split mirrors the backend's own (25% fwd / 75% aft); cargo is
    // split 50/50 because the OFP carries a single total.
    if (key === "wbreq") {
      if (!xmlData) return { error: "NO FLIGHT PLAN" };
      const paxTotal = Number(xmlData.pax_count_xml) || 0;
      const cargoTotal = Number(xmlData.cargo_xml) || 0;
      const fwdPax = Math.round(paxTotal * 0.25);
      setAdChA(`${fwdPax}/0`);
      setAdChB(`${paxTotal - fwdPax}/0`);
      setAdChC("0/0");
      setBagFwd(`0/${Math.round(cargoTotal / 2)}`);
      setBagAft(`0/${cargoTotal - Math.round(cargoTotal / 2)}`);
      setFaAcm("0/1/1");
      setCloset("65");
      setToFuel(String(xmlData.plan_ramp_xml ?? ""));
      return { error: "W/B DATA LOADED" };
    }
    if (key === "send") {
      if (![runway1, runway2, runway3].some(r => r.trim())) return { error: "ENTER RUNWAY 1" };
      if (!relVersion) return { error: "ENTER REL VERSION" };
      if (!relOk) return { error: `REL MISMATCH - OFP ${ofpRelease}` };
      handleExec();
      return;
    }
    if (key === "torwydata") {
      // T/O DATA> only VIEWS a result — it doesn't request one. Say what's
      // actually missing rather than the bare "NO TAKEOFF DATA AVAIL", which
      // reads like a failure when nothing has been sent yet.
      if (!tpsResult) {
        if (![runway1, runway2, runway3].some(r => r.trim())) return { error: "ENTER RUNWAY 1" };
        if (!relVersion) return { error: "ENTER RLS VERSION 2/2" };
        if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
        return { error: "PRESS SEND FIRST" };
      }
      setAcarsPageIndex(0); setPage("ACARS");
      return;
    }
    const setters = {
      adcha: setAdChA, adchb: setAdChB, adchc: setAdChC,
      bagfwd: setBagFwd, bagaft: setBagAft,
      faacm: setFaAcm, closet: setCloset, tofuel: setToFuel, blstfuel: setBlstFuel,
    };
    const setter = setters[key];
    if (!setter) return;
    if (value === null) return; // not a cyclable field
    if (value === DELETE_TOKEN) { setter(""); return; }

    // Slashed fields merge with what's already there (see mergeSlashed).
    const current = {
      adcha: adChA, adchb: adChB, adchc: adChC,
      bagfwd: bagFwd, bagaft: bagAft, faacm: faAcm,
    }[key];
    if (current !== undefined) {
      if (!/^[\d/]*$/.test(value)) return { error: "INVALID ENTRY" };
      setter(mergeSlashed(current, value));
      return;
    }

    // Fuel weights accept pounds or thousands ("7200" or "7.2").
    if (key === "tofuel" || key === "blstfuel") {
      const lb = parseWeightLb(value);
      if (lb == null) return { error: "INVALID ENTRY" };
      setter(String(lb));
      return;
    }
    setter(value);
  }

  // Layout and wording taken from the real E175 loadsheet page: AD/CH A/B/C
  // amber (mandatory), BAG/WT FWD/AFT cyan, and on the right ACM/FFA/AFA TTL,
  // PAX CLOSET, T/O FUEL, BLST FUEL, T/O DATA>, SEND. TTL PAX is a computed
  // green readout in the middle column, not an entry.
  const loadsheetFields = [
    { key: "adcha",   label: "AD/CH A",      value: adChA,   side: "L", editable: true, tone: "amber", boxes: "00/0" },
    { key: "adchb",   label: "AD/CH B",      value: adChB,   side: "L", editable: true, tone: "amber", boxes: "00/0" },
    { key: "adchc",   label: "AD/CH C",      value: adChC,   side: "L", editable: true, tone: "amber", boxes: "00/0" },
    { key: "bagfwd",  label: "BAG/WT FWD",   value: bagFwd,  side: "L", editable: true, tone: "cyan" },
    { key: "bagaft",  label: "BAG/WT AFT",   value: bagAft,  side: "L", editable: true, tone: "cyan" },
    { key: "perfwb",  label: "",             value: "<PERF/W&B", side: "L", editable: true, selectable: true, tone: "white" },
    { key: "faacm",   label: "ACM/FFA/AFA",  value: faAcm,   side: "R", editable: true, tone: "cyan" },
    { key: "closet",  label: "CLOSET",       value: closet,  side: "R", editable: true, tone: "cyan" },
    { key: "tofuel",  label: "T/O FUEL",     value: toFuel ? fmtWeightK(Number(toFuel)) : "", side: "R", editable: true, tone: "amber", boxes: "00.0" },
    { key: "blstfuel",label: "BLST FUEL",    value: blstFuel ? fmtWeightK(Number(blstFuel)) : "", side: "R", editable: true, tone: "cyan" },
    // W/B REQ* pulls the OFP's weight & balance figures into this page only.
    { key: "wbreq",     label: "W/B",        value: "REQ*",  side: "R", editable: true, selectable: true, tone: "white" },
    { key: "send",      label: "",           value: "SEND",  side: "R", editable: true, selectable: true, tone: "white" },
    { key: "ttlpax",  label: "TTL PAX",
      value: String(sumPair(adChA) + sumPair(adChB) + sumPair(adChC)),
      side: "C", row: 1, editable: false, tone: "green" },
  ];

  // ── ACARS PAX DETAIL — LOADSHEET page 2/2 (POH p.9-75) ─────────────────────
  function handlePaxDetailCommit(key, value) {
    if (key === "return") { setPage("LOADSHEET"); return; }
    if (key === "clearall") {
      setPaxWtA(""); setPaxWtB(""); setPaxWtC("");
      return;
    }
    if (key === "cg") {
      if (value === DELETE_TOKEN) { setCgPercent("25.0"); return; }
      const n = parseFloat(value);
      if (!Number.isFinite(n) || n < 5 || n > 45) return { error: "INVALID ENTRY" };
      setCgPercent(value);
      return;
    }
    const setters = { paxa: setPaxWtA, paxb: setPaxWtB, paxc: setPaxWtC };
    const setter = setters[key];
    if (!setter) return;
    if (value === DELETE_TOKEN) { setter(""); return; }
    if (!/^\d{1,6}$/.test(value)) return { error: "INVALID ENTRY" };
    setter(value);
  }

  const paxDetailFields = [
    { key: "paxa",     label: "SEC A WEIGHT", value: paxWtA,    side: "L", editable: true, tone: "cyan" },
    { key: "paxb",     label: "SEC B WEIGHT", value: paxWtB,    side: "L", editable: true, tone: "cyan" },
    { key: "paxc",     label: "SEC C WEIGHT", value: paxWtC,    side: "L", editable: true, tone: "cyan" },
    { key: "cg",       label: "CG %MAC",      value: cgPercent, side: "L", editable: true, tone: "amber" },
    { key: "_pd1",     label: "",             value: "",         side: "L", editable: false },
    { key: "return",   label: "",             value: "<RETURN",  side: "L", editable: true, selectable: true, tone: "white" },
    { key: "_pd2",     label: "",             value: "",         side: "R", editable: false },
    { key: "_pd3",     label: "",             value: "",         side: "R", editable: false },
    { key: "_pd4",     label: "",             value: "",         side: "R", editable: false },
    { key: "_pd5",     label: "",             value: "",         side: "R", editable: false },
    { key: "_pd6",     label: "",             value: "",         side: "R", editable: false },
    { key: "clearall", label: "",             value: "CLEAR ALL>", side: "R", editable: true, selectable: true, tone: "white" },
  ];

  // ── IDENT page ─────────────────────────────────────────────────────────────
  const doFetch = useCallback(async (username) => {
    setLoadingPlan(true);
    setIdentStatus("FETCHING OFP...");
    setIdentStatusErr(false);
    try {
      const data = await apiFlightplanBySimbrief(username);
      setXmlData(data);
      localStorage.setItem("tps_simbrief_username", username);
      setSimbriefUsername(username);

      const initRunway = data.valid_runways.some(r => r.id === data.plan_rwy)
        ? data.plan_rwy
        : (data.valid_runways[0]?.id ?? "");
      setRunway1(initRunway);
      setRunway2("");
      setRunway3("");
      setSurface("PLANNED");
      setFlapSel("OPTIMUM");
      setAntiIce(false);
      setForceMax(false);
      setLlwsAdvisory(false);
      setOat(data.temp);
      setQnh(data.qnh);
      setWind(data.wind);
      setRelVersion("");
      // PTOW is a real planned takeoff weight, entered in thousands of pounds
      // with one decimal — POH p.9-71: "76.4 for 76,400 pounds". Seed it from
      // the OFP's estimated TOW so it's a usable figure rather than blank.
      setPtow(data.est_tow_xml ? (Number(data.est_tow_xml) / 1000).toFixed(1) : "");
      setTpsResult(null);
      setPrintPageIndex(0);

      // Deliberately NOT pre-filled. The real unit comes up with every entry
      // field blank (dashes) and the crew fills them in; auto-populating them
      // hides what has actually been entered vs. assumed. The OFP figures are
      // available on demand via DATA REQ* (see requestOfpData), which loads
      // them into the fields as a preview the crew can then edit.
      setIdentStatus(`OFP LOADED - FLT ${data.flight_number} ${data.origin_iata}-${data.dest_iata}`);
      setIdentStatusErr(false);
      setPage("PERFWB");
    } catch (e) {
      setIdentStatus(e instanceof ApiError ? e.message.toUpperCase() : "COULD NOT REACH SERVER");
      setIdentStatusErr(true);
    } finally {
      setLoadingPlan(false);
    }
  }, []);

  // ACARS INITIALIZE — the POH page (p.9-62) is FLT NO / SKED DAY, DEP /
  // XPDR FLT ID / DEST, FUEL QTY / BD FUEL, crew IDs, <RETURN / AUTO INIT*.
  // Ours substitutes a SimBrief ID for the crew-entry fields (that one entry
  // supplies everything the real crew would type), then shows DEP and DEST
  // in the same 2L/2R slots as the real page. DEP/DEST are editable so the
  // pair can be corrected without re-fetching, and they drive the runway
  // list and the "KAUS RWY n" labels on the conditions page.
  function handleIdentCommit(key, value) {
    if (key === "simbrief") {
      if (value === null) return;
      doFetch(value);
      return;
    }
    if (key === "dep") {
      if (!value || value === DELETE_TOKEN) return { error: "MANDATORY FIELD" };
      const v = value.toUpperCase();
      if (!/^[A-Z]{4}$/.test(v)) return { error: "INVALID ENTRY" };
      setXmlData(d => (d ? { ...d, origin_icao: v } : d));
      return;
    }
    if (key === "dest") {
      if (!value || value === DELETE_TOKEN) return { error: "MANDATORY FIELD" };
      const v = value.toUpperCase();
      if (!/^[A-Z]{4}$/.test(v)) return { error: "INVALID ENTRY" };
      setXmlData(d => (d ? { ...d, dest_icao: v } : d));
      return;
    }
    if (key === "return") { setPage("ACARSMENU"); return; }
    if (key === "autoinit") {
      const u = simbriefUsername.trim();
      if (!u) return { error: "ENTER SIMBRIEF ID" };
      doFetch(u);
      return;
    }
  }

  const identFields = [
    { key: "simbrief", label: "SIMBRIEF ID", value: simbriefUsername, side: "L", editable: true, tone: "amber" },
    ...(xmlData ? [
      { key: "dep",  label: "DEP",    value: xmlData.origin_icao || "", side: "L", editable: true, tone: "amber" },
      { key: "fuel", label: "FUEL QTY", value: String(xmlData.plan_ramp_xml ?? ""), side: "L", editable: false, tone: "green" },
      { key: "flt",  label: "FLT NO", value: String(xmlData.flight_number), side: "R", editable: false, tone: "green" },
      { key: "dest", label: "DEST",   value: xmlData.dest_icao || "", side: "R", editable: true, tone: "amber" },
      { key: "ac",   label: "A/C",    value: xmlData.icaocode, side: "R", editable: false, tone: "green" },
    ] : []),
    // POH p.9-62 LSK 6R: DATALINK AUTO INIT* — fetches the flight data. This
    // is how the OFP is pulled now that there's no EXEC key on the chassis.
    { key: "autoinit", label: "DATALINK", value: "AUTO INIT*", side: "R", editable: true, selectable: true, tone: "white" },
  ];

  // ── ACARS T/O CONDITION 1/2 (POH p.9-70/71) ────────────────────────────────
  // "KIND RWY 1" on the POH screenshot is the departure ICAO + slot number,
  // taken from the ACARS INITIALIZE page — so it renders from the loaded
  // flight plan, not as a literal.
  function cycleRunwaySlot(current, setter) {
    const opts = ["", ...runwayIds];
    const idx = opts.indexOf(current);
    setter(opts[(idx + 1) % opts.length]);
  }

  function handleCond1Commit(key, value) {
    if (key === "return") {
      // 6L on the real T/O CONDITIONS page returns to the PERF/W&B menu.
      if (value === null) setPage("PERFWB");
      return; // DELETE on the return line: not applicable, no-op
    }
    if (key === "rwy1" || key === "rwy2" || key === "rwy3") {
      const setter = key === "rwy1" ? setRunway1 : key === "rwy2" ? setRunway2 : setRunway3;
      const current = key === "rwy1" ? runway1 : key === "rwy2" ? runway2 : runway3;
      if (value === null) { cycleRunwaySlot(current, setter); return; }
      if (value === DELETE_TOKEN) { setter(""); return; } // clear this runway slot
      // Validate the base runway id (before any "/INTXN" suffix) against
      // this flight plan's published runways.
      const [base] = value.split("/");
      if (!runwayIds.includes(base)) return { error: "INVALID ENTRY" };
      setter(value);
      return;
    }
    if (key === "surface") {
      if (value === null) {
        const idx = surfaceChoices.indexOf(surface);
        setSurface(surfaceChoices[(idx + 1) % surfaceChoices.length]);
        return;
      }
      if (value === DELETE_TOKEN) return { error: "NOT ALLOWED" }; // required field
      const mapped = SURFACE_SHORTHAND[value.toUpperCase()];
      if (!mapped || !surfaceChoices.includes(mapped)) return { error: "INVALID ENTRY" };
      setSurface(mapped);
      return;
    }
    // Shortcut keys (POH 4R/5R) and the DATALINK SEND* key (6R).
    if (key === "gotols")   { setPage("LOADSHEET"); return; }
    if (key === "gotodata") {
      // T/O DATA> only VIEWS a result — it doesn't request one. Say what's
      // actually missing rather than the bare "NO TAKEOFF DATA AVAIL", which
      // reads like a failure when nothing has been sent yet.
      if (!tpsResult) {
        if (![runway1, runway2, runway3].some(r => r.trim())) return { error: "ENTER RUNWAY 1" };
        if (!relVersion) return { error: "ENTER RLS VERSION 2/2" };
        if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
        return { error: "PRESS SEND FIRST" };
      }
      setAcarsPageIndex(0); setPage("ACARS");
      return;
    }
    if (key === "send") {
      if (![runway1, runway2, runway3].some(r => r.trim())) return { error: "ENTER RUNWAY 1" };
      // AeroData won't compute against a stale release — block the send.
      // RLS VERSION is entered on page 2/2.
      if (!relVersion) return { error: "ENTER RLS VERSION 2/2" };
      if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
      handleExec();
      return;
    }
    if (key === "wind")  { setWind(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "ptow") {
      if (value === DELETE_TOKEN) { setPtow(""); return; }
      // Accepts "76300" or "76.3" — both mean 76,400-ish lb. Displayed in
      // thousands with one decimal, as on the release (POH p.9-71).
      const lb = parseWeightLb(value);
      if (lb == null) return { error: "INVALID ENTRY" };
      setPtow(fmtWeightK(lb));
      return;
    }
    if (key === "oatqnh") {
      if (value === DELETE_TOKEN) return { error: "NOT ALLOWED" }; // required field
      const [o, q] = value.split("/");
      if (o === undefined || q === undefined) return { error: "INVALID ENTRY" };
      setOat(o); setQnh(q);
      return;
    }
  }

  // "KLAX" on the real screen isn't a literal word — it's the departure
  // airport's ICAO code shown above each entry line, confirming which
  // airport RWY 1/2/3 apply to. Render it from the loaded flight plan.
  const depIcao = xmlData?.origin_icao || "----";
  // Exact POH p.9-70/71 layout. Note there is NO separate GUST field and no
  // REL VERSION field on the real page — per p.9-71 LSK 1R, gust is folded
  // into the WIND entry and only for a TAILWIND ("including the gust factor,
  // the highest number in terms of velocity"). Those two extra lines used to
  // sit here and pushed PTOW and everything below it off their LSKs.
  // LEVEL (contamination depth) is greyed: the backend's TLR interpolation
  // only carries DRY/WET tables, no compacted-snow/wet-ice depth data.
  const cond1Fields = xmlData ? [
    { key: "rwy1",     label: `${depIcao} RWY 1`, value: runway1, side: "L", editable: true, cyclable: true, tone: "amber", boxes: "000" },
    { key: "rwy2",     label: `${depIcao} RWY 2`, value: runway2, side: "L", editable: true, cyclable: true, tone: "cyan" },
    { key: "rwy3",     label: `${depIcao} RWY 3`, value: runway3, side: "L", editable: true, cyclable: true, tone: "cyan" },
    { key: "surface",  label: "SURFACE",   value: SURFACE_LABELS[surface] ?? surface, side: "L", editable: true, cyclable: true, tone: "cyan" },
    { key: "level",    label: "LEVEL",     value: "---",           side: "L", dim: true, dimLabel: "CONTAM LEVEL" },
    { key: "return",   label: "",          value: "<PERF/W&B",     side: "L", editable: true, selectable: true, tone: "white" },
    { key: "wind",     label: "WIND",     value: String(wind),      side: "R", editable: true, tone: "cyan" },
    { key: "oatqnh",   label: "OAT/QNH",  value: oat || qnh ? `${oat}/${qnh}` : "", side: "R", editable: true, tone: "cyan" },
    { key: "ptow",     label: "PTOW",     value: ptow,              side: "R", editable: true, tone: "cyan" },
    { key: "gotols",   label: "W&B",      value: "LOADSHEET>",      side: "R", editable: true, selectable: true, tone: "white" },
    { key: "gotodata", label: "T/O",      value: "DATA>",           side: "R", editable: true, selectable: true, tone: "white" },
    { key: "send",     label: "",         value: "SEND",            side: "R", editable: true, selectable: true, tone: "white" },
  ] : [];

  // ── ACARS T/O CONDITION 2/2 — FLAP, ANTI-ICE, THRUST, RLS VERSION ─────────
  // Layout taken from a real E175 screen photo. LLWS ADVISORY is NOT on this
  // page (it was a guess and has been dropped); RLS VERSION sits at 4L.
  // Exact field order and wording confirmed against real E-Jet cockpit
  // footage: ANTI-ICE first (not last), "FLAPS" (plural) not "FLAP",
  // "OPTIMUM" (not the abbreviation "OPT"/"NORMAL"), and a fourth field —
  // LLWS ADVISORY — that this app didn't have at all before. All four
  // fields sit in a single left-hand column with nothing on the right,
  // matching the real screen. LLWS ADVISORY is informational only (it
  // doesn't change the takeoff numbers) so it isn't sent to the backend.
  // DELETE on any of these fixed-choice fields resets it to the default
  // (same as what a fresh flight-plan load starts with) — real CDU convention
  // for a field that can't just go blank.
  function handleCond2Commit(key, value) {
    if (key === "perfwb") { setPage("PERFWB"); return; }
    if (key === "relversion") {
      if (value === DELETE_TOKEN) { setRelVersion(""); return; }
      setRelVersion(value);
      if (value !== String(ofpRelease)) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
      return;
    }
    if (key === "flaps") {
      const opts = ["OPTIMUM", "1", "2", "4"];
      if (value === null) {
        const idx = opts.indexOf(flapSel);
        setFlapSel(opts[(idx + 1) % opts.length]);
        return;
      }
      if (value === DELETE_TOKEN) { setFlapSel("OPTIMUM"); return; }
      const v = value.toUpperCase();
      if (v === "OPT") { setFlapSel("OPTIMUM"); return; } // screen shows OPT
      if (!opts.includes(v)) return { error: "INVALID ENTRY" };
      setFlapSel(v);
      return;
    }
    if (key === "antiice") {
      if (value === null) { setAntiIce(a => !a); return; }
      if (value === DELETE_TOKEN) { setAntiIce(false); return; }
      const v = value.toUpperCase();
      // Real page reads ALL (not ON) when anti-ice is selected.
      if (v === "ALL" || v === "ON") setAntiIce(true);
      else if (v === "AUTO" || v === "OFF") setAntiIce(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "thrust") {
      if (value === null) { setForceMax(f => !f); return; }
      if (value === DELETE_TOKEN) { setForceMax(false); return; }
      const v = value.toUpperCase();
      if (v === "MAX") setForceMax(true);
      else if (v === "NORMAL" || v === "OPTIMUM") setForceMax(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "llws") {
      if (value === null) { setLlwsAdvisory(a => !a); return; }
      if (value === DELETE_TOKEN) { setLlwsAdvisory(false); return; }
      const v = value.toUpperCase();
      if (v === "YES") setLlwsAdvisory(true);
      else if (v === "NO") setLlwsAdvisory(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
  }

  // Real E175 page 2/2: FLAP / ANTI-ICE / THRUST / RLS VERSION down the left,
  // <PERF/W&B at 6L, nothing on the right. Note FLAP is singular and its
  // default reads OPT, THRUST reads NORMAL (not "OPTIMUM"), and RLS VERSION
  // lives HERE at 4L — not on page 1/2 where it used to be.
  const cond2Fields = xmlData ? [
    { key: "flaps",   label: "FLAP",     value: flapSel === "OPTIMUM" ? "OPT" : flapSel, side: "L", editable: true, cyclable: true, tone: "cyan" },
    { key: "antiice", label: "ANTI-ICE", value: antiIce ? "ALL" : "AUTO", side: "L", editable: true, cyclable: true, tone: "cyan" },
    { key: "thrust",  label: "THRUST",   value: forceMax ? "MAX" : "NORMAL", side: "L", editable: true, cyclable: true, tone: "cyan" },
    // Amber = mandatory entry (POH colour note): this app blocks SEND until a
    // release version is entered and matches the OFP, so it is mandatory here.
    { key: "relversion", label: "RLS VERSION", value: relVersion, side: "L", editable: true, boxes: "0",
      tone: relVersion && !relOk ? undefined : "amber", error: !!relVersion && !relOk },
    { key: "_c2pad",  label: "",         value: "",              side: "L", editable: false },
    { key: "perfwb",  label: "",         value: "<PERF/W&B",     side: "L", editable: true, selectable: true, tone: "white" },
  ] : [];

  async function handleExec() {
    const runways = [runway1, runway2, runway3].map(r => r.trim().toUpperCase()).filter(Boolean);
    if (!xmlData || runways.length === 0) return;
    setGenerating(true);
    setPerfStatus("GENERATING...");
    setPerfStatusErr(false);
    try {
      // WIND is a single entry on the real page — the pilot types the gust
      // into it directly when required (POH p.9-71), so it passes straight
      // through to the backend's "wind" param as typed.
      const windStr = wind;
      // ACARS LOADSHEET entries override the OFP's own pax/cargo/fuel — same
      // as the real system, where the loadsheet supersedes the planned figures
      // (and PTOW is discarded) once it's been filled in.
      const lsPax = sumPair(adChA) + sumPair(adChB) + sumPair(adChC);
      const lsCargo = bagWeight(bagFwd) + bagWeight(bagAft);
      const lsFuel = parseInt(toFuel, 10);
      const result = await apiGenerateTps({
        xml_data: xmlData,
        mode: "tps",
        scenario: surface,
        condOverride: conditionsEdited,
        oat, qnh, wind: windStr,
        antiIce,
        runways,
        speedOverrides: flapSel !== "OPTIMUM" ? { flaps: flapSel } : {},
        forceMax,
        ...(lsPax   > 0 ? { pax: lsPax }     : {}),
        ...(lsCargo > 0 ? { cargo: lsCargo } : {}),
        ...(Number.isFinite(lsFuel) && lsFuel > 0 ? { ramp: lsFuel } : {}),
        ...(Number.isFinite(parseFloat(cgPercent)) ? { cg: parseFloat(cgPercent) } : {}),
      });
      setTpsResult(result.tps);
      setPrintPageIndex(0);
      setAcarsPageIndex(0);
      setPerfStatus("");
      setPerfStatusErr(false);
      setPage("ACARS");
    } catch (e) {
      setPerfStatus(e instanceof ApiError ? e.message.toUpperCase() : "GENERATION FAILED");
      setPerfStatusErr(true);
    } finally {
      setGenerating(false);
    }
  }

  // ── ACARS T/O RWY DATA — authentic post-EXEC report ───────────────────────
  // Matches the real Honeywell AeroData ACARS "Takeoff Runway Data" report,
  // confirmed field-for-field against a live-generated COMBINED.txt sample:
  // page 1 = loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH, SECT A/B/C —
  // pax + F/A CGO weight + GTOW/CG + ZFW/CG + FOB + TOT PAX), page 2 =
  // REMARKS, then ONE TAKEOFF PERFORMANCE page per requested runway (up to
  // 3 — matches the real system's KIND RWY 1/2/3 limit and its "pages 3/5,
  // 4/5, 5/5 are identical, one per runway request" pagination).
  // Report pages are read-only; PREV/PERF/MENU navigate away (there are no
  // <RETURN> lines any more).
  function handleAcarsCommit() {}

  // Center column is PACKED two-values-per-row (same technique the real
  // AeroData printout uses) instead of one field per line — with all 6 of
  // F CGO/GTOW-CG/A CGO/ZFW-CG/FOB/TOT PAX on their own lines the page ran
  // to ~13 rows and overflowed the fixed-height screen, forcing an internal
  // scroll that real CDU hardware never does and that desynced the LSK
  // hit-targets from their labels. Packed + tight brings it to 9 rows.
  // Real 3-column grid, matching POH p.9-76 row for row:
  //   FLT NO | RLS NO   | TIME        WIND  | OAT C    | QNH
  //   SEC A  | F BAG/WT | GTOW/CG     SEC B | A BAG/WT | FUEL
  //   SEC C  | TTL PAX  | ZFW/CG      <RETURN | TAKEOFF DATA AVAIL
  const acarsSummaryFields = loadsheetSummary ? [
    { key: "flt",   label: "FLT NO",   value: String(loadsheetSummary.flt_no),       side: "L", editable: false, tone: "green" },
    { key: "rls",   label: "RLS NO",   value: String(loadsheetSummary.rls_no),       side: "C", row: 0, editable: false, tone: "green" },
    { key: "time",  label: "TIME",     value: String(loadsheetSummary.time),         side: "R", editable: false, tone: "green" },
    { key: "wind",  label: "WIND",     value: String(loadsheetSummary.wind),         side: "L", editable: false, tone: "green" },
    { key: "oat",   label: "OAT C",    value: String(loadsheetSummary.oat),          side: "C", row: 1, editable: false, tone: "green" },
    { key: "qnh",   label: "QNH",      value: String(loadsheetSummary.qnh),          side: "R", editable: false, tone: "green" },
    { key: "seca",  label: "SEC A",    value: String(loadsheetSummary.sect_a_pax),   side: "L", editable: false, tone: "green" },
    { key: "fcgo",  label: "F BAG/WT", value: String(loadsheetSummary.sect_a_bagwt), side: "C", row: 2, editable: false, tone: "green" },
    { key: "gtow",  label: "GTOW/CG",  value: String(loadsheetSummary.gtow_cg),      side: "R", editable: false, tone: "green" },
    { key: "secb",  label: "SEC B",    value: String(loadsheetSummary.sect_b_pax),   side: "L", editable: false, tone: "green" },
    { key: "acgo",  label: "A BAG/WT", value: String(loadsheetSummary.sect_b_bagwt), side: "C", row: 3, editable: false, tone: "green" },
    { key: "fob",   label: "FUEL",     value: String(loadsheetSummary.sect_c_fuel),  side: "R", editable: false, tone: "green" },
    { key: "secc",  label: "SEC C",    value: String(loadsheetSummary.sect_c_pax),   side: "L", editable: false, tone: "green" },
    { key: "totpax",label: "TTL PAX",  value: String(loadsheetSummary.ttl_pax),      side: "C", row: 4, editable: false, tone: "green" },
    { key: "zfw",   label: "ZFW/CG",   value: String(loadsheetSummary.zfw_cg),       side: "R", editable: false, tone: "green" },
    // TAKEOFF DATA AVAIL is posted to the SCRATCHPAD (see acarsMessage), not
    // rendered as a screen line — that's where the real unit puts it.
  ] : [];

  // REMARKS page (POH p.9-77): a "REMARKS" heading in label colour with the
  // remark lines beneath it in AeroData green — not an undifferentiated wall
  // of plain text. Lines are laid onto the grid's left column so they sit on
  // their own rows and stay pinned to the LSKs.
  const acarsRemarksFields = loadsheetSummary ? (() => {
    const lines = (loadsheetSummary.remarks ?? []).filter(rl => String(rl).trim());
    return [
      { key: "hdr", label: "REMARKS", value: " ", side: "L", editable: false, tone: "green" },
      // Full-width centre lines — remark text is longer than a third of the
      // screen and was being clipped in the left column.
      ...lines.slice(0, 8).map((rl, i) => ({
        key: `rl${i}`, label: "", value: rl, side: "C", editable: false, tone: "green", small: true, wide: true,
      })),
    ];
  })() : [];

  // EFP / special-departure page — engine-failure procedure text for this
  // airport. The printed AERODATA report puts this under a "SPECIAL" header
  // wrapped to the column width; same treatment here, wrapped to the CDU's
  // 24-char line so it reads identically.
  const efpText = loadsheetSummary?.efp_text || "";
  function wrapText(s, width) {
    const out = [];
    let line = "";
    for (const w of String(s).split(/\s+/).filter(Boolean)) {
      if ((line + " " + w).trim().length > width) { if (line) out.push(line); line = w; }
      else line = (line ? line + " " : "") + w;
    }
    if (line) out.push(line);
    return out;
  }
  // Rendered as unrowed centre fields so each line spans the FULL screen
  // width. Putting them in the left column truncated them to a third of the
  // width, which is what was clipping the text.
  const acarsEfpFields = efpText ? (() => {
    const lines = wrapText(efpText, 26);
    return [
      { key: "efphdr", label: "SPECIAL", value: " ", side: "L", editable: false, tone: "green" },
      ...lines.slice(0, 8).map((l, i) => ({
        key: `efp${i}`, label: "", value: l, side: "C", editable: false, tone: "green", small: true, wide: true,
      })),
    ];
  })() : [];

  // Field set matches a live-generated TAKEOFF PERFORMANCE block exactly:
  // left = FLEX/FLAP/STAB, right = V1/VR/V2/VFS, center = airport+runway+
  // length, MRTW/LIM, MTOW, GTOW/CG, ACCEL. One of these per runway result.
  // Same packed-row/tight technique as acarsSummaryFields (see comment
  // above it) — keeps this page from overflowing the fixed-height screen.
  function buildPerfFields(rd) {
    return [
      { key: "flex",  label: "FLEX",     value: String(rd.flex),      side: "L", editable: false, tone: "green" },
      { key: "rwy",   label: "RUNWAY",   value: `${rd.airport} ${rd.runway}`, side: "C", row: 0, editable: false, tone: "green" },
      { key: "v1",    label: "V1",       value: String(rd.v1),        side: "R", editable: false, tone: "green" },
      // FLAP/THR headings follow the aircraft type, same rules the printed
      // AERODATA report uses (Airbus = CONF, MD-83 = EPR, 737 = N1), and the
      // ERJ family carries an extra V215 column. The backend sends the
      // resolved labels so the two outputs can't drift apart.
      { key: "flap",  label: rd.flap_label || "FLAP", value: String(rd.flaps), side: "L", editable: false, tone: "green" },
      { key: "len",   label: "LENGTH",   value: `${rd.length}FT`,     side: "C", row: 1, editable: false, tone: "green" },
      { key: "vr",    label: "VR",       value: String(rd.vr),        side: "R", editable: false, tone: "green" },
      { key: "stab",  label: "STAB",     value: String(rd.trim_stab), side: "L", editable: false, tone: "green" },
      { key: "mrtw",  label: "MRTW/LIM", value: String(rd.mrtw),      side: "C", row: 2, editable: false, tone: "green" },
      { key: "v2",    label: "V2",       value: String(rd.v2),        side: "R", editable: false, tone: "green" },
      { key: "mtow",  label: "MTOW",     value: String(rd.mtow),      side: "L", editable: false, tone: "green" },
      { key: "accel", label: "ACCEL",    value: String(rd.acc_alt),   side: "C", row: 3, editable: false, tone: "green" },
      { key: "vfs",   label: String(rd.vfs_label || "VFS"), value: rd.vfs != null ? String(rd.vfs) : "---", side: "R", editable: false, tone: "green" },
      { key: "gtow",  label: "GTOW/CG",  value: String(rd.gtow_cg),   side: "L", editable: false, tone: "green" },
      // ERJ-only extra speed column, and the type-specific thrust reading
      // (EPR / N1 / THR) when the backend computed one.
      ...(rd.is_erj && rd.v215 != null
        ? [{ key: "v215", label: "V215", value: String(rd.v215), side: "C", row: 4, editable: false, tone: "green" }]
        : []),
      ...(rd.n1
        ? [{ key: "thr", label: rd.thr_label || "THR", value: String(rd.n1), side: "R", editable: false, tone: "green" }]
        : []),
    ];
  }

  const perfPages = runwayResults.length
    ? runwayResults.map(rd => ({ title: "ACARS T/O RWY DATA", fields: buildPerfFields(rd) }))
    : [{ title: "ACARS T/O RWY DATA", fields: [] }];

  const ACARS_PAGES = [
    { title: "ACARS T/O RWY DATA", fields: acarsSummaryFields },
    { title: "ACARS T/O RWY DATA", fields: acarsRemarksFields },
    ...(acarsEfpFields.length ? [{ title: "ACARS T/O RWY DATA", fields: acarsEfpFields }] : []),
    ...perfPages,
  ];

  // Posted to the scratchpad rather than drawn on the page — the real unit
  // shows TAKEOFF DATA AVAIL / NO TAKEOFF DATA AVAIL there, and the crew
  // clears it with one CLR or DEL.
  const acarsMessage = loadsheetSummary
    ? (loadsheetSummary.takeoff_data_avail
        ? { text: "TAKEOFF DATA AVAIL", error: false }
        : { text: "NO TAKEOFF DATA AVAIL", error: true })
    : { text: "NO TAKEOFF DATA AVAIL", error: true };

  // The generated .txt is downloadable (FPL key) but is no longer shown as a
  // paginated on-screen page — a real CDU never displays a raw report dump,
  // and it made NEXT alternate between formatted screens and raw text.
  function handlePrintDownload() {
    if (tpsResult) forceDownloadTxt(tpsResult.content, tpsResult.filename);
  }

  // ── Page config dispatch ──────────────────────────────────────────────────
  let cduProps;
  if (page === "MENU") {
    cduProps = {
      title: "MENU", pageNum: "1/1",
      fields: menuFields,
      onFieldCommit: handleMenuCommit,
      execAvailable: false,
      // Leaving the page disarms the reset confirm — it should never stay
      // armed across a navigation and fire on a later, unrelated press.
      onDlk: () => { setResetArmed(false); setPage("ACARSMENU"); },
      onPerf: () => { setResetArmed(false); setPage(xmlData ? "PERFWB" : "ACARSMENU"); },
    };
  } else if (page === "ACARSMENU") {
    cduProps = {
      title: "ACARS    MAIN MENU", pageNum: "",
      fields: acarsMenuFields,
      onFieldCommit: handleAcarsMenuCommit,
      execAvailable: false,
      onPrev: () => setPage("MENU"),
      onPerf: () => setPage(xmlData ? "PERFWB" : "IDENT"),
    };
  } else if (page === "PERFWB") {
    cduProps = {
      title: "ACARS RWY PERF/W&B", pageNum: "",
      fields: perfWbFields,
      onFieldCommit: handlePerfWbCommit,
      execAvailable: false,
      onPrev: () => setPage("ACARSMENU"),
      onNext: () => setPage("COND1"),
      onPerf: () => setPage("PERFWB"),
    };
  } else if (page === "LOADSHEET") {
    cduProps = {
      title: "ACARS   LOADSHEET", pageNum: "1/2",
      fields: loadsheetFields,
      onFieldCommit: handleLoadsheetCommit,
      execAvailable: false, // no EXEC key on this unit — send is LSK 6R SEND*
      onPrev: () => setPage("PERFWB"),
      onNext: () => setPage("PAXDETAIL"), // 1/2 -> 2/2
      onPerf: () => setPage("PERFWB"),
    };
  } else if (page === "PAXDETAIL") {
    cduProps = {
      title: "ACARS  PAX DETAIL", pageNum: "2/2",
      fields: paxDetailFields,
      onFieldCommit: handlePaxDetailCommit,
      execAvailable: false,
      onPrev: () => setPage("LOADSHEET"),
      onNext: () => setPage("LOADSHEET"),
      onPerf: () => setPage("PERFWB"),
    };
  } else if (page === "IDENT") {
    cduProps = {
      title: "ACARS   INITIALIZE", pageNum: "1/1",
      fields: identFields,
      onFieldCommit: handleIdentCommit,
      execAvailable: false, // no EXEC key — fetch is LSK 6R AUTO INIT*
      message: identStatus ? { text: identStatus, error: identStatusErr } : undefined,
      onPrev: () => setPage("ACARSMENU"),
      onNext: xmlData ? () => setPage("PERFWB") : undefined,
      onPerf: xmlData ? () => setPage("PERFWB") : undefined,
    };
  } else if (page === "COND1") {
    cduProps = {
      title: "ACARS T/O CONDITION", pageNum: "1/2",
      fields: cond1Fields,
      onFieldCommit: handleCond1Commit,
      execAvailable: false,
      message: perfStatus ? { text: perfStatus, error: perfStatusErr } : undefined,
      onPrev: () => setPage("PERFWB"),
      onNext: () => setPage("COND2"),
      onPerf: () => setPage("PERFWB"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "COND2") {
    cduProps = {
      title: "ACARS T/O CONDITION", pageNum: "2/2",
      fields: cond2Fields,
      onFieldCommit: handleCond2Commit,
      // No EXEC key on this unit and no send key on the real 2/2 page — the
      // request goes out from SEND (LSK 6R) on page 1/2.
      execAvailable: false,
      message: perfStatus ? { text: perfStatus, error: perfStatusErr } : undefined,
      onPrev: () => setPage("COND1"),
      onNext: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
      onPerf: () => setPage("PERFWB"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "ACARS") {
    const cur = ACARS_PAGES[acarsPageIndex];
    cduProps = {
      title: cur.title, pageNum: `${acarsPageIndex + 1}/${ACARS_PAGES.length}`,
      fields: cur.fields,
      onFieldCommit: handleAcarsCommit,
      execAvailable: false,
      message: acarsMessage,
      onPrev: () => {
        if (acarsPageIndex > 0) setAcarsPageIndex(i => i - 1);
        else setPage("COND2");
      },
      // Wraps within the report pages. There is no raw-text page in the
      // cycle any more: paging used to fall through into a "TPS PRINT" dump
      // of the generated .txt, so NEXT alternated between the real formatted
      // screens and a wall of raw text. The .txt is still downloadable with
      // the FPL key, which is what that page was really for.
      onNext: () => setAcarsPageIndex(i => (i + 1) % ACARS_PAGES.length),
      onPerf: () => setPage("PERFWB"),
      onFpl: handlePrintDownload,
    };
  } else {
    cduProps = { title: "ACARS", pageNum: "", fields: [], onFieldCommit: () => {},
      onPerf: () => setPage("PERFWB") };
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#1c1c1e" }}>
      {/* MENU key always jumps to the top-level MENU page, same on every
          page — set once here rather than repeated in every branch above. */}
      <CduEmulator onMenu={() => setPage("MENU")} {...cduProps} />
    </div>
  );
}
