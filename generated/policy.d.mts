// Hand-written types for the generated policy module.
export type BendMaybe = { $: "Some"; value: string } | { $: "None" };
/** Interval totals as `group,total` rows, or `None` for an invalid batch. */
export declare function evaluateIntervals(text: string): BendMaybe;
/** Receipt audit rows as `group,status,durableMs,copies`, or `None` when invalid. */
export declare function evaluateAudit(text: string): BendMaybe;
