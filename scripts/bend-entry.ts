// Build-time entry: bundled by scripts/build-bend.mjs into generated/policy.mjs.
// Only the side-effect-free accounting functions cross into the package.
import Engine from "../engine.bend";
import Audit from "../audit.bend";

type Maybe = { $: "Some"; value: string } | { $: "None" };
type Pure = Record<string, (text: string) => Maybe>;

const engine = Engine as unknown as Pure;
const audit = Audit as unknown as Pure;

export const evaluateIntervals = (text: string): Maybe => engine.evaluate(text);
export const evaluateAudit = (text: string): Maybe => audit.evaluate(text);
