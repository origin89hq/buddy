// One entry per source adapter. `discover` lists the pages to snapshot; `records`
// turns one pinned source file into validated records. Feeds without discovery
// (Victron manuals, EPEVER PDFs, reviewed Discover model URLs) come from
// manufacturer-feeds.json and only need `records`.
import { smartShuntRecords, victronRecords } from "../manufacturer-adapters.mjs";
import { inverterPdfRecords, mpptPdfRecords } from "../manufacturer-pdf-adapters.mjs";
import * as discover from "./discover.mjs";
import * as duromax from "./duromax.mjs";
import * as morningstar from "./morningstar.mjs";
import * as outback from "./outback.mjs";
import * as rolls from "./rolls.mjs";
import * as samlex from "./samlex.mjs";
import * as schneider from "./schneider.mjs";
import * as solark from "./solark.mjs";
import * as usBattery from "./us-battery.mjs";
import * as volthium from "./volthium.mjs";
import * as yilink from "./yilink.mjs";

export const adapters = {
  rolls,
  "victron-mppt": { records: victronRecords },
  smartshunt: { records: smartShuntRecords },
  "epever-inverter": { records: inverterPdfRecords },
  "epever-mppt": { records: mpptPdfRecords },
  "us-battery": usBattery,
  morningstar,
  yilink,
  duromax,
  discover,
  volthium,
  solark,
  samlex,
  outback,
  schneider,
};
export const adapterFiles = [
  "index.mjs",
  "rolls.mjs",
  "us-battery.mjs",
  "morningstar.mjs",
  "yilink.mjs",
  "duromax.mjs",
  "discover.mjs",
  "pdf-text.mjs",
  "volthium.mjs",
  "solark.mjs",
  "samlex.mjs",
  "outback.mjs",
  "schneider.mjs",
].map((f) => `scripts/adapters/${f}`);
