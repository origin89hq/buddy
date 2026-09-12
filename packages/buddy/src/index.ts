import { z } from "zod";

export const kinds = [
  "charge-controller",
  "inverter",
  "battery",
  "panel",
  "charger",
  "pump",
  "monitor",
  "distribution",
  "generator",
  "other",
] as const;
export const kindNames: Record<Kind, string> = {
  "charge-controller": "Charge controller",
  inverter: "Inverter",
  battery: "Battery bank",
  panel: "Solar panels",
  charger: "Charger / converter",
  pump: "Pump",
  monitor: "Battery monitor",
  distribution: "Distribution / protection",
  generator: "Generator",
  other: "Equipment",
};
export type Kind = (typeof kinds)[number];
const short = z.string().trim().max(160);
export const observationSchema = z.object({
  existingId: short
    .nullable()
    .describe(
      "Existing equipment ID only when this is the same physical item; null for a new item.",
    ),
  additionalUnit: z
    .boolean()
    .describe(
      "True only for an explicitly separate additional physical unit, even when its brand/model matches an existing entry.",
    ),
  kind: z.enum(kinds),
  name: short,
  brand: short.nullable(),
  model: short.nullable(),
  quantity: z.number().int().min(1).max(2000).nullable(),
  evidence: z
    .string()
    .max(400)
    .describe(
      "What is actually visible or explicitly stated. Do not infer ratings from appearance.",
    ),
  photoIndexes: z.array(z.number().int().min(0).max(5)).max(6),
});
export const extractionSchema = z.object({
  observations: z.array(observationSchema).max(20),
  facts: z
    .array(
      z.object({
        key: z.enum([
          "battery_voltage",
          "battery_capacity",
          "battery_chemistry",
          "panel_count",
          "panel_wiring",
          "data_port",
          "goal",
        ]),
        value: short,
        evidence: z.string().max(300),
      }),
    )
    .max(12),
  absent: z
    .array(z.enum(kinds))
    .max(10)
    .describe(
      "Only items the user EXPLICITLY says they do not own. Not being visible is not absence.",
    ),
});
export const solarArraySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Stable array/group label; reuse its saved name when adding details."),
  controllerRef: short
    .nullable()
    .describe(
      "Existing controller ID or exact unique equipment name/model explicitly connected to this array. Null if not known.",
    ),
  panelCount: z.number().int().min(1).max(2000).nullable(),
  panelWatts: z
    .number()
    .positive()
    .max(2000)
    .nullable()
    .describe("Nameplate watts per panel, not total array watts."),
  bankVoltage: z
    .number()
    .positive()
    .max(1000)
    .nullable()
    .describe("Explicitly stated battery BANK voltage for this controller. Not panel voltage."),
  chargeCurrentAmps: z
    .number()
    .positive()
    .max(2000)
    .nullable()
    .describe(
      "User-stated controller battery-side amp rating; never PV current or a catalogue value.",
    ),
  panelsInSeries: z.number().int().min(1).max(2000).nullable(),
  parallelStrings: z.number().int().min(1).max(2000).nullable(),
  panelVoc: z.number().positive().max(1000).nullable(),
  panelIsc: z.number().positive().max(200).nullable(),
  vocTemperatureCoefficient: z
    .number()
    .min(-2)
    .max(0)
    .nullable()
    .describe(
      "Voc coefficient in percent per degree C, e.g. -0.3. Not a power temperature coefficient.",
    ),
  minimumTemperature: z.number().min(-80).max(60).nullable(),
  evidence: z.string().min(1).max(400),
});
export type SolarArray = z.infer<typeof solarArraySchema> & { messageIds: string[] };
export interface SolarCheck {
  array: string;
  arrayWatts: number | null;
  controller: string | null;
  findings: { level: "warning" | "info"; text: string }[];
  sourceIds: string[];
}
export type Extraction = z.infer<typeof extractionSchema> & {
  solarArrays?: z.infer<typeof solarArraySchema>[];
};
export interface Equipment extends z.infer<typeof observationSchema> {
  id: string;
  photoIds: string[];
  messageIds: string[];
  confirmed: boolean;
}
export interface Installation {
  version: 1;
  revision: number;
  equipment: Equipment[];
  facts: {
    key: Extraction["facts"][number]["key"];
    value: string;
    evidence: string;
    messageId: string;
  }[];
  absent: Kind[];
  deferred: string[];
  solarArrays?: SolarArray[];
}
export const newInstallation = (): Installation => ({
  version: 1,
  revision: 0,
  equipment: [],
  facts: [],
  absent: [],
  deferred: [],
});
export interface Question {
  id: string;
  text: string;
  kind?: Kind;
}
export function questions(setup: Installation): Question[] {
  const has = (kind: Kind) =>
    setup.equipment.some((item) => item.kind === kind) || setup.absent.includes(kind);
  const result: Question[] = [];
  if (!setup.equipment.length)
    return [
      {
        id: "overview",
        text: "Got a photo of your setup? A wide shot is a great place to start.",
      },
    ];
  if (!has("inverter"))
    result.push({
      id: "inverter",
      kind: "inverter",
      text: "Do you also have an inverter? A photo of it would help.",
    });
  if (!has("battery"))
    result.push({
      id: "battery",
      kind: "battery",
      text: "We’re missing your battery bank. Can you send a photo of your batteries?",
    });
  for (const item of setup.equipment.filter((item) => item.kind === "battery" && !item.model))
    result.push({
      id: `model:${item.id}`,
      text: "Could you take a close-up of the model label on one battery? We can use it to find the right specifications.",
    });
  if (!has("panel"))
    result.push({
      id: "panel",
      kind: "panel",
      text: "Let’s add your solar panels. Do you have a photo of their label, or remember the model?",
    });
  for (const item of setup.equipment.filter(
    (item) => !item.model && ["charge-controller", "inverter", "charger"].includes(item.kind),
  ))
    result.push({
      id: `model:${item.id}`,
      text: `Can you send a close-up of the model label on your ${kindNames[item.kind].toLowerCase()}?`,
    });
  if (setup.equipment.some((item) => item.kind === "panel")) {
    if (!setup.solarArrays?.some((array) => array.panelWatts))
      result.push({
        id: "panel_watts",
        text: "How many watts is each panel? The brand can stay unknown.",
      });
    if (
      !setup.facts.some((fact) => fact.key === "panel_count") &&
      !setup.equipment.some((item) => item.kind === "panel" && item.quantity)
    )
      result.push({
        id: "panel_count",
        text: "How many solar panels do you have?",
      });
    if (!setup.facts.some((fact) => fact.key === "panel_wiring"))
      result.push({
        id: "panel_wiring",
        text: "Do you know how your panels are grouped into strings? It’s fine to leave this open.",
      });
  }
  if (
    setup.equipment.some((item) => item.kind === "charge-controller") &&
    !setup.facts.some((fact) => fact.key === "data_port")
  )
    result.push({
      id: "data_port",
      text: "Is a display, logger or adapter already plugged into your charge controller’s data port? A photo helps.",
    });
  if (!setup.facts.some((fact) => fact.key === "goal"))
    result.push({
      id: "goal",
      text: "What would you most like to understand or improve about this setup?",
    });
  return result;
}
export const nextQuestion = (setup: Installation) =>
  questions(setup).find((question) => !setup.deferred.includes(question.id)) ?? null;
const normalized = (value: string | null) => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Merge observations, never allowing the model to confirm an item or overwrite a confirmed identity. */
export function mergeExtraction(
  previous: Installation,
  extraction: Extraction,
  messageId: string,
  photoIds: string[],
  id = () => crypto.randomUUID(),
): Installation {
  const setup = structuredClone(previous);
  for (const observed of extraction.observations) {
    let item = setup.equipment.find(
      (item) => item.id === observed.existingId && item.kind === observed.kind,
    );
    // Safe fallback for repeated photos. Different exact models remain separate.
    if (!item && !observed.additionalUnit) {
      const matches = setup.equipment.filter(
        (item) =>
          item.kind === observed.kind &&
          (!item.brand ||
            !observed.brand ||
            normalized(item.brand) === normalized(observed.brand)) &&
          (!item.model ||
            !observed.model ||
            normalized(item.model) === normalized(observed.model)) &&
          (Boolean(item.model && observed.model) ||
            Boolean(item.brand && observed.brand) ||
            normalized(item.name) === normalized(observed.name)),
      );
      if (matches.length === 1) item = matches[0];
    }
    const linked = observed.photoIndexes
      .map((index) => photoIds[index])
      .filter((value): value is string => Boolean(value));
    if (item) {
      if (!item.confirmed) {
        item.name = observed.name || item.name;
        item.brand = observed.brand || item.brand;
        item.model = observed.model || item.model;
        item.quantity = observed.quantity ?? item.quantity;
      } else {
        // Preserve reviewed values; newly readable missing fields need another review.
        const enriched =
          (!item.brand && observed.brand) ||
          (!item.model && observed.model) ||
          (item.quantity == null && observed.quantity != null);
        item.brand ||= observed.brand;
        item.model ||= observed.model;
        item.quantity ??= observed.quantity;
        if (enriched) item.confirmed = false;
      }
      item.photoIds = [...new Set([...item.photoIds, ...linked])];
      item.messageIds = [...new Set([...item.messageIds, messageId])];
      item.evidence = observed.evidence || item.evidence;
    } else {
      setup.equipment.push({
        ...observed,
        id: id(),
        photoIds: linked,
        messageIds: [messageId],
        confirmed: false,
      });
    }
    setup.absent = setup.absent.filter((kind) => kind !== observed.kind);
  }
  for (const fact of extraction.facts) {
    if (
      !fact.value.trim() ||
      /^(null|unknown|n\/?a|not (known|visible|readable|specified)|unclear)$/i.test(
        fact.value.trim(),
      )
    )
      continue;
    setup.facts = setup.facts.filter((old) => old.key !== fact.key);
    setup.facts.push({ ...fact, messageId });
  }
  for (const patch of extraction.solarArrays ?? []) {
    setup.solarArrays ??= [];
    const existing = setup.solarArrays.find((array) => array.name === patch.name);
    if (existing) {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== null) Object.assign(existing, { [key]: value });
      }
      existing.messageIds = [...new Set([...existing.messageIds, messageId])];
    } else if (setup.solarArrays.length < 12)
      setup.solarArrays.push({ ...patch, messageIds: [messageId] });
  }
  for (const kind of extraction.absent)
    if (!setup.equipment.some((item) => item.kind === kind))
      setup.absent = [...new Set([...setup.absent, kind])];
  setup.revision++;
  return setup;
}
export function observationReply(
  before: Installation,
  after: Installation,
  photoCount: number,
): string {
  const added = after.equipment.filter(
    (item) => !before.equipment.some((old) => old.id === item.id),
  );
  const changed = after.equipment.filter((item) =>
    before.equipment.some(
      (old) => old.id === item.id && (old.model !== item.model || old.quantity !== item.quantity),
    ),
  );
  const intro = added.length
    ? `I’ve added ${added.map((item) => (item.quantity && item.quantity > 1 ? `${item.quantity} ${item.kind === "battery" ? "batteries" : item.name.toLowerCase()}` : item.name)).join(", ")} to your setup.`
    : changed.length
      ? "Thanks—that fills in more of your equipment details."
      : photoCount
        ? "I’ve kept these photos with your setup. Anything I couldn’t read stays open."
        : "Saved that with your setup.";
  const question = nextQuestion(after);
  return (
    intro +
    "\n\n" +
    (question?.text ??
      "Your setup is saved. You can add more photos, correct an equipment card or download your record. The open details stay on your list.")
  );
}
export interface Photo {
  id: string;
  name: string;
  mediaType: string;
  url: string;
}
export interface KnowledgeSource {
  id: string;
  title: string;
  url: string;
  page?: number;
  row?: number;
  section?: string;
  revision: string;
}
export interface KnowledgePreview {
  lookupMs: number;
  records: {
    id: string;
    name: string;
    specifications: {
      name: string;
      value: string | number;
      unit: string | null;
      conditions: string;
    }[];
    source: KnowledgeSource;
    integrationStatus?: "passive" | "documented" | "decoder-implemented" | "hardware-verified";
  }[];
}
export interface SavedMessage {
  id: string;
  role: "assistant" | "user";
  parts: (
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; filename?: string; url: string }
  )[];
  metadata?: {
    installation: Installation;
    sources?: KnowledgeSource[];
    solarChecks?: SolarCheck[];
  };
}
export interface SessionSnapshot {
  installation: Installation;
  messages: SavedMessage[];
  photos: Photo[];
  mode: "live" | "fixture";
  pending: boolean;
  aiProvider?: "OpenAI" | "Cloudflare AI";
}
export const turnSchema = z
  .object({
    id: z.string().min(1).max(100),
    text: z.string().trim().max(3000),
    photoIds: z.array(z.string().uuid()).max(6),
    action: z.enum(["message", "defer", "absent"]).default("message"),
  })
  .refine(
    (turn) => turn.text || turn.photoIds.length || turn.action !== "message",
    "Add a photo or a message.",
  );
export type Turn = z.infer<typeof turnSchema>;
export const editSchema = z.object({
  revision: z.number().int().nonnegative(),
  id: z.string().max(100),
  name: z.string().trim().min(1).max(160),
  brand: short.nullable(),
  model: short.nullable(),
  quantity: z.number().int().min(1).max(2000).nullable(),
});
export type EquipmentEdit = z.infer<typeof editSchema>;
export function manufacturerReference(item: Equipment) {
  if (normalized(item.brand) === "epever" && normalized(item.model) === "xtra4210n")
    return {
      title: "EPEVER XTRA-N manufacturer manual",
      url: "https://www.epever.com/upload/file/2107/XTRA-N-Manual-EN-V4.2-Software%20SV200.pdf",
      note: "Series reference found. Confirm the device and firmware revision before using specifications. Origin89 compatibility is not verified by this match.",
    };
  return null;
}
