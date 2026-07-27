// ─── LANDING PERFORMANCE BRIDGE ─────────────────────────────────────────────
// Single point of contact between PWB and the naclandapp landing-performance
// code (see LANDING_PERF_DESIGN.md).
//
// Only the E-Jet fleet is carried across. naclandapp also ships ERJ, A32F and
// 737 configs plus its own React UI and build setup, but PWB's CDU is an E-Jet
// unit — bringing the rest over would be dead code pretending to be a feature.
// ejet/config.js + ejet/calc.js are fully self-contained (calc.js has no
// imports; the performance tables are inline), so those two files are the
// whole dependency.
//
// fleetRegistry.js is deliberately NOT used: it pulls in all six fleet configs
// just to hand back one of them.

import { ejetConfig } from "./ejet/config.js";

export const EJET_FLEET = ejetConfig;

// The four E-Jet variants naclandapp's tables cover.
export const EJET_AC_TYPES = ["E170", "E175", "E190", "E195"];

/**
 * Map a SimBrief aircraft code onto the naclandapp acType.
 *
 * Same variant problem as the takeoff side: SimBrief reports the airframe as
 * E75L/E75S/E75W (and E70x/E90x/E95x), none of which match the plain family
 * codes the landing tables are keyed on. base_type carries the clean code when
 * it's available, so prefer it and fall back to a pattern match.
 */
export function toEjetAcType(icaocode, baseType) {
  const base = String(baseType || "").toUpperCase();
  if (EJET_AC_TYPES.includes(base)) return base;

  const k = String(icaocode || "").toUpperCase().replace(/[-\s]/g, "");
  if (EJET_AC_TYPES.includes(k)) return k;
  if (/^E(175|75[A-Z]|17[A-Z])$/.test(k)) return "E175";
  if (/^E(170|70[A-Z])$/.test(k)) return "E170";
  if (/^E(190|90[A-Z]|290|29[A-Z])$/.test(k)) return "E190";
  if (/^E(195|95[A-Z]|295)$/.test(k)) return "E195";
  return "E175"; // most common in this fleet
}

/**
 * Pressure altitude from field elevation and altimeter setting.
 *
 * PA = elevation + (29.92 - QNH) * 1000, the standard approximation. Accepts
 * QNH in inHg ("29.86") or hPa ("1013") since the CDU takes either.
 */
export function pressureAltitude(elevationFt, qnh) {
  const elev = Number(elevationFt) || 0;
  const q = parseFloat(qnh);
  if (!Number.isFinite(q)) return Math.round(elev);
  const inHg = q > 100 ? q * 0.02953 : q; // hPa -> inHg
  return Math.round(elev + (29.92 - inHg) * 1000);
}

/**
 * Run a landing calculation.
 *
 * Thin wrapper over the fleet's own calculate() so callers don't have to know
 * its state shape. Returns null rather than throwing if the tables can't
 * produce a figure — a blank field is honest, a fabricated distance is not.
 */
export function calculateLanding({
  acType, landingWeight, flap, reversers, vappAdd,
  pressureAlt, oatC, headwind, brakingAction, slopePct,
  antiIce, stallProtIce, iceAccretion, catII,
}) {
  try {
    return EJET_FLEET.calculate({
      acType,
      landingWeight: Number(landingWeight) || 0,
      flap: flap || "Full",
      reversers: reversers || "Both",
      vappAdd: Number(vappAdd) || 0,
      pressureAlt: Number(pressureAlt) || 0,
      oatC: Number(oatC) || 0,
      headwind: Number(headwind) || 0,
      brakingAction: Number(brakingAction) || 6,
      slopePct: Number(slopePct) || 0,
      antiIce: !!antiIce,
      stallProtIce: !!stallProtIce,
      iceAccretion: !!iceAccretion,
      catII: !!catII,
      shortRwyStation: false,
    });
  } catch (err) {
    console.error("[PWB] landing calculation failed:", err);
    return null;
  }
}

// TALPA RCAM codes, for the SURFACE/RwyCC line on the conditions page. Taken
// from the fleet's own braking options so the two can't drift apart.
export const RWYCC_OPTIONS = EJET_FLEET.brakingOptions;
