import type { Equipment, Installation, SolarArray, SolarCheck } from "@origin89/buddy";
import type { KnowledgeContext } from "./knowledge.ts";
import { identityKey } from "./knowledge.ts";

const rounded = (n: number) => Math.round(n * 100) / 100;
const power = (array: SolarArray) =>
  array.panelCount && array.panelWatts ? array.panelCount * array.panelWatts : null;
export function arrayController(setup: Installation, array: SolarArray): Equipment | null {
  if (!array.controllerRef) return null;
  const ref = array.controllerRef.toLowerCase();
  const matches = setup.equipment.filter(
    (item) =>
      item.kind === "charge-controller" &&
      [
        item.id,
        item.name,
        item.model,
        item.brand && item.model ? `${item.brand} ${item.model}` : null,
      ].some((value) => value?.toLowerCase() === ref),
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Advisory arithmetic only. No AI call, control action or claim of electrical safety. */
export function solarChecks(setup: Installation, knowledge: KnowledgeContext): SolarCheck[] {
  return (setup.solarArrays ?? []).map((array) => {
    const controller = arrayController(setup, array);
    const brand = controller?.brand === "Victron" ? "Victron Energy" : controller?.brand;
    const matches =
      controller?.model && brand
        ? knowledge.records.filter(
            (record) =>
              record.kind === "charge-controller" &&
              identityKey(record.brand, record.model) === identityKey(brand, controller.model!),
          )
        : [];
    const record = matches.length === 1 ? matches[0] : undefined;
    const rating = (name: string, unit: string) => {
      const matches = record?.specifications.filter(
        (s) => s.name === name && s.unit === unit && typeof s.value === "number",
      );
      return matches?.length === 1 ? (matches[0].value as number) : null;
    };
    const result: SolarCheck = {
      array: array.name,
      arrayWatts: power(array),
      controller: controller?.name ?? null,
      findings: [],
      sourceIds: [],
    };
    const add = (level: "warning" | "info", text: string) => result.findings.push({ level, text });
    const useSource = () => {
      if (record) result.sourceIds = [record.id];
    };
    if (!array.panelCount || !array.panelWatts) {
      add(
        "info",
        "Add panel count and watts per panel to estimate array power. The manufacturer can stay unknown.",
      );
      return result;
    }
    let connectedWatts = result.arrayWatts!;
    const connected = controller
      ? (setup.solarArrays ?? []).filter((a) => arrayController(setup, a)?.id === controller.id)
      : [array];
    const incomplete = connected.some((a) => power(a) === null);
    const conflictingBanks =
      new Set(connected.map((a) => a.bankVoltage).filter((v) => v !== null)).size > 1;
    if (controller) connectedWatts = connected.reduce((n, a) => n + (power(a) ?? 0), 0);
    const chargeLimit = rating("Maximum charge current", "A");
    if (chargeLimit !== null) useSource();
    if (
      chargeLimit !== null &&
      array.chargeCurrentAmps !== null &&
      array.chargeCurrentAmps !== chargeLimit
    )
      add(
        "warning",
        `The reported ${array.chargeCurrentAmps} A rating differs from this model's ${chargeLimit} A catalogue rating. Confirm the controller label.`,
      );
    const amps = chargeLimit ?? array.chargeCurrentAmps;
    if (conflictingBanks)
      add(
        "warning",
        "Arrays assigned to this controller have conflicting bank voltages. Confirm the association before comparing charging power.",
      );
    const nominal =
      array.bankVoltage && !conflictingBanks
        ? rating(`Nominal PV power at ${array.bankVoltage} V`, "W")
        : null;
    const outputReference =
      nominal ?? (amps && array.bankVoltage && !conflictingBanks ? amps * array.bankVoltage : null);
    if (nominal !== null) useSource();
    if (outputReference && connectedWatts > outputReference) {
      add(
        "warning",
        `${incomplete ? "At least " : ""}${connectedWatts.toLocaleString("en-US")} W of panels ${controller ? "assigned to this controller" : "reported for this array"} versus ${rounded(outputReference).toLocaleString("en-US")} W ${nominal !== null ? "of published nominal PV charging power" : `at the nominal ${array.bankVoltage} V × ${amps} A reference`}. Power limiting is possible; wattage alone does not establish damage or permitted oversizing.`,
      );
    } else if (!outputReference)
      add(
        "info",
        "Add this MPPT's bank voltage and exact model or charging amp rating for a charging-power comparison.",
      );
    if (outputReference && nominal === null)
      add(
        "info",
        "The V × A comparison is a nominal reference. Actual charging voltage, temperature and the manufacturer's limits determine output.",
      );
    if (!controller)
      add(
        "info",
        "Confirm which controller this group feeds; arrays on different controllers are checked separately.",
      );
    else if (!record)
      add(
        "info",
        "This controller's exact catalogue specifications are unavailable. Reported amps do not establish its PV input limits.",
      );
    if (incomplete)
      add(
        "info",
        "Another panel group on this controller is missing its count or watts; the combined power estimate is incomplete.",
      );
    const topologyValid =
      array.panelsInSeries &&
      array.parallelStrings &&
      array.panelsInSeries * array.parallelStrings === array.panelCount;
    if (array.panelsInSeries && array.parallelStrings && !topologyValid)
      add(
        "warning",
        "Series count × parallel strings does not match the panel count. Confirm the grouping before voltage/current calculations.",
      );
    const maxVoc = rating("Maximum PV open-circuit voltage", "V");
    if (topologyValid && array.panelVoc && maxVoc) {
      useSource();
      const stcVoc = array.panelsInSeries! * array.panelVoc;
      const maxVocAt25 = rating("Maximum PV open-circuit voltage at 25°C", "V");
      if (maxVocAt25 && stcVoc >= maxVocAt25)
        add(
          "warning",
          `${rounded(stcVoc)} V of string Voc at STC reaches or exceeds the separately published ${maxVocAt25} V PV open-circuit limit at 25°C.`,
        );
      const coldKnown =
        array.vocTemperatureCoefficient !== null && array.minimumTemperature !== null;
      const coldVoc = coldKnown
        ? stcVoc * (1 + (array.vocTemperatureCoefficient! / 100) * (array.minimumTemperature! - 25))
        : stcVoc;
      // Never let a warm ambient estimate hide an already-excessive STC Voc.
      const assessed = Math.max(stcVoc, coldVoc);
      if (assessed >= maxVoc)
        add(
          "warning",
          `${rounded(assessed)} V ${coldKnown ? "maximum of STC and temperature-adjusted string Voc" : "string Voc at STC"} reaches or exceeds the controller's ${maxVoc} V maximum. This is a voltage-limit concern, separate from power limiting.`,
        );
      if (!coldKnown)
        add(
          "info",
          "Cold-weather Voc is unverified: add the panel Voc temperature coefficient and site's minimum temperature.",
        );
    } else
      add(
        "info",
        "PV voltage still needs the string layout, panel Voc and the controller's voltage limit. Panel watts and battery voltage cannot establish it.",
      );
    const maxIsc = rating("Maximum PV short-circuit current", "A");
    if (connected.length === 1 && topologyValid && array.panelIsc && maxIsc) {
      useSource();
      const isc = array.parallelStrings! * array.panelIsc;
      if (isc > maxIsc)
        add(
          "warning",
          `${rounded(isc)} A of calculated array Isc exceeds the published ${maxIsc} A PV short-circuit limit. This is distinct from battery-side charging amps.`,
        );
    } else
      add(
        "info",
        "PV current remains unchecked until panel Isc, string grouping and the applicable input/connector limits are known.",
      );
    if (record && !controller?.confirmed)
      add(
        "info",
        "Controller identity is tentative; these catalogue comparisons depend on the model match.",
      );
    return result;
  });
}
