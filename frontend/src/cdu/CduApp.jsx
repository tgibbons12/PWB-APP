import { useState, useCallback } from "react";
import CduEmulator, { DELETE_TOKEN } from "./CduEmulator.jsx";
import { calculateLanding, toEjetAcType, pressureAltitude, RWYCC_OPTIONS } from "../landing/index.js";
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
  // MENU | ACARSMENU | PREFLIGHT | IDENT | PERFWB | LOADSHEET | PAXDETAIL
  // | COND1 | COND2 | ACARS
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

  // ── Datalink round-trip simulation ────────────────────────────────────────
  // A real ACARS request goes out over VDR and comes back from the ground
  // station seconds later — it is never instant. Every uplink/downlink here
  // (AUTO INIT, DATA REQ, W/B REQ, SEND) posts a "sent" message, waits a
  // random interval in this range, then delivers its result.
  const DATALINK_MIN_MS = 3000;
  const DATALINK_MAX_MS = 9000;
  const [uplinkBusy, setUplinkBusy] = useState(false);
  const [uplinkMsg, setUplinkMsg] = useState(null); // { text, error }

  const runDatalink = useCallback(async (sentText, work) => {
    setUplinkBusy(true);
    setUplinkMsg({ text: sentText, error: false });
    const wait = DATALINK_MIN_MS + Math.random() * (DATALINK_MAX_MS - DATALINK_MIN_MS);
    await new Promise(res => setTimeout(res, wait));
    try {
      const done = await work();
      if (done) setUplinkMsg({ text: done.text, error: !!done.error });
    } finally {
      setUplinkBusy(false);
    }
  }, []);

  // ACARS INITIALIZE entries (POH p.9-62). All crew-typed; AUTO INIT fills
  // none of them. DEP/DEST are required before AUTO INIT will fire.
  const [fltNoEntry, setFltNoEntry] = useState("");
  const [skedDay, setSkedDay] = useState("");
  const [depEntry, setDepEntry] = useState("");
  const [destEntry, setDestEntry] = useState("");
  const [fuelQty, setFuelQty] = useState("");

  // ── ACARS LANDING (see LANDING_PERF_DESIGN.md) ────────────────────────────
  // The POH documents the landing pages only as LSK targets on PERF/W&B
  // (1R/3R) — there are no screenshots of them, so this layout mirrors the
  // takeoff conditions page rather than copying a documented one.
  const [ldgRwy1, setLdgRwy1] = useState("");
  const [ldgRwy2, setLdgRwy2] = useState("");
  const [ldgRwy3, setLdgRwy3] = useState("");
  const [ldgOat, setLdgOat] = useState("");
  const [ldgQnh, setLdgQnh] = useState("");
  const [ldgWind, setLdgWind] = useState("");
  // Landing weight is NOT entered directly — the real tool takes ZFW and
  // arrival fuel and derives LDW from them, which is how the crew actually
  // knows it. LDW is a computed green readout, never an entry.
  const [ldgZfw, setLdgZfw] = useState("");
  const [arrFuel, setArrFuel] = useState("");
  const [ldgFlap, setLdgFlap] = useState("Full");
  const [ldgRev, setLdgRev] = useState("Both");
  const [rwycc, setRwycc] = useState("");       // TALPA RCAM code — never inferred
  const [ldgVappAdd, setLdgVappAdd] = useState("5");
  // POH p.9-80/9-85. SURFACE and BRK ACTION RPT are SEPARATE selections and
  // AeroData takes the more conservative of the two (p.9-81) — the crew is
  // told to set the braking action report first and leave surface alone.
  const [ldgSurface, setLdgSurface] = useState("DRY");
  const [ldgVis, setLdgVis] = useState("NORMAL");
  const [ldgAntiIce, setLdgAntiIce] = useState("OFF");
  const [ldgStallIce, setLdgStallIce] = useState("NO");
  const [ldgAirport, setLdgAirport] = useState("");
  const [ldgResults, setLdgResults] = useState(null);
  const [ldgPageIndex, setLdgPageIndex] = useState(0);

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
  // Declared HERE, not down with the rest of the landing code: perfWbFields
  // (further up) reads it to decide whether the two LANDING lines are live.
  // A `const` declared after its first use sits in the temporal dead zone and
  // throws on every render — which is exactly what blanked the screen.
  const ldgData = xmlData?.landing ?? null;

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
  // Everything that belongs to a particular flight: the plan itself plus all
  // the conditions/loadsheet entries and results derived from it. Shared by
  // ACARS RESET and by changing DEP/DEST, since a new city pair invalidates
  // exactly this set. The crew IDs and the SimBrief credential survive.
  function clearFlightData() {
    setXmlData(null);
    setRunway1(""); setRunway2(""); setRunway3("");
    setSurface("PLANNED");
    setOat(""); setQnh(""); setWind(""); setPtow(""); setRelVersion("");
    setFlapSel("OPTIMUM"); setAntiIce(false); setForceMax(false); setLlwsAdvisory(false);
    setFltNoEntry(""); setSkedDay(""); setFuelQty("");
    setAdChA(""); setAdChB(""); setAdChC(""); setBagFwd(""); setBagAft("");
    setFaAcm("2/0"); setCloset("65"); setToFuel(""); setBlstFuel("");
    setPaxWtA(""); setPaxWtB(""); setPaxWtC(""); setCgPercent("25.0");
    setLdgRwy1(""); setLdgRwy2(""); setLdgRwy3("");
    setLdgOat(""); setLdgQnh(""); setLdgWind(""); setRwycc("");
    setLdgZfw(""); setArrFuel("");
    setLdgFlap("Full"); setLdgRev("Both"); setLdgVappAdd("5");
    setLdgSurface("DRY"); setLdgVis("NORMAL"); setLdgAntiIce("OFF");
    setLdgStallIce("NO"); setLdgAirport("");
    setLdgResults(null); setLdgPageIndex(0);
    setTpsResult(null); setAcarsPageIndex(0); setPrintPageIndex(0);
    setUplinkMsg(null); setUplinkBusy(false);
  }

  function resetAll() {
    clearFlightData();
    // Wipe the SimBrief ID too, including the persisted copy — otherwise a
    // "reset" unit still comes up pre-filled with the last crew's username.
    setSimbriefUsername("");
    try { localStorage.removeItem("tps_simbrief_username"); } catch { /* private mode */ }
    setDepEntry(""); setDestEntry("");
    setPerfStatus(""); setPerfStatusErr(false);
    setIdentStatus(""); setIdentStatusErr(false);
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
    if (key === "preflt") { setPage("PREFLIGHT"); return; }
    if (key === "perf")   { setPage("PERFWB"); return; }
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

  // ── ACARS PRE-FLIGHT (POH p.9-61) ──────────────────────────────────────────
  //   1L <INITIALIZE            1R NEW MSGS>
  //   2L <DEP DELAY
  //   3L <FREE TEXT
  //   4L <MX REQUEST
  //   5L TAKEOFF <CONDITIONS    5R RWY PERF/W&B>
  //   6L <MAIN MENU             6R ATS MENU>
  // Only INITIALIZE, TAKEOFF CONDITIONS, RWY PERF/W&B and MAIN MENU are
  // implemented; the rest are other ACARS applications and are greyed.
  function handlePreflightCommit(key) {
    if (key === "initialize")   { setPage("IDENT"); return; }
    if (key === "toconditions") { setPage("COND1"); return; }
    if (key === "perfwb")       { setPage("PERFWB"); return; }
    if (key === "mainmenu")     { setPage("ACARSMENU"); return; }
  }

  const preflightFields = [
    { key: "initialize",   label: "",        value: "<INITIALIZE",  side: "L", editable: true, selectable: true, tone: "white" },
    { key: "depdelay",     label: "",        value: "<DEP DELAY",   side: "L", dim: true, dimLabel: "DEP DELAY" },
    { key: "freetext",     label: "",        value: "<FREE TEXT",   side: "L", dim: true, dimLabel: "FREE TEXT" },
    { key: "mxrequest",    label: "",        value: "<MX REQUEST",  side: "L", dim: true, dimLabel: "MX REQUEST" },
    { key: "toconditions", label: "TAKEOFF", value: "<CONDITIONS",  side: "L", editable: true, selectable: true, tone: "white" },
    { key: "mainmenu",     label: "",        value: "<MAIN MENU",   side: "L", editable: true, selectable: true, tone: "white" },
    { key: "newmsgs",      label: "",        value: "NEW MSGS>",    side: "R", dim: true, dimLabel: "NEW MSGS" },
    { key: "_pf1",         label: "",        value: "",              side: "R", editable: false },
    { key: "_pf2",         label: "",        value: "",              side: "R", editable: false },
    { key: "_pf3",         label: "",        value: "",              side: "R", editable: false },
    { key: "perfwb",       label: "RWY",     value: "PERF/W&B>",    side: "R", editable: true, selectable: true, tone: "white" },
    { key: "atsmenu",      label: "",        value: "ATS MENU>",    side: "R", dim: true, dimLabel: "ATS MENU" },
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
    if (key === "ldgconditions") { setPage("LANDCOND"); return; }
    if (key === "ldgrwydata") {
      if (!ldgResults) return { error: "NO LANDING DATA" };
      setLdgPageIndex(0); setPage("LANDDATA");
      return;
    }
    // DATA REQ* here is scoped to ROUTE data only — the flight's identity and
    // planned weight. Conditions and loadsheet each have their own request on
    // their own page, so one button no longer overwrites everything at once.
    if (key === "datareq") {
      if (!xmlData) return { error: "NO FLIGHT PLAN" };
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("ROUTE REQUEST SENT", () => {
        setPtow(xmlData.est_tow_xml ? fmtWeightK(Number(xmlData.est_tow_xml)) : "");
        if (!runway1 && xmlData.plan_rwy && runwayIds.includes(xmlData.plan_rwy)) setRunway1(xmlData.plan_rwy);
        return { text: "ROUTE DATA RECEIVED", error: false };
      });
      return;
    }
  }

  const perfWbFields = [
    { key: "toconditions", label: "TAKEOFF",    value: "<CONDITIONS", side: "L", editable: true, selectable: true, tone: "white" },
    { key: "loadsheet",    label: "W&B",        value: "<LOADSHEET",  side: "L", editable: true, selectable: true, tone: "white" },
    { key: "torwydata",    label: "TAKEOFF",    value: "<RWY DATA",   side: "L", editable: true, selectable: true, tone: "white" },
    { key: "_p1",          label: "",           value: "",             side: "L", editable: false },
    { key: "_p2",          label: "",           value: "",             side: "L", editable: false },
    { key: "acarsmenu",    label: "RETURN TO",  value: "<ACARS MENU", side: "L", editable: true, selectable: true, tone: "white" },
    // Both live now — landing performance comes from the naclandapp tables
    // (see LANDING_PERF_DESIGN.md). Greyed only when the OFP carries no
    // landing block at all.
    { key: "ldgconditions",label: "LANDING",    value: "CONDITIONS>", side: "R",
      editable: !!ldgData, selectable: true, tone: "white", dim: !ldgData, dimLabel: "LANDING COND" },
    { key: "_p3",          label: "",           value: "",             side: "R", editable: false },
    { key: "ldgrwydata",   label: "LANDING",    value: "RWY DATA>",   side: "R",
      editable: !!ldgData, selectable: true, tone: "white", dim: !ldgData, dimLabel: "LANDING RWY DATA" },
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
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("W/B REQUEST SENT", () => {
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
        return { text: "W/B DATA RECEIVED", error: false };
      });
      return;
    }
    if (key === "send") {
      if (!loadsheetReady) return { error: "COMPLETE LOADSHEET FIRST" };
      if (!cond1Ready) return { error: "COMPLETE T/O COND FIRST" };
      if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("T/O REQUEST SENT", handleExec);
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

  // ── ACARS LANDING CONDITIONS ──────────────────────────────────────────────
  const ldgRunwayIds = (ldgData?.runways ?? []).map(r => r.id);
  const destIcao = ldgData?.airport || xmlData?.dest_icao || "----";
  // LDW = ZFW + arrival fuel, in pounds. Derived, never entered.
  const ldwLb = (() => {
    const z = parseFloat(ldgZfw), f = parseFloat(arrFuel);
    if (!Number.isFinite(z) || !Number.isFinite(f)) return null;
    return Math.round(z * 1000 + f * 1000);
  })();
  const ldgReady = !!(
    [ldgRwy1, ldgRwy2, ldgRwy3].some(r => r.trim()) &&
    String(ldgWind).trim() && String(ldgOat).trim() && String(ldgQnh).trim() &&
    ldwLb != null && String(rwycc).trim()
  );

  function cycleLdgRwy(current, setter) {
    const opts = ["", ...ldgRunwayIds];
    setter(opts[(opts.indexOf(current) + 1) % opts.length]);
  }

  // Runs naclandapp's certified-table calculation for each requested runway.
  // The maths is local, but the crew-facing action is a DATALINK SEND* to
  // AeroData (POH p.9-86), so it goes through the same simulated round-trip
  // as the takeoff request — results appearing instantly gave the
  // implementation away.
  function computeLanding() {
    if (!ldgData) return { text: "NO LANDING DATA", error: true };
    const acType = toEjetAcType(xmlData?.icaocode, xmlData?.base_type);
    const wtLb = ldwLb ?? 0;
    const ids = [ldgRwy1, ldgRwy2, ldgRwy3].map(r => r.trim().toUpperCase()).filter(Boolean);
    const out = [];
    for (const id of ids) {
      const rwy = (ldgData.runways ?? []).find(r => r.id === id);
      if (!rwy) continue;
      const res = calculateLanding({
        acType,
        landingWeight: wtLb,
        flap: ldgFlap,
        reversers: ldgRev,
        vappAdd: parseFloat(ldgVappAdd) || 0,
        pressureAlt: pressureAltitude(rwy.elevation, ldgQnh),
        oatC: parseFloat(ldgOat) || 0,
        // SimBrief gives the headwind component per runway directly, which is
        // more accurate than re-deriving it from the wind entry.
        headwind: Number(rwy.headwind) || 0,
        brakingAction: parseInt(rwycc, 10) || 6,
        slopePct: Number(rwy.gradient) || 0,
      });
      out.push({ rwy, acType, result: res, weightLb: wtLb });
    }
    if (!out.length) return { text: "NO RUNWAY MATCH", error: true };
    setLdgResults(out);
    setLdgPageIndex(0);
    setPage("LANDDATA");
    return { text: "LANDING DATA AVAIL", error: false };
  }

  function handleLdgCondCommit(key, value) {
    if (key === "perfwb" || key === "ldgreturn") { setPage("PERFWB"); return; }
    if (key === "ldgairport") {
      if (value === DELETE_TOKEN) { setLdgAirport(""); return; }
      const v = String(value).toUpperCase();
      if (!/^[A-Z]{4}$/.test(v)) return { error: "INVALID ENTRY" };
      // POH p.9-83 LSK 1R: "A new airport may be entered in case of a
      // diversion." We have no runway data for an airport outside the OFP, so
      // say so rather than silently computing against the wrong runways.
      if (v !== destIcao) return { error: "NO RWY DATA FOR ARPT" };
      setLdgAirport(v);
      return;
    }
    if (key === "ldgsurface") {
      // Separate from BRK ACTION RPT — AeroData takes the more conservative
      // of the two (POH p.9-81), and crews are told to set braking action
      // first and leave surface alone.
      const opts = ["DRY", "WET", "COMPACTED SNOW", "WET ICE"];
      if (value === null) { setLdgSurface(opts[(opts.indexOf(ldgSurface) + 1) % opts.length]); return; }
      if (value === DELETE_TOKEN) { setLdgSurface("DRY"); return; }
      const v = String(value).toUpperCase();
      if (!opts.includes(v)) return { error: "INVALID ENTRY" };
      setLdgSurface(v);
      return;
    }
    if (key === "ldgrwy1" || key === "ldgrwy2" || key === "ldgrwy3") {
      const setter = key === "ldgrwy1" ? setLdgRwy1 : key === "ldgrwy2" ? setLdgRwy2 : setLdgRwy3;
      const cur = key === "ldgrwy1" ? ldgRwy1 : key === "ldgrwy2" ? ldgRwy2 : ldgRwy3;
      if (value === null) { cycleLdgRwy(cur, setter); return; }
      if (value === DELETE_TOKEN) { setter(""); return; }
      const v = String(value).toUpperCase();
      if (!ldgRunwayIds.includes(v)) return { error: "INVALID ENTRY" };
      setter(v);
      return;
    }
    if (key === "rwycc") {
      // TALPA RCAM code. NEVER inferred from SimBrief's surface_condition —
      // the code comes from the airport operator, and guessing it would be
      // inventing safety-relevant data. Cycles 6..1, blank until chosen.
      if (value === null) {
        const codes = RWYCC_OPTIONS.map(o => String(o.value));
        const i = codes.indexOf(String(rwycc));
        setRwycc(codes[(i + 1) % codes.length]);
        return;
      }
      if (value === DELETE_TOKEN) { setRwycc(""); return; }
      const n = parseInt(value, 10);
      if (!RWYCC_OPTIONS.some(o => o.value === n)) return { error: "INVALID ENTRY" };
      setRwycc(String(n));
      return;
    }
    if (key === "ldgflap") {
      if (value === null) { setLdgFlap(f => (f === "Full" ? "5" : "Full")); return; }
      const v = String(value).toUpperCase();
      if (v === "FULL") setLdgFlap("Full");
      else if (v === "5") setLdgFlap("5");
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "ldgrev") {
      if (value === null) { setLdgRev(r => (r === "Both" ? "None" : "Both")); return; }
      const v = String(value).toUpperCase();
      if (v === "BOTH") setLdgRev("Both");
      else if (v === "NONE") setLdgRev("None");
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "ldgwind") { setLdgWind(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "ldgzfw" || key === "arrfuel") {
      const setter = key === "ldgzfw" ? setLdgZfw : setArrFuel;
      if (value === DELETE_TOKEN) { setter(""); return; }
      const lb = parseWeightLb(value);
      if (lb == null) return { error: "INVALID ENTRY" };
      setter(fmtWeightK(lb));
      return;
    }
    if (key === "ldgoatqnh") {
      if (value === DELETE_TOKEN) { setLdgOat(""); setLdgQnh(""); return; }
      const [o, q] = String(value).split("/");
      if (o === undefined || q === undefined) return { error: "INVALID ENTRY" };
      if (!/^-?\d{1,3}$/.test(o.trim())) return { error: "INVALID ENTRY" };
      const qt = q.trim();
      let qOut;
      if (/^\d{2}\.\d{1,2}$/.test(qt)) qOut = qt;
      else if (/^\d{4}$/.test(qt) && /^[23]/.test(qt)) qOut = `${qt.slice(0, 2)}.${qt.slice(2)}`;
      else if (/^\d{3,4}$/.test(qt)) qOut = qt;
      else return { error: "INVALID ENTRY" };
      setLdgOat(o.trim()); setLdgQnh(qOut);
      return;
    }
    if (key === "ldgdata") {
      if (!ldgResults) return { error: "PRESS COMPUTE FIRST" };
      setLdgPageIndex(0); setPage("LANDDATA");
      return;
    }
    if (key === "compute") {
      if (!ldgReady) {
        // Pull what the OFP already knows; RwyCC stays blank on purpose.
        if (!ldgData) return { error: "NO FLIGHT PLAN" };
        if (!ldgRwy1 && ldgData.planned_runway) setLdgRwy1(ldgData.planned_runway);
        if (!String(ldgWind).trim() && ldgData.wind_direction != null)
          setLdgWind(`${String(Math.round(ldgData.wind_direction)).padStart(3, "0")}/${Math.round(ldgData.wind_speed || 0)}`);
        if (!String(ldgOat).trim() && ldgData.temperature != null) setLdgOat(String(Math.round(ldgData.temperature)));
        if (!String(ldgQnh).trim() && ldgData.altimeter) setLdgQnh(ldgData.altimeter);
        // Seed ZFW from the OFP and back out arrival fuel from its planned
        // landing weight, so the derived LDW matches what SimBrief planned.
        const ofpZfw = Number(xmlData?.est_zfw_xml) || 0;
        if (!String(ldgZfw).trim() && ofpZfw) setLdgZfw(fmtWeightK(ofpZfw));
        if (!String(arrFuel).trim() && ldgData.planned_weight && ofpZfw) {
          const f = Number(ldgData.planned_weight) - ofpZfw;
          if (f > 0) setArrFuel(fmtWeightK(f));
        }
        return { error: "LDG DATA LOADED - SET RWYCC" };
      }
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("LAND REQUEST SENT", computeLanding);
      return;
    }
  }

  // POH p.9-80 layout exactly:
  //   1L RWY 1        1R AIRPORT
  //   2L RWY 2        2R WIND
  //   3L RWY 3        3R OAT/QNH
  //   4L SURFACE      4R LDW
  //   5L BRK ACTN RPT 5R LAND DATA>
  //   6L <RETURN      6R DATALINK SEND*
  // LDW is a direct entry on the real page, but per your reference tool it's
  // derived from ZFW + ARR FUEL (entered on 2/2) and shown green here.
  const ldgCondFields = ldgData ? [
    { key: "ldgrwy1", label: "RWY 1", value: ldgRwy1, side: "L", row: 0, editable: true, cyclable: true, tone: "amber", boxes: "000" },
    { key: "ldgrwy2", label: "RWY 2", value: ldgRwy2, side: "L", row: 1, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgrwy3", label: "RWY 3", value: ldgRwy3, side: "L", row: 2, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgsurface", label: "SURFACE", value: ldgSurface, side: "L", row: 3, editable: true, cyclable: true, tone: "cyan" },
    { key: "rwycc",   label: "BRK ACTION RPT",
      value: rwycc ? (RWYCC_OPTIONS.find(o => String(o.value) === rwycc)?.label || rwycc).split(" - ")[1] || rwycc : "NONE",
      side: "L", row: 4, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgreturn", label: "", value: "<RETURN", side: "L", row: 5, editable: true, selectable: true, tone: "white" },
    { key: "ldgairport", label: "AIRPORT", value: ldgAirport || destIcao, side: "R", row: 0, editable: true, tone: "amber", boxes: "0000" },
    { key: "ldgwind", label: "WIND", value: String(ldgWind), side: "R", row: 1, editable: true, tone: "cyan", boxes: "000/00" },
    { key: "ldgoatqnh", label: "OAT/QNH", value: ldgOat || ldgQnh ? `${ldgOat}/${ldgQnh}` : "", side: "R", row: 2, editable: true, tone: "cyan", boxes: "000/00.00" },
    { key: "ldw", label: "LDW", value: ldwLb != null ? fmtWeightK(ldwLb) : "", side: "R", row: 3, editable: false, tone: "green" },
    { key: "ldgdata", label: "LAND", value: "DATA>", side: "R", row: 4, editable: true, selectable: true, tone: "white" },
    { key: "compute", label: "DATALINK", value: ldgReady ? "SEND*" : "REQUEST*",
      side: "R", row: 5, editable: true, selectable: true, tone: ldgReady ? "white" : "amber" },
  ] : [];

  // ── ACARS LDG CONDITIONS 2/2 — config that doesn't fit on 1/2 ─────────────
  // The real tool's page reads "1/2", so a second page is where the remaining
  // configuration belongs. REVERSERS materially changes landing distance, so
  // it stays an explicit crew selection rather than a hidden default.
  function handleLdgCond2Commit(key, value) {
    if (key === "ldgreturn") { setPage("LANDCOND"); return; }
    if (key === "compute") return handleLdgCondCommit("compute", value);
    if (key === "ldgzfw" || key === "arrfuel") return handleLdgCondCommit(key, value);
    // POH p.9-85 toggles. FLAP is 5 / FULL; the rest are two-state.
    const toggles = {
      ldgflap:    { states: ["5", "Full"], set: setLdgFlap, cur: ldgFlap,
                    accept: v => (v === "FULL" ? "Full" : v === "5" ? "5" : null) },
      ldgvis:     { states: ["NORMAL", "LOW VIS"], set: setLdgVis, cur: ldgVis,
                    accept: v => (["NORMAL", "LOW VIS", "LOWVIS"].includes(v) ? (v === "NORMAL" ? "NORMAL" : "LOW VIS") : null) },
      ldgantiice: { states: ["OFF", "ALL"], set: setLdgAntiIce, cur: ldgAntiIce,
                    accept: v => (["OFF", "ALL"].includes(v) ? v : null) },
      ldgstall:   { states: ["NO", "YES"], set: setLdgStallIce, cur: ldgStallIce,
                    accept: v => (["NO", "YES"].includes(v) ? v : null) },
    };
    const t = toggles[key];
    if (t) {
      if (value === null) { t.set(t.states[(t.states.indexOf(t.cur) + 1) % t.states.length]); return; }
      if (value === DELETE_TOKEN) { t.set(t.states[0]); return; }
      const v = t.accept(String(value).toUpperCase());
      if (!v) return { error: "INVALID ENTRY" };
      t.set(v);
      return;
    }
    if (key === "ldgrev") {
      if (value === null) { setLdgRev(r => (r === "Both" ? "None" : "Both")); return; }
      const v = String(value).toUpperCase();
      if (v === "BOTH") setLdgRev("Both");
      else if (v === "NONE") setLdgRev("None");
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "vappadd") {
      if (value === DELETE_TOKEN) { setLdgVappAdd("5"); return; }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0 || n > 30) return { error: "INVALID ENTRY" };
      setLdgVappAdd(String(n));
      return;
    }
  }

  // POH p.9-85: FLAP / VISIBILITY / ANTI-ICE / STALL PROT ICE SPEED down the
  // left, <RETURN at 6L, DATALINK SEND at 6R. ZFW and ARR FUEL are ours —
  // they're what derive LDW on page 1/2 — and take the free right-hand slots.
  const ldgCond2Fields = ldgData ? [
    { key: "ldgflap",   label: "FLAP",       value: ldgFlap === "Full" ? "FULL" : ldgFlap, side: "L", row: 0, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgvis",    label: "VISIBILITY", value: ldgVis,      side: "L", row: 1, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgantiice",label: "ANTI-ICE",   value: ldgAntiIce,  side: "L", row: 2, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgstall",  label: "STALL PROT ICE SPEED", value: ldgStallIce, side: "L", row: 3, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgrev",    label: "REVERSERS",  value: ldgRev.toUpperCase(), side: "L", row: 4, editable: true, cyclable: true, tone: "cyan" },
    { key: "ldgreturn", label: "",           value: "<RETURN",   side: "L", row: 5, editable: true, selectable: true, tone: "white" },
    { key: "ldgzfw",    label: "ZFW",        value: ldgZfw,      side: "R", row: 0, editable: true, tone: "amber", boxes: "000.0" },
    { key: "arrfuel",   label: "ARR FUEL",   value: arrFuel,     side: "R", row: 1, editable: true, tone: "amber", boxes: "00.0" },
    { key: "vappadd",   label: "VAPP = VREF+", value: ldgVappAdd, side: "R", row: 2, editable: true, tone: "cyan" },
    { key: "compute",   label: "DATALINK",   value: ldgReady ? "SEND*" : "REQUEST*",
      side: "R", row: 5, editable: true, selectable: true, tone: ldgReady ? "white" : "amber" },
  ] : [];

  // ── ACARS LAND RWY DATA (POH p.9-87 to 9-89) ──────────────────────────────
  // Page 1/5 is the request summary, 2/5 REMARKS, and 3/5-5/5 one identical
  // page per requested runway.

  // FACTORED vs UNFACTORED (POH p.9-89/9-90):
  //   UNFACTORED — actual landing distance for the conditions. Assumes
  //     touchdown 1,000 ft in, max wheel braking, NO reverser credit. This is
  //     what controls once airborne, except on a slippery runway.
  //   FACTORED — the dispatch distance per 14 CFR 121.195: the runway must be
  //     at least 60% dry, with a further 15% for wet/slippery. Controls for
  //     dispatch, and on a slippery runway it also controls in flight.
  // naclandapp returns the actual (unfactored) figure, so the factored one is
  // derived here by the same rule the report states.
  function factoredDistance(actual, rwyccCode) {
    if (actual == null) return null;
    const dry = actual / 0.6;                 // 60% rule
    return Math.round(rwyccCode >= 5 ? dry : dry * 1.15); // +15% wet/slippery
  }

  function buildLdgSummaryFields() {
    const t = new Date();
    const z = `${String(t.getUTCHours()).padStart(2, "0")}${String(t.getUTCMinutes()).padStart(2, "0")}Z`;
    return [
      { key: "flt",  label: "FLT NO", value: fltNoEntry || String(xmlData?.flight_number ?? ""), side: "L", row: 0, editable: false, tone: "green" },
      { key: "ldw",  label: "LDW",    value: ldwLb != null ? fmtWeightK(ldwLb) : "---", side: "C", row: 0, editable: false, tone: "green" },
      { key: "time", label: "TIME",   value: z, side: "R", row: 0, editable: false, tone: "green" },
      { key: "wind", label: "WIND",   value: String(ldgWind || "---"), side: "L", row: 1, editable: false, tone: "green" },
      { key: "oat",  label: "OAT C",  value: String(ldgOat || "--"), side: "C", row: 1, editable: false, tone: "green" },
      { key: "qnh",  label: "QNH",    value: String(ldgQnh || "-----"), side: "R", row: 1, editable: false, tone: "green" },
      { key: "ret",  label: "",       value: "<RETURN", side: "L", row: 5, editable: true, selectable: true, tone: "white" },
    ];
  }

  // 2/5 — REMARKS. "NONE" when there's nothing to report, per the POH example.
  function buildLdgRemarksFields() {
    const notes = [];
    if (ldgRev === "None") notes.push("NO THRUST REVERSER CREDIT");
    if (ldgVis === "LOW VIS") notes.push("LOW VISIBILITY");
    if (ldgAntiIce === "ALL") notes.push("ANTI-ICE ALL");
    if (ldgStallIce === "YES") notes.push("STALL PROT ICE SPEED");
    if ((parseInt(rwycc, 10) || 6) < 6) notes.push("ADVISORY ONLY - NOT CERTIFIED");
    return [
      { key: "hdr", label: "REMARKS", value: notes[0] || "NONE", side: "C", row: 0, span: true, editable: false, tone: "green" },
      ...notes.slice(1, 5).map((n, i) => ({
        key: `rm${i}`, label: "", value: n, side: "C", row: i + 1, span: true, editable: false, tone: "green",
      })),
      { key: "ret", label: "", value: "<RETURN", side: "L", row: 5, editable: true, selectable: true, tone: "white" },
    ];
  }

  // 3/5+ — per runway, laid out exactly as POH p.9-89:
  //   CYEG 20                11000
  //                          -0.13
  //   ECS ON
  //   FLAP   MLDW/LIM    VRF 128
  //   5      82.0 /S     VAP ---
  //          ALDW        VAC ---
  //          63.0        VFS 177
  //   FACTORED DIST      4361FT
  //   UNFACTORED DIST    2616FT
  function buildLdgFields(entry) {
    const { rwy, result, weightLb } = entry;
    const sp = result?.speeds ?? {};
    const unfactored = result?.primaryDist ?? null;
    const cc = parseInt(rwycc, 10) || 6;
    const factored = factoredDistance(unfactored, cc);
    const lda = Number(rwy.lda) || 0;
    // MLDW / LIM — max landing weight and its limit code. SimBrief gives the
    // structural figure per runway; "S" marks it as structurally limited.
    const maxWt = cc >= 5 ? rwy.max_weight_dry : rwy.max_weight_wet;
    const overWeight = maxWt && weightLb > Number(maxWt);
    // Dispatch check is against the FACTORED distance (121.195).
    const overrun = factored != null && lda > 0 && factored > lda;
    // Laid out on the 3-column grid, same style as the takeoff runway data
    // page — labelled fields, not a monospace dump. Distances carry no
    // thousands separator: the real screen shows "4361FT".
    const ft = (v) => (v != null ? `${Math.round(v)}FT` : "----");
    return [
      { key: "hdr", label: "RUNWAY / LDA", value: `${destIcao} ${rwy.id}   ${Math.round(lda)}FT`,
        side: "C", row: 0, span: true, editable: false, tone: "green" },
      { key: "cond", label: `${ldgAntiIce === "ALL" ? "ECS ON" : "ECS OFF"}   GRAD`,
        value: `${Number(rwy.gradient) >= 0 ? "" : "-"}${Math.abs(Number(rwy.gradient) || 0).toFixed(2)}`,
        side: "C", row: 1, span: true, editable: false, tone: "green" },
      { key: "flap", label: "FLAP",     value: ldgFlap === "Full" ? "FULL" : ldgFlap, side: "L", row: 2, editable: false, tone: "green" },
      { key: "mldw", label: "MLDW/LIM", value: maxWt ? `${fmtWeightK(Number(maxWt))}/S` : "---", side: "C", row: 2, editable: false,
        tone: overWeight ? "amber" : "green", error: overWeight },
      { key: "vrf",  label: "VRF",      value: sp.vref != null ? String(sp.vref) : "---", side: "R", row: 2, editable: false, tone: "green" },
      { key: "aldw", label: "ALDW",     value: ldwLb != null ? fmtWeightK(ldwLb) : "---", side: "L", row: 3, editable: false, tone: "green" },
      { key: "fact", label: "FACTORED DIST", value: ft(factored), side: "C", row: 3, editable: false,
        tone: overrun ? "amber" : "green", error: overrun },
      { key: "vap",  label: "VAP",      value: sp.vapp != null ? String(sp.vapp) : "---", side: "R", row: 3, editable: false, tone: "green" },
      { key: "unfact", label: "UNFACTORED DIST", value: ft(unfactored), side: "C", row: 4, editable: false, tone: "green" },
      { key: "vac",  label: "VAC",      value: sp.vac != null ? String(sp.vac) : "---", side: "R", row: 4, editable: false, tone: "green" },
      { key: "ret",  label: "",         value: "<RETURN", side: "L", row: 5, editable: true, selectable: true, tone: "white" },
      { key: "vfs",  label: "VFS",      value: sp.vfs != null ? String(sp.vfs) : "---", side: "R", row: 5, editable: false, tone: "green" },
    ];
  }

  const ldgPages = ldgResults ? [
    { title: "ACARS LAND RWY DATA", fields: buildLdgSummaryFields() },
    { title: "ACARS LAND RWY DATA", fields: buildLdgRemarksFields() },
    ...ldgResults.map(e => ({ title: "ACARS LAND RWY DATA", fields: buildLdgFields(e) })),
  ] : [];

  // Posted to the scratchpad, as on the takeoff side (POH p.9-87).
  const ldgMessage = ldgResults
    ? { text: "LANDING DATA AVAIL", error: false }
    : { text: "NO LANDING DATA AVAIL", error: true };

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

      // AUTO INIT populates NOTHING visible. The OFP is held in state for the
      // downstream request and for the DATA REQ*/W/B REQ* buttons; every entry
      // field on every page stays exactly as the crew left it (blank until
      // typed). Auto-filling weather and runway here was hiding the difference
      // between what was entered and what was assumed.
      setRunway1(""); setRunway2(""); setRunway3("");
      setSurface("PLANNED");
      setFlapSel("OPTIMUM");
      setAntiIce(false);
      setForceMax(false);
      setOat(""); setQnh(""); setWind(""); setPtow(""); setRelVersion("");
      setTpsResult(null);
      setPrintPageIndex(0);

      // The uplink fills in everything the crew DIDN'T have to type: SKED DAY
      // and FUEL QTY come back from the request. The four fields required to
      // make the request in the first place (FLT NO, DEP, DEST, CAPT ID) are
      // left exactly as entered.
      if (!skedDay.trim()) {
        const d = data.date_day ?? new Date().getUTCDate();
        setSkedDay(String(d));
      }
      // FUEL QTY always takes the newly uplinked figure — it belongs to the
      // route that just came back, so keeping a previous route's number here
      // would be wrong rather than merely stale.
      if (data.plan_ramp_xml) setFuelQty(fmtWeightK(Number(data.plan_ramp_xml)));

      // Stay on INITIALIZE — the crew confirms the fetched data here and
      // navigates on deliberately.
      setIdentStatus("");
      setIdentStatusErr(false);
      return { text: "INIT COMPLETE", error: false };
    } catch (e) {
      setIdentStatus("");
      setIdentStatusErr(false);
      // Show the backend's `detail` (the actual exception) when there is one —
      // the bare top-level message alone gives nothing to diagnose from.
      if (e instanceof ApiError) {
        console.error("[PWB] flightplan fetch failed:", e.message, e.detail);
        return { text: String(e.detail || e.message).toUpperCase().slice(0, 40), error: true };
      }
      return { text: "COULD NOT REACH SERVER", error: true };
    } finally {
      setLoadingPlan(false);
    }
    // Reads skedDay/fuelQty to avoid overwriting anything already typed, so
    // they must be dependencies — with an empty array this would close over
    // their initial (blank) values and clobber crew entries.
  }, [skedDay]);

  // ACARS INITIALIZE — laid out exactly as POH p.9-62:
  //   1L FLT NO       | XPDR FLT ID (centre) |  1R SKED DAY
  //   2L DEP          |                      |  2R DEST
  //   3L FUEL QTY     |                      |  3R BD FUEL
  //   4L CAPT ID      |                      |  4R CREW-3 ID
  //   5L F/O ID       |                      |  5R CREW-4 ID
  //   6L <RETURN      |                      |  6R DATALINK AUTO INIT*
  // CAPT ID doubles as the SimBrief credential — it takes either a username
  // or a numeric SimBrief pilot ID, which is what AUTO INIT* then fetches
  // with. The remaining crew-ID slots are "no entry made" on the real page.
  function handleIdentCommit(key, value) {
    if (key === "captid") {
      if (value === null) return;
      if (value === DELETE_TOKEN) { setSimbriefUsername(""); return; }
      // Either a SimBrief username or a numeric SimBrief pilot ID.
      if (!/^[A-Za-z0-9_\-.]{1,24}$/.test(value)) return { error: "INVALID ENTRY" };
      setSimbriefUsername(value);
      return;
    }
    if (key === "dep" || key === "dest") {
      const setter = key === "dep" ? setDepEntry : setDestEntry;
      const current = key === "dep" ? depEntry : destEntry;
      if (value === DELETE_TOKEN) { setter(""); return; }
      const v = String(value).toUpperCase();
      if (!/^[A-Z]{4}$/.test(v)) return { error: "INVALID ENTRY" };
      // Changing a station invalidates everything downstream — runway list,
      // conditions, loadsheet and any computed result all belong to the old
      // city pair. Wipe them rather than leaving stale data on the pages.
      if (current && current !== v) {
        clearFlightData();
        setter(v);
        return { error: "DATA CLEARED - RE-INIT" };
      }
      setter(v);
      setXmlData(d => (d ? { ...d, [key === "dep" ? "origin_icao" : "dest_icao"]: v } : d));
      return;
    }
    if (key === "fltno") {
      if (value === DELETE_TOKEN) { setFltNoEntry(""); return; }
      if (!/^[A-Za-z0-9]{1,7}$/.test(value)) return { error: "INVALID ENTRY" };
      setFltNoEntry(String(value).toUpperCase());
      return;
    }
    if (key === "skedday") {
      if (value === DELETE_TOKEN) { setSkedDay(""); return; }
      const d = parseInt(value, 10);
      if (!Number.isFinite(d) || d < 1 || d > 31) return { error: "INVALID ENTRY" };
      setSkedDay(String(d));
      return;
    }
    if (key === "fuel") {
      if (value === DELETE_TOKEN) { setFuelQty(""); return; }
      const lb = parseWeightLb(value);
      if (lb == null) return { error: "INVALID ENTRY" };
      setFuelQty(fmtWeightK(lb));
      return;
    }
    if (key === "return") { setPage("PREFLIGHT"); return; }
    if (key === "autoinit") {
      // CAPT ID supplies the SimBrief credential; DEP and DEST must both be
      // entered first, as on the real page.
      const u = simbriefUsername.trim();
      if (!u) return { error: "ENTER CAPT ID" };
      if (!depEntry.trim()) return { error: "ENTER DEP" };
      if (!destEntry.trim()) return { error: "ENTER DEST" };
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("INIT REQUEST SENT", () => doFetch(u));
      return;
    }
  }

  // Every line here is a crew entry — nothing is filled in by AUTO INIT.
  const identFields = [
    { key: "fltno",  label: "FLT NO",   value: fltNoEntry, side: "L", editable: true, tone: "amber", boxes: "0000" },
    { key: "dep",    label: "DEP",      value: depEntry,   side: "L", editable: true, tone: "amber", boxes: "0000" },
    { key: "fuel",   label: "FUEL QTY", value: fuelQty,    side: "L", editable: true, tone: "cyan" },
    { key: "captid", label: "CAPT ID",  value: simbriefUsername, side: "L", editable: true, tone: "amber", boxes: "000000" },
    { key: "foid",   label: "F/O ID",   value: "", side: "L", dim: true, dimLabel: "F/O ID" },
    { key: "return", label: "",         value: "<RETURN", side: "L", editable: true, selectable: true, tone: "white" },
    { key: "skedday",label: "SKED DAY", value: skedDay,    side: "R", editable: true, tone: "amber", boxes: "00" },
    { key: "dest",   label: "DEST",     value: destEntry,  side: "R", editable: true, tone: "amber", boxes: "0000" },
    { key: "bdfuel", label: "BD FUEL",  value: "", side: "R", dim: true, dimLabel: "BD FUEL" },
    { key: "crew3",  label: "CREW-3 ID",value: "", side: "R", dim: true, dimLabel: "CREW-3 ID" },
    { key: "crew4",  label: "CREW-4 ID",value: "", side: "R", dim: true, dimLabel: "CREW-4 ID" },
    // POH p.9-62 LSK 6R — sends the downlink request for the flight data.
    { key: "autoinit", label: "DATALINK", value: "AUTO INIT*", side: "R", editable: true, selectable: true, tone: "white" },
    { key: "xpdr",   label: "XPDR FLT ID", value: "????????", side: "C", row: 0, editable: false, tone: "green" },
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
    // One key, two jobs, matching its own label: while anything mandatory is
    // still blank it reads REQUEST* and pulls the OFP's planned values in;
    // once everything is filled it reads SEND> and transmits.
    if (key === "send") {
      if (!cond1Ready) {
        if (!xmlData) return { error: "NO FLIGHT PLAN" };
        if (!runway1 && xmlData.plan_rwy && runwayIds.includes(xmlData.plan_rwy)) setRunway1(xmlData.plan_rwy);
        if (!String(wind).trim()) setWind(xmlData.wind ?? "");
        if (!String(oat).trim()) setOat(xmlData.temp ?? "");
        if (!String(qnh).trim()) setQnh(xmlData.qnh ?? "");
        if (!String(ptow).trim() && xmlData.est_tow_xml) setPtow(fmtWeightK(Number(xmlData.est_tow_xml)));
        // RLS VERSION is deliberately NOT uplinked — the crew reads it off
        // the paper release. Filling it from the same OFP it's checked
        // against would make the cross-check meaningless.
        return { error: "REQUEST DATA LOADED" };
      }
      // AeroData won't compute against a stale release — this is the ONLY
      // point the release version is checked; entry itself never rejects.
      if (!relOk) return { error: `RLS MISMATCH - OFP ${ofpRelease}` };
      if (!loadsheetReady) return { error: "COMPLETE LOADSHEET FIRST" };
      if (uplinkBusy) return { error: "REQUEST PENDING" };
      runDatalink("T/O REQUEST SENT", handleExec);
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
      if (value === DELETE_TOKEN) { setOat(""); setQnh(""); return; }
      const [o, q] = String(value).split("/");
      if (o === undefined || q === undefined) return { error: "INVALID ENTRY" };
      if (!/^-?\d{1,3}$/.test(o.trim())) return { error: "INVALID ENTRY" };
      // QNH takes "29.92" or "2992" (inHg), or a 3-4 digit hPa value such as
      // "1013" — anything without a decimal and 4 digits starting 2 or 3 is
      // read as inHg, otherwise it's left as typed.
      const qt = q.trim();
      let qOut;
      if (/^\d{2}\.\d{1,2}$/.test(qt)) qOut = qt;
      else if (/^\d{4}$/.test(qt) && /^[23]/.test(qt)) qOut = `${qt.slice(0, 2)}.${qt.slice(2)}`;
      else if (/^\d{3,4}$/.test(qt)) qOut = qt; // hPa
      else return { error: "INVALID ENTRY" };
      setOat(o.trim()); setQnh(qOut);
      return;
    }
  }

  // "KLAX" on the real screen isn't a literal word — it's the departure
  // airport's ICAO code shown above each entry line, confirming which
  // airport RWY 1/2/3 apply to. Render it from the loaded flight plan.
  const depIcao = xmlData?.origin_icao || "----";
  // Every mandatory entry on the conditions page. Drives the REQUEST*/SEND>
  // label as well as the send gate itself, so the two can't disagree.
  const cond1Ready = !!(
    [runway1, runway2, runway3].some(r => r.trim()) &&
    String(wind).trim() && String(oat).trim() && String(qnh).trim() &&
    String(ptow).trim() && relVersion.trim()
  );
  // POH p.9-71 LSK 3R: PTOW is only for planning "prior to receiving the
  // loadsheet" — the real system uses loadsheet data on any subsequent
  // request. So takeoff data can't be requested until the loadsheet's
  // mandatory entries (AD/CH A-C and T/O FUEL) are in.
  const loadsheetReady = !!(
    adChA.trim() && adChB.trim() && adChC.trim() && String(toFuel).trim()
  );
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
    // RWY 1, WIND, OAT/QNH and PTOW are all required — amber entry boxes,
    // blank until the crew fills them.
    { key: "wind",     label: "WIND",     value: String(wind),      side: "R", editable: true, tone: "amber", boxes: "000/00" },
    { key: "oatqnh",   label: "OAT/QNH",  value: oat || qnh ? `${oat}/${qnh}` : "", side: "R", editable: true, tone: "amber", boxes: "000/00.00" },
    { key: "ptow",     label: "PTOW",     value: ptow,              side: "R", editable: true, tone: "amber", boxes: "000.0" },
    { key: "gotols",   label: "W&B",      value: "LOADSHEET>",      side: "R", editable: true, selectable: true, tone: "white" },
    { key: "gotodata", label: "T/O",      value: "DATA>",           side: "R", editable: true, selectable: true, tone: "white" },
    // Reads REQUEST* until every required field is in, then becomes SEND> —
    // so the key itself shows whether the request is ready to go.
    { key: "send",     label: "",         value: cond1Ready ? "SEND>" : "REQUEST*",
      side: "R", editable: true, selectable: true, tone: cond1Ready ? "white" : "amber" },
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
      // Accepted without complaint — a mismatch is only rejected at SEND,
      // not while the crew is still typing.
      setRelVersion(value);
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
    setPerfStatus("");
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
      return { text: "TAKEOFF DATA AVAIL", error: false };
    } catch (e) {
      setPerfStatus("");
      setPerfStatusErr(false);
      return {
        text: e instanceof ApiError ? e.message.toUpperCase() : "NO TAKEOFF DATA AVAIL",
        error: true,
      };
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
      { key: "hdr", label: "", value: "REMARKS", side: "C", row: 0, span: true, editable: false, tone: "green" },
      ...lines.slice(0, 5).map((rl, i) => ({
        key: `rl${i}`, label: "", value: rl, side: "C", row: i + 1, span: true, editable: false, tone: "green",
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
  // Full-width rows on the grid rather than the loose block, so the text sits
  // in the body of the screen at normal size instead of being squeezed tiny
  // against the header. "SPECIAL" is the row-0 heading, not a stray left label.
  const acarsEfpFields = efpText ? (() => {
    const lines = wrapText(efpText, 22);
    return [
      { key: "efphdr", label: "", value: "SPECIAL", side: "C", row: 0, span: true, editable: false, tone: "green" },
      ...lines.slice(0, 5).map((l, i) => ({
        key: `efp${i}`, label: "", value: l, side: "C", row: i + 1, span: true, editable: false, tone: "green",
      })),
    ];
  })() : [];

  // Field set matches a live-generated TAKEOFF PERFORMANCE block exactly:
  // left = FLEX/FLAP/STAB, right = V1/VR/V2/VFS, center = airport+runway+
  // length, MRTW/LIM, MTOW, GTOW/CG, ACCEL. One of these per runway result.
  // Same packed-row/tight technique as acarsSummaryFields (see comment
  // above it) — keeps this page from overflowing the fixed-height screen.
  // Laid out to match the printed AERODATA runway block line for line:
  //
  //   KAUS 18L            9000
  //   DT H175  OAT  26   -0.20
  //    FLEX - TO1   - ECS ON
  //   FLEX    MRTW/LIM  V1 129
  //   40      85.0/A    VR 129
  //   FLAP      MTOW    V2 134
  //   2         85.1   VFS 180
  //   STAB    GTOW/CG    ACCEL
  //   ---     65.1/25.0   1492
  //
  // The three header lines (station/runway/length, departure track + OAT +
  // slope, and the FLEX/thrust-rating/bleed strip) were missing entirely.
  // Rendered as full-width monospace text rather than on the LSK grid — this
  // page is read-only, so column alignment matters more than LSK alignment.
  // Field set per POH p.9-78: a top section identifying the runway request,
  // then FLEX, MRTW/LIM, FLAP, MTOW, STAB, GTOW/CG, V1/VR/V2/VFS and ACCEL.
  // Rendered as proper labelled fields on the 3-column grid rather than as a
  // monospace dump — the raw-text version had the right columns but was far
  // too small to read on the screen.
  function buildPerfFields(rd) {
    const vfsLbl = rd.vfs_label || "VFS";
    const vfs = rd.vfs != null ? String(rd.vfs) : "---";
    const kind = rd.format_kind || "ejet";

    // Departure-track strip. AERODATA writes "LT/DT Hxxx OAT nn s.ss" — LT
    // for an upslope runway, DT for down — but replaces the whole line with
    // "SPECIAL" plus the FRA code when the airport has EFP text. The old
    // version hardcoded "DT" and never showed SPECIAL at all.
    const dtLine = rd.efp_text
      ? `SPECIAL${rd.fra_code ? `   FRA ${rd.fra_code}` : ""}`
      : `${rd.dt_lt || "DT"} H${String(rd.mc ?? 0).padStart(3, "0")}  OAT ${rd.oat ?? ""}` +
        (rd.slope != null && rd.slope !== "" ? `  ${Number(rd.slope) >= 0 ? " " : ""}${Number(rd.slope).toFixed(2)}` : "");

    // Thrust/bleed strip — different wording per format, as in the report.
    const thrStrip =
      kind === "airbus" ? `${["--", "", "TOGA"].includes(String(rd.flex).trim()) ? "TOGA" : "FLEX"} - BLEEDS ON`
      : kind === "boeing" ? `${String(rd.thr || "TO").replace("D-TO", "TO").trim() || "TO"} - BLD ON`
      : kind === "erj" ? String(rd.thr || "TO1")
      : `FLEX - ${rd.thr || ""} - ${rd.third_col_label || "BLD"} ${rd.bleed || "ON"}`;

    // Header occupies two FULL-WIDTH rows, as in the printed report. Packing
    // station/runway/length, the departure-track line and the thrust strip
    // into one three-column row truncated all three ("10081FT" -> "1008").
    const head = [
      { key: "rwy", label: "RUNWAY / LENGTH", value: `${rd.airport} ${rd.runway}   ${rd.length}FT`,
        side: "C", row: 0, span: true, editable: false, tone: "green" },
      { key: "dt", label: dtLine, value: thrStrip,
        side: "C", row: 1, span: true, editable: false, tone: "green" },
    ];

    // AIRBUS — no MRTW/MTOW block at all; speeds carry their own right-hand
    // annotations and the page ends with the TR/ACC/EO altitudes.
    if (kind === "airbus") {
      return [
        ...head,
        { key: "v1",   label: "V1",       value: String(rd.v1), side: "L", editable: false, tone: "green" },
        { key: "vr",   label: "VR",       value: String(rd.vr), side: "L", editable: false, tone: "green" },
        { key: "v2",   label: "V2",       value: String(rd.v2), side: "L", editable: false, tone: "green" },
        { key: "flths",label: "FL/THS",   value: `${rd.flaps}/UP${String(rd.trim_stab || "").split(" ").pop() || "0.0"}`,
          side: "R", editable: false, tone: "green" },
        { key: "flex", label: "FLEX",     value: String(rd.flex), side: "R", editable: false, tone: "green" },
        { key: "alts", label: "TR / ACC / EO", value: `${rd.tr_alt} ${rd.acc_alt} ${rd.eo_alt}`,
          side: "C", row: 5, span: true, editable: false, tone: "green" },
      ];
    }

    // BOEING — FLAPS not FLEX in the left column, and SEL/OAT + PTOW/CG + N1
    // instead of the STAB/GTOW/ACCEL row.
    if (kind === "boeing") {
      return [
        ...head,
        { key: "flaps", label: "FLAPS",    value: String(rd.flaps), side: "L", editable: false, tone: "green" },
        { key: "mrtw",  label: "MRTW/LIM", value: String(rd.mrtw),  side: "C", row: 2, editable: false, tone: "green" },
        { key: "v1",    label: "V1",       value: String(rd.v1),    side: "R", editable: false, tone: "green" },
        { key: "stab",  label: "STAB",     value: String(rd.trim_stab), side: "L", editable: false, tone: "green" },
        { key: "mtow",  label: "MTOW",     value: String(rd.mtow),  side: "C", row: 3, editable: false, tone: "green" },
        { key: "vr",    label: "VR",       value: String(rd.vr),    side: "R", editable: false, tone: "green" },
        { key: "seloat",label: "SEL/OAT",  value: String(rd.sel_oat || ""), side: "L", editable: false, tone: "green" },
        { key: "ptow",  label: "PTOW/CG",  value: String(rd.gtow_cg), side: "C", row: 4, editable: false, tone: "green" },
        { key: "v2",    label: "V2",       value: String(rd.v2),    side: "R", editable: false, tone: "green" },
        ...(rd.n1 ? [{ key: "n1", label: rd.thr_label || "N1", value: String(rd.n1), side: "R", editable: false, tone: "green" }] : []),
      ];
    }

    // ERJ / E-JET — same skeleton; the ERJ adds V215 and reads its thrust
    // rating bare (TO1) where the E-Jets show the FLEX/ECS strip.
    return [
      ...head,
      // Explicit rows on the L/R fields too — rows 0-1 belong to the
      // full-width header, so these start at row 2.
      { key: "flex",  label: "FLEX",     value: String(rd.flex),      side: "L", row: 2, editable: false, tone: "green" },
      { key: "mrtw",  label: "MRTW/LIM", value: String(rd.mrtw),      side: "C", row: 2, editable: false, tone: "green" },
      { key: "v1",    label: "V1",       value: String(rd.v1),        side: "R", row: 2, editable: false, tone: "green" },
      { key: "flap",  label: rd.flap_label || "FLAP", value: String(rd.flaps), side: "L", row: 3, editable: false, tone: "green" },
      { key: "mtow",  label: "MTOW",     value: String(rd.mtow),      side: "C", row: 3, editable: false, tone: "green" },
      { key: "vr",    label: "VR",       value: String(rd.vr),        side: "R", row: 3, editable: false, tone: "green" },
      { key: "stab",  label: "STAB",     value: String(rd.trim_stab), side: "L", row: 4, editable: false, tone: "green" },
      { key: "gtow",  label: "GTOW/CG",  value: String(rd.gtow_cg),   side: "C", row: 4, editable: false, tone: "green" },
      { key: "v2",    label: "V2",       value: String(rd.v2),        side: "R", row: 4, editable: false, tone: "green" },
      { key: "accel", label: "ACCEL",    value: String(rd.acc_alt),   side: "L", row: 5, editable: false, tone: "green" },
      { key: "vfs",   label: vfsLbl,     value: vfs,                  side: "R", row: 5, editable: false, tone: "green" },
      ...(kind === "erj" && rd.v215 != null
        ? [{ key: "v215", label: "V215", value: String(rd.v215), side: "C", row: 5, editable: false, tone: "green" }]
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
      // DLK is the datalink/ACARS key — that's how this app is entered.
      // PERF is a core MCDU function and is deliberately NOT bound to it.
      onDlk: () => { setResetArmed(false); setPage("ACARSMENU"); },
    };
  } else if (page === "ACARSMENU") {
    cduProps = {
      title: "ACARS    MAIN MENU", pageNum: "",
      fields: acarsMenuFields,
      onFieldCommit: handleAcarsMenuCommit,
      execAvailable: false,
      onPrev: () => setPage("MENU"),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "PREFLIGHT") {
    cduProps = {
      title: "ACARS   PRE-FLIGHT", pageNum: "",
      fields: preflightFields,
      onFieldCommit: handlePreflightCommit,
      execAvailable: false,
      onPrev: () => setPage("ACARSMENU"),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "PERFWB") {
    cduProps = {
      title: "ACARS RWY PERF/W&B", pageNum: "",
      fields: perfWbFields,
      onFieldCommit: handlePerfWbCommit,
      execAvailable: false,
      onPrev: () => setPage("PREFLIGHT"),
      onNext: () => setPage("COND1"),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "LOADSHEET") {
    cduProps = {
      title: "ACARS   LOADSHEET", pageNum: "1/2",
      fields: loadsheetFields,
      onFieldCommit: handleLoadsheetCommit,
      execAvailable: false, // no EXEC key on this unit — send is LSK 6R SEND*
      onPrev: () => setPage("PERFWB"),
      onNext: () => setPage("PAXDETAIL"), // 1/2 -> 2/2
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "LANDCOND") {
    cduProps = {
      title: "ACARS    LAND COND", pageNum: "1/2",
      fields: ldgCondFields,
      onFieldCommit: handleLdgCondCommit,
      execAvailable: false,
      onPrev: () => setPage("PERFWB"),
      onNext: () => setPage("LANDCOND2"),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "LANDCOND2") {
    cduProps = {
      title: "ACARS    LAND COND", pageNum: "2/2",
      fields: ldgCond2Fields,
      onFieldCommit: handleLdgCond2Commit,
      execAvailable: false,
      onPrev: () => setPage("LANDCOND"),
      onNext: () => setPage("LANDCOND"),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "LANDDATA") {
    const cur = ldgPages[ldgPageIndex] ?? { title: "ACARS LDG RWY DATA", fields: [] };
    cduProps = {
      title: cur.title,
      pageNum: ldgPages.length ? `${ldgPageIndex + 1}/${ldgPages.length}` : "",
      fields: cur.fields,
      // Any RETURN line on any of the landing result pages goes back to the
      // conditions page.
      onFieldCommit: (k) => { if (k === "ret" || k === "ldgreturn") setPage("LANDCOND"); },
      execAvailable: false,
      message: ldgMessage,
      onPrev: () => {
        if (ldgPageIndex > 0) setLdgPageIndex(i => i - 1);
        else setPage("LANDCOND");
      },
      onNext: () => ldgPages.length && setLdgPageIndex(i => (i + 1) % ldgPages.length),
      onDlk: () => setPage("ACARSMENU"),
    };
  } else if (page === "PAXDETAIL") {
    cduProps = {
      title: "ACARS  PAX DETAIL", pageNum: "2/2",
      fields: paxDetailFields,
      onFieldCommit: handlePaxDetailCommit,
      execAvailable: false,
      onPrev: () => setPage("LOADSHEET"),
      onNext: () => setPage("LOADSHEET"),
      onDlk: () => setPage("ACARSMENU"),
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
      onDlk: () => setPage("ACARSMENU"),
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
      onDlk: () => setPage("ACARSMENU"),
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
      onDlk: () => setPage("ACARSMENU"),
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
      onDlk: () => setPage("ACARSMENU"),
      onFpl: handlePrintDownload,
    };
  } else {
    cduProps = { title: "ACARS", pageNum: "", fields: [], onFieldCommit: () => {},
      onDlk: () => setPage("ACARSMENU") };
  }

  // A live datalink message outranks whatever the page would otherwise show —
  // it's the most recent thing that happened and the crew is waiting on it.
  const effectiveProps = uplinkMsg ? { ...cduProps, message: uplinkMsg } : cduProps;

  return (
    <div style={{
      height: "100dvh",           // dvh, not vh — accounts for iOS browser chrome
      overflow: "hidden",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "#1c1c1e",
      touchAction: "none",        // no pan/pinch gestures on the panel
      overscrollBehavior: "none", // no rubber-band bounce past the edges
    }}>
      {/* MENU key always jumps to the top-level MENU page, same on every
          page — set once here rather than repeated in every branch above. */}
      <CduEmulator onMenu={() => setPage("MENU")} {...effectiveProps} />
    </div>
  );
}
