import { getSpeeds, calcDistances, calcE190Distances } from "./calc.js";

export const ejetConfig = {
  id: "ejet",
  label: "E-Jet",
  title: "ERJ-170/175 In-Flight Normal Landing Distance",

  defaults: {
    acType:       "E170",
    flap:         "5",
    reversers:    "Both",
    vappAdd:      5,
    landingWeight: 70000,
    antiIce:      false,
    catII:        false,
    stallProtIce: false,
    iceAccretion: false,
    pressureAlt:  1000,
    oatC:         24,
    headwind:     5,
    brakingAction: 6,
    shortRwyStation: false,
  },

  weightLimits: { min: 50000, max: 115280, step: 1000 },

  acTypeOptions: [
    { value: "E170", label: "E170" },
    { value: "E175", label: "E175" },
    { value: "E190", label: "E190" },
    { value: "E195", label: "E195" },
  ],

  flapOptions: [
    { value: "5",    label: "5" },
    { value: "Full", label: "Full" },
  ],

  reverserOptions: [
    { value: "Both", label: "Both" },
    { value: "None", label: "None" },
  ],

  brakingOptions: [
    { value: 6, label: "6 - Dry",      surface: "dry"  },
    { value: 5, label: "5 - Good",     surface: "dry"  },
    { value: 4, label: "4 - Good/Med", surface: "poor" },
    { value: 3, label: "3 - Medium",   surface: "poor" },
    { value: 2, label: "2 - Med/Poor", surface: "poor" },
    { value: 1, label: "1 - Poor",     surface: "poor" },
  ],

  // Which toggles to show in the 2x2 grid
  toggles: ["antiIce", "catII", "stallProtIce", "iceAccretion"],

  // Bottom bar speed slots: { key, label, color }
  speedSlots: [
    { key: "vref", label: "VREF", color: "#ff3b30" },
    { key: "vapp", label: "VAPP", color: "#34c759" },
    { key: "vac",  label: "VAC",  color: "#007aff" },
    { key: "vfs",  label: "VFS",  color: "#8e8e93" },
  ],

  // Distance result key to show prominently
  primaryDistKey: "MAX_MAN",

  // All braking setting labels for result display
  distSettingLabels: {
    MAX_MAN: "Max Manual",
    HI:      "HI Auto",
    MED:     "MED Auto",
    LO:      "LO Auto",
  },

  showShortRunway: true,
  showCatII: true,

  calculate(s) {
    const ice    = s.antiIce || s.stallProtIce;
    const speeds = getSpeeds(s.acType, s.landingWeight, ice);
    const full   = s.flap === "Full";
    const vref   = full ? speeds.VREF_FULL  : speeds.VREF_FLAP5;
    const vac    = full ? speeds.VAC_FLAP4  : speeds.VAC_FLAP2;
    const vapp   = vref + s.vappAdd;
    const vfs    = speeds.VFS;

    const brkOpt  = this.brakingOptions.find(b => b.value === s.brakingAction) || this.brakingOptions[0];
    const surface = brkOpt.surface;
    const reverser= s.reversers === "Both";
    const fc      = full ? "FULL FLAPS" : "FLAP 5";
    const isE190  = s.acType === "E190" || s.acType === "E195";

    let distances = null;
    let primaryDist = null;

    if (isE190) {
      // E190/195: full QRH-style calculation — all braking settings, all corrections
      distances = calcE190Distances({
        weightLbs:    s.landingWeight,
        flap:         s.flap,
        ice,
        brakingAction: s.brakingAction,
        pressureAlt:  s.pressureAlt,
        oatC:         s.oatC,
        headwind:     s.headwind,
        slopePct:     s.slopePct ?? 0,
        vappAdditive: s.vappAdd,
        reverser:     s.reversers === "Both",
      });
      primaryDist = distances?.MAX_MAN ?? null;
    } else {
      distances = calcDistances({
        weightLbs:    s.landingWeight,
        flapConfig:   fc,
        ice,
        surface,
        elevationFt:  s.pressureAlt,
        tempC:        s.oatC,
        windKt:       s.headwind,
        vrefAdditive: s.vappAdd - 5,
        reverser,
      });
      primaryDist = distances?.MAX_MAN ?? null;
    }

    const structural   = isE190 ? 111500 : 72310;
    const climbLimited = Math.round(structural * 1.252 / 100) * 100;

    return {
      speeds: { vref, vapp, vac, vfs },
      distances,
      climbLimited,
      structural,
      primaryDist,
    };
  },
};
