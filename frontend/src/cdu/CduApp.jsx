import { useState, useCallback } from "react";
import CduEmulator from "./CduEmulator.jsx";
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
// Page flow (PREV/NEXT cycle through these once a flight plan is loaded):
//   IDENT             — enter a SimBrief username, fetch + parse the OFP
//   PERF TAKEOFF 1/2   — runway, intersection, TLR scenario, anti-ice, conditions
//   PERF TAKEOFF 2/2   — V1/VR/V2/FLEX/FLAPS overrides, EXEC/DLK -> /api/generate
//   ACARS T/O RWY DATA — authentic 3-page ACARS report, modeled on the real
//                         Honeywell AeroData "ACARS Takeoff Runway Data" pages
//                         (ERJ-170 POH ch.9 sec.16):
//                           1/3 loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH,
//                               SECT A/B/C, GTOW/CG, ZFW/CG, TTL PAX, status)
//                           2/3 REMARKS
//                           3/3 TAKEOFF PERFORMANCE (V1/VR/V2/FLAPS/FLEX/THR/
//                               ACC ALT/TR ALT/TRIM/MRTW), from the backend's
//                               runway_results (JSON, not parsed out of text)
//   TPS PRINT           — the full generated ACARS text, paginated like a real
//                         CDU TEXT/REPORTS page, with a PRINT (download) key
//
// Known simplifications vs. a full ops UI:
//   - No raw-XML paste fallback — SimBrief username only. Typing a full XML
//     document on a CDU keypad isn't a realistic interaction anyway.
//   - No Closeout tab — that flow depends on a LOCAL backend running on the
//     ops Mac (OOOI log + printer folder access) and doesn't map onto the
//     keypad-driven commit model well.
//   - V1/VR/V2/FLEX/FLAPS shown on PERF TAKEOFF 1/2 are the SimBrief XML
//     values (or intersection-substituted ones) — TLR-scenario-interpolated
//     numbers only exist after EXEC. The ACARS T/O RWY DATA and TPS PRINT
//     pages show the authoritative result.

const SCENARIO_DEFS = [
  { key: "DRY_PTOW",      surface: "DRY", cond: "PTOW",      label: "DRY PTOW"  },
  { key: "DRY_PTOW+4000", surface: "DRY", cond: "PTOW+4000", label: "DRY +4000" },
  { key: "WET_PTOW",      surface: "WET", cond: "PTOW",      label: "WET PTOW"  },
  { key: "WET_PTOW+4000", surface: "WET", cond: "PTOW+4000", label: "WET +4000" },
];
const SCENARIO_LABELS = { PLANNED: "PLANNED", ...Object.fromEntries(SCENARIO_DEFS.map(d => [d.key, d.label])) };
const SCENARIO_SHORTHAND = {
  PLAN: "PLANNED", PLANNED: "PLANNED",
  DRY1: "DRY_PTOW", "DRY+4000": "DRY_PTOW+4000", DRY2: "DRY_PTOW+4000",
  WET1: "WET_PTOW", WET2: "WET_PTOW+4000",
};

function tlrAvail(xmlData, surface, cond) {
  return !!(xmlData?.tlr_tables?.[surface]?.[cond]);
}

function availableScenarios(xmlData) {
  return ["PLANNED", ...SCENARIO_DEFS.filter(d => tlrAvail(xmlData, d.surface, d.cond)).map(d => d.key)];
}

const LINES_PER_PRINT_PAGE = 11;

export default function CduApp() {
  const [page, setPage] = useState("IDENT"); // IDENT | PERF1 | PERF2 | ACARS | PRINT
  const [acarsPageIndex, setAcarsPageIndex] = useState(0); // 0=summary 1=remarks 2=perf

  const [xmlData, setXmlData] = useState(null);
  const [simbriefUsername, setSimbriefUsername] = useState(
    () => localStorage.getItem("tps_simbrief_username") || ""
  );
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [identStatus, setIdentStatus] = useState("ENTER SIMBRIEF ID");
  const [identStatusErr, setIdentStatusErr] = useState(false);

  const [runway, setRunway] = useState("");
  const [intersection, setIntersection] = useState("FULL");
  const [scenario, setScenario] = useState("PLANNED");
  const [antiIce, setAntiIce] = useState(false);
  const [oat, setOat] = useState("");
  const [qnh, setQnh] = useState("");
  const [wind, setWind] = useState("");

  const [speedOverrides, setSpeedOverrides] = useState({});
  const [forceMax, setForceMax] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [perfStatus, setPerfStatus] = useState("");
  const [perfStatusErr, setPerfStatusErr] = useState(false);

  const [tpsResult, setTpsResult] = useState(null); // { content, filename, atow, runway_results }
  const [printPageIndex, setPrintPageIndex] = useState(0);

  // ── Data helpers ──────────────────────────────────────────────────────────
  const allRunwaysSelected = runway === "ALL";
  const rwyData = xmlData?.valid_runways?.find(r => r.id === runway) ?? xmlData?.valid_runways?.[0] ?? null;
  // "ALL" requests every published runway in one ACARS request (matches the
  // real system's multi-runway report) — intersections are per-runway, so
  // only FULL length applies when ALL is selected.
  const intxnOptions = allRunwaysSelected
    ? [{ id: "FULL", label: "FULL" }]
    : (xmlData?.intersections?.[rwyData?.id]) ?? [{ id: "FULL", label: "FULL" }];
  const scenarioChoices = availableScenarios(xmlData);
  const conditionsEdited = !!xmlData && (oat !== xmlData.temp || qnh !== xmlData.qnh || wind !== xmlData.wind);
  // Authoritative post-EXEC results — one entry per requested runway, matches
  // the {airport,runway,length,v1,vr,v2,vfs,flex,flaps,trim_stab,mrtw,mtow,
  // gtow_cg,acc_alt,...} shape computed server-side by generate_combined_output().
  const runwayResults = tpsResult?.runway_results ?? [];
  // Authentic ACARS T/O RWY DATA loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH,
  // SECT A/B/C, GTOW/CG, ZFW/CG, TTL PAX, REMARKS) — matches the ERJ-170 POH
  // "ACARS Takeoff Runway Data" reference pages, computed server-side.
  const loadsheetSummary = tpsResult?.loadsheet_summary ?? null;

  function getSpeed(k) {
    return speedOverrides[k] ?? rwyData?.[k] ?? "";
  }

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
      setRunway(initRunway);
      setIntersection("FULL");
      setScenario("PLANNED");
      setAntiIce(false);
      setOat(data.temp);
      setQnh(data.qnh);
      setWind(data.wind);
      setSpeedOverrides({});
      setForceMax(false);
      setTpsResult(null);
      setPrintPageIndex(0);

      setIdentStatus(`OFP LOADED — FLT ${data.flight_number} ${data.origin_iata}-${data.dest_iata}`);
      setIdentStatusErr(false);
      setPage("PERF1");
    } catch (e) {
      setIdentStatus(e instanceof ApiError ? e.message.toUpperCase() : "COULD NOT REACH SERVER");
      setIdentStatusErr(true);
    } finally {
      setLoadingPlan(false);
    }
  }, []);

  function handleIdentCommit(key, value) {
    if (key !== "simbrief" || value === null) return;
    doFetch(value);
  }

  const identFields = [
    { key: "simbrief", label: "SIMBRIEF ID", value: simbriefUsername, side: "L", editable: true },
    { key: "status",   label: "STATUS",      value: identStatus,       side: "C", editable: false, small: true, error: identStatusErr },
    ...(xmlData ? [
      { key: "flt",   label: "FLT NO", value: String(xmlData.flight_number), side: "R", editable: false },
      { key: "rte",   label: "ROUTE",  value: `${xmlData.origin_iata}-${xmlData.dest_iata}`, side: "R", editable: false },
      { key: "ac",    label: "A/C",    value: xmlData.icaocode, side: "R", editable: false },
    ] : []),
  ];

  // ── PERF TAKEOFF 1/2 — runway / intersection / scenario / conditions ──────
  function handlePerf1Commit(key, value) {
    if (key === "return") {
      if (value === null) setPage("IDENT");
      return;
    }
    if (key === "runway") {
      // Cycle: each published runway, then "ALL" (request every runway in
      // one ACARS request, like the real system's multi-runway report),
      // then back to the first.
      const runways = xmlData.valid_runways;
      const cycleIds = [...runways.map(r => r.id), "ALL"];
      if (value === null) {
        const idx = cycleIds.indexOf(runway);
        const next = cycleIds[(idx + 1) % cycleIds.length];
        setRunway(next); setIntersection("FULL"); setSpeedOverrides({});
        return;
      }
      const typed = value.toUpperCase();
      if (typed === "ALL") {
        setRunway("ALL"); setIntersection("FULL"); setSpeedOverrides({});
        return;
      }
      const match = runways.find(r => r.id === typed);
      if (!match) return { error: "INVALID ENTRY" };
      setRunway(match.id); setIntersection("FULL"); setSpeedOverrides({});
      return;
    }
    if (key === "intxn") {
      if (value === null) {
        const idx = intxnOptions.findIndex(o => o.id === intersection);
        const next = intxnOptions[(idx + 1) % intxnOptions.length];
        setIntersection(next.id);
        return;
      }
      const match = intxnOptions.find(o => o.id === value.toUpperCase());
      if (!match) return { error: "INVALID ENTRY" };
      setIntersection(match.id);
      return;
    }
    if (key === "scen") {
      if (value === null) {
        const idx = scenarioChoices.indexOf(scenario);
        setScenario(scenarioChoices[(idx + 1) % scenarioChoices.length]);
        return;
      }
      const mapped = SCENARIO_SHORTHAND[value.toUpperCase()];
      if (!mapped || !scenarioChoices.includes(mapped)) return { error: "INVALID ENTRY" };
      setScenario(mapped);
      return;
    }
    if (key === "antiice") {
      if (value === null) { setAntiIce(a => !a); return; }
      const v = value.toUpperCase();
      if (v === "ON") setAntiIce(true);
      else if (v === "OFF") setAntiIce(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "oat")  { setOat(value); return; }
    if (key === "qnh")  { setQnh(value); return; }
    if (key === "wind") { setWind(value); return; }
  }

  const perf1Fields = xmlData ? [
    { key: "runway",  label: "RUNWAY",   value: runway,                                  side: "L", editable: true, cyclable: true },
    { key: "intxn",   label: "INTXN",    value: intersection,                            side: "L", editable: true, cyclable: true },
    { key: "scen",    label: "SCENARIO", value: SCENARIO_LABELS[scenario] ?? scenario,    side: "L", editable: true, cyclable: true },
    { key: "antiice", label: "ANTI-ICE", value: antiIce ? "ON" : "OFF",                   side: "L", editable: true, cyclable: true },
    { key: "oat",     label: "OAT C",    value: String(oat),                             side: "R", editable: true },
    { key: "qnh",     label: "QNH",      value: String(qnh),                             side: "R", editable: true },
    { key: "wind",    label: "WIND",     value: String(wind),                            side: "R", editable: true },
    { key: "status",  label: "",         value: perfStatus,                              side: "C", editable: false, small: true, error: perfStatusErr },
    { key: "return",  label: "",         value: "",                                      side: "C", editable: true, returnLine: true },
  ] : [];

  // ── PERF TAKEOFF 2/2 — speeds + EXEC ──────────────────────────────────────
  function handlePerf2Commit(key, value) {
    if (["v1", "vr", "v2", "flex", "flaps"].includes(key)) {
      if (value === null) return; // not cyclable
      setSpeedOverrides(p => ({ ...p, [key]: value }));
      if (key === "flex" && forceMax) setForceMax(false);
      return;
    }
    if (key === "maxthr") {
      if (value === null) {
        setForceMax(f => {
          const nf = !f;
          if (nf) setSpeedOverrides(p => { const c = { ...p }; delete c.flex; return c; });
          return nf;
        });
        return;
      }
      const v = value.toUpperCase();
      if (v === "ON") { setForceMax(true); setSpeedOverrides(p => { const c = { ...p }; delete c.flex; return c; }); }
      else if (v === "OFF") setForceMax(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
  }

  // V-speed / FLEX / FLAPS overrides only make sense for a single requested
  // runway — when ALL runways are requested each gets its own computed
  // speeds, so the override fields are shown read-only (preview of the
  // first runway's values) instead of editable.
  const perf2Fields = xmlData ? [
    { key: "v1",    label: "V1",     value: String(getSpeed("v1")),               side: "L", editable: !allRunwaysSelected },
    { key: "vr",    label: "VR",     value: String(getSpeed("vr")),               side: "L", editable: !allRunwaysSelected },
    { key: "v2",    label: "V2",     value: String(getSpeed("v2")),               side: "L", editable: !allRunwaysSelected },
    { key: "flex",  label: "FLEX",   value: forceMax ? "MAX" : String(getSpeed("flex")), side: "R", editable: !forceMax && !allRunwaysSelected },
    { key: "flaps", label: "FLAPS",  value: String(getSpeed("flaps")),            side: "R", editable: !allRunwaysSelected },
    { key: "maxthr",label: "MAX THR",value: forceMax ? "ON" : "OFF",              side: "R", editable: !allRunwaysSelected, cyclable: true },
    { key: "thr",   label: "THR",    value: allRunwaysSelected ? "ALL RWYS" : (rwyData?.thr ?? ""), side: "C", editable: false },
    { key: "status",label: "",       value: perfStatus,                          side: "C", editable: false, small: true, error: perfStatusErr },
  ] : [];

  async function handleExec() {
    if (!xmlData || !rwyData) return;
    setGenerating(true);
    setPerfStatus("GENERATING...");
    setPerfStatusErr(false);
    try {
      const result = await apiGenerateTps({
        xml_data: xmlData,
        mode: "tps",
        scenario,
        condOverride: conditionsEdited,
        oat, qnh, wind,
        antiIce,
        runway,
        intersection,
        speedOverrides,
        forceMax,
      });
      setTpsResult(result.tps);
      setPrintPageIndex(0);
      setAcarsPageIndex(0);
      setPerfStatus(`GENERATED — ${result.tps.filename}`);
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
  // REMARKS, then ONE TAKEOFF PERFORMANCE page per requested runway (a
  // single runway normally, or every published runway at once when "ALL"
  // is selected on PERF TAKEOFF 1/2 — same as the real system's multi-
  // runway ACARS request, which pages 3/5, 4/5, 5/5... one per runway).
  function handleAcarsCommit(key, value) {
    if (key === "return" && value === null) setPage("PERF2");
  }

  const acarsSummaryFields = loadsheetSummary ? [
    { key: "flt",   label: "FLT",        value: String(loadsheetSummary.flt_no),       side: "L", editable: false },
    { key: "rls",   label: "RLS",        value: String(loadsheetSummary.rls_no),       side: "L", editable: false },
    { key: "seca",  label: "SECT A",     value: String(loadsheetSummary.sect_a_pax),   side: "L", editable: false },
    { key: "secb",  label: "SECT B",     value: String(loadsheetSummary.sect_b_pax),   side: "L", editable: false },
    { key: "secc",  label: "SECT C",     value: String(loadsheetSummary.sect_c_pax),   side: "L", editable: false },
    { key: "time",  label: "TIME",       value: String(loadsheetSummary.time),         side: "R", editable: false },
    { key: "wind",  label: "WIND",       value: String(loadsheetSummary.wind),         side: "R", editable: false },
    { key: "oat",   label: "OAT C",      value: String(loadsheetSummary.oat),          side: "R", editable: false },
    { key: "qnh",   label: "QNH",        value: String(loadsheetSummary.qnh),          side: "R", editable: false },
    { key: "fcgo",  label: "F CGO",      value: String(loadsheetSummary.sect_a_bagwt), side: "C", editable: false },
    { key: "gtow",  label: "GTOW/CG",    value: String(loadsheetSummary.gtow_cg),      side: "C", editable: false },
    { key: "acgo",  label: "A CGO",      value: String(loadsheetSummary.sect_b_bagwt), side: "C", editable: false },
    { key: "zfw",   label: "ZFW/CG",     value: String(loadsheetSummary.zfw_cg),       side: "C", editable: false },
    { key: "fob",   label: "FOB",        value: String(loadsheetSummary.sect_c_fuel),  side: "C", editable: false },
    { key: "totpax",label: "TOT PAX",    value: String(loadsheetSummary.ttl_pax),      side: "C", editable: false },
    { key: "status",label: "",           value: loadsheetSummary.takeoff_data_avail ? "TAKEOFF DATA AVAIL" : "NO TAKEOFF DATA AVAIL", side: "C", editable: false, small: true, error: !loadsheetSummary.takeoff_data_avail },
    { key: "return",label: "",           value: "",                                    side: "C", editable: true, returnLine: true },
  ] : [];

  const acarsRemarksFields = loadsheetSummary ? [
    { key: "hdr", label: "", value: "REMARKS", side: "C", editable: false, small: true },
    ...(loadsheetSummary.remarks ?? []).map((rl, i) => ({
      key: `rl${i}`, label: "", value: rl || " ", side: "C", editable: false, small: true,
    })),
    { key: "return", label: "", value: "", side: "C", editable: true, returnLine: true },
  ] : [];

  // Field set matches a live-generated TAKEOFF PERFORMANCE block exactly:
  // left = FLEX/FLAP/STAB, right = V1/VR/V2/VFS, center = airport+runway+
  // length, MRTW/LIM, MTOW, GTOW/CG, ACCEL. One of these per runway result.
  function buildPerfFields(rd) {
    return [
      { key: "flex",  label: "FLEX",  value: String(rd.flex),  side: "L", editable: false },
      { key: "flap",  label: "FLAP",  value: String(rd.flaps), side: "L", editable: false },
      { key: "stab",  label: "STAB",  value: String(rd.trim_stab), side: "L", editable: false },
      { key: "v1",    label: "V1",    value: String(rd.v1),    side: "R", editable: false },
      { key: "vr",    label: "VR",    value: String(rd.vr),    side: "R", editable: false },
      { key: "v2",    label: "V2",    value: String(rd.v2),    side: "R", editable: false },
      { key: "vfs",   label: String(rd.vfs_label || "VFS"), value: rd.vfs != null ? String(rd.vfs) : "---", side: "R", editable: false },
      { key: "rwy",   label: "RUNWAY / LENGTH", value: `${rd.airport} ${rd.runway}   ${rd.length}FT`, side: "C", editable: false },
      { key: "mrtw",  label: "MRTW / LIM", value: String(rd.mrtw), side: "C", editable: false },
      { key: "mtow",  label: "MTOW",  value: String(rd.mtow), side: "C", editable: false },
      { key: "gtow",  label: "GTOW / CG", value: String(rd.gtow_cg), side: "C", editable: false },
      { key: "accel", label: "ACCEL", value: String(rd.acc_alt), side: "C", editable: false },
      { key: "return",label: "",       value: "",                       side: "C", editable: true, returnLine: true },
    ];
  }

  const perfPages = runwayResults.length
    ? runwayResults.map(rd => ({ title: "ACARS T/O RWY DATA", fields: buildPerfFields(rd) }))
    : [{
        title: "ACARS T/O RWY DATA",
        fields: [
          { key: "none",   label: "", value: "NO TAKEOFF DATA AVAIL", side: "C", editable: false, error: true },
          { key: "return", label: "", value: "", side: "C", editable: true, returnLine: true },
        ],
      }];

  const ACARS_PAGES = [
    { title: "ACARS T/O RWY DATA", fields: acarsSummaryFields },
    { title: "ACARS T/O RWY DATA", fields: acarsRemarksFields },
    ...perfPages,
  ];

  // ── TPS PRINT — paginated read-only text ──────────────────────────────────
  const printLines = tpsResult ? tpsResult.content.replace(/\r/g, "").split("\n") : [];
  const totalPrintPages = Math.max(1, Math.ceil(printLines.length / LINES_PER_PRINT_PAGE));
  const currentPrintLines = printLines.slice(
    printPageIndex * LINES_PER_PRINT_PAGE,
    printPageIndex * LINES_PER_PRINT_PAGE + LINES_PER_PRINT_PAGE
  );
  const printFields = currentPrintLines.map((line, i) => ({
    key: `line${i}`, label: "", value: line || " ", side: "C", editable: false, small: true,
  }));

  function handlePrintPrev() {
    if (printPageIndex > 0) setPrintPageIndex(i => i - 1);
    else { setAcarsPageIndex(ACARS_PAGES.length - 1); setPage("ACARS"); }
  }
  function handlePrintNext() {
    if (printPageIndex < totalPrintPages - 1) setPrintPageIndex(i => i + 1);
  }
  function handlePrintDownload() {
    if (tpsResult) forceDownloadTxt(tpsResult.content, tpsResult.filename);
  }

  // ── Page config dispatch ──────────────────────────────────────────────────
  let cduProps;
  if (page === "IDENT") {
    cduProps = {
      title: "IDENT", pageNum: "1/1",
      fields: identFields,
      onFieldCommit: handleIdentCommit,
      execAvailable: !xmlData && !loadingPlan && simbriefUsername.trim().length > 0,
      onExec: () => doFetch(simbriefUsername.trim()),
      onNext: xmlData ? () => setPage("PERF1") : undefined,
      onPerf: xmlData ? () => setPage("PERF1") : undefined,
    };
  } else if (page === "PERF1") {
    cduProps = {
      title: "PERF TAKEOFF", pageNum: "1/2",
      fields: perf1Fields,
      onFieldCommit: handlePerf1Commit,
      execAvailable: false,
      onPrev: () => setPage("IDENT"),
      onNext: () => setPage("PERF2"),
      onPerf: () => setPage("PERF1"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "PERF2") {
    cduProps = {
      title: "PERF TAKEOFF", pageNum: "2/2",
      fields: perf2Fields,
      onFieldCommit: handlePerf2Commit,
      execAvailable: !!xmlData && !!rwyData && !generating,
      onExec: handleExec,
      onDlk: handleExec, // real workflow: DLK sends the ACARS request, same trigger as EXEC
      onPrev: () => setPage("PERF1"),
      onNext: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
      onPerf: () => setPage("PERF1"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "ACARS") {
    const cur = ACARS_PAGES[acarsPageIndex];
    cduProps = {
      title: cur.title, pageNum: `${acarsPageIndex + 1}/${ACARS_PAGES.length}`,
      fields: cur.fields,
      onFieldCommit: handleAcarsCommit,
      execAvailable: false,
      onPrev: () => {
        if (acarsPageIndex > 0) setAcarsPageIndex(i => i - 1);
        else setPage("PERF2");
      },
      onNext: () => {
        if (acarsPageIndex < ACARS_PAGES.length - 1) setAcarsPageIndex(i => i + 1);
        else { setPrintPageIndex(0); setPage("PRINT"); }
      },
      onPerf: () => setPage("PERF1"),
      onFpl: handlePrintDownload,
    };
  } else { // PRINT
    cduProps = {
      title: "TPS PRINT", pageNum: `${printPageIndex + 1}/${totalPrintPages}`,
      fields: printFields,
      onFieldCommit: () => {},
      execAvailable: false,
      onPrev: handlePrintPrev,
      onNext: handlePrintNext,
      onPerf: () => setPage("PERF1"),
      onFpl: handlePrintDownload, // FPL repurposed as PRINT/DOWNLOAD on this page
    };
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#1c1c1e" }}>
      <CduEmulator {...cduProps} />
    </div>
  );
}
