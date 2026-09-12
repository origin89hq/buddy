import type { Extraction } from "./index.ts";

// Hand-authored observations for offline UI/tests. These are never selected by filename or passed off as inference.
const entry = (
  kind: Extraction["observations"][number]["kind"],
  name: string,
  brand: string | null = null,
  model: string | null = null,
  quantity: number | null = 1,
): Extraction["observations"][number] => ({
  existingId: null,
  additionalUnit: false,
  kind,
  name,
  brand,
  model,
  quantity,
  evidence: "Hand-authored example observation; no photo analysis performed.",
  photoIndexes: [0],
});
export const fixtureRounds: Extraction[] = [
  {
    observations: [
      entry("charge-controller", "EPEVER charge controller", "EPEVER", "XTRA4210N"),
      entry("monitor", "MidNite battery monitor", "MidNite"),
      entry("distribution", "Breakers and fuse block", null, null, null),
    ],
    facts: [],
    absent: [],
  },
  {
    observations: [
      entry("charge-controller", "EPEVER charge controller", "EPEVER", "XTRA4210N"),
      entry("inverter", "EPEVER inverter", "EPEVER"),
      entry("charger", "PowerMax charger / converter", "PowerMax"),
      entry("pump", "Pump", null, null, null),
    ],
    facts: [],
    absent: [],
  },
  {
    observations: [entry("battery", "Battery bank", null, null, 6)],
    facts: [],
    absent: [],
  },
];
