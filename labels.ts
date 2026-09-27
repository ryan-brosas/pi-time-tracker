// Draft task-label registry for invoicing. Labels attach at write time from the
// request text and the tool names a turn used. They are heuristics to review
// before invoicing, not verified truth. Only the short key and its source are
// ever persisted; prompts and tool arguments are never stored.

export interface TaskLabel {
  key: string;
  name: string;
  promptPatterns: RegExp[];
  toolPatterns?: RegExp[];
}

// Priority order: first match wins, so the most specific categories come first.
export const TASK_LABELS: TaskLabel[] = [
  {
    key: "antibot",
    name: "Signup abuse defense (anti-bot)",
    promptPatterns: [/anti[- ]?bot/i, /anti[- ]?abuse/i, /signup[- ]?holds?/i, /customer[- ]?pulse/i, /bot (signups?|campaign|domains?)/i],
  },
  {
    key: "reddit",
    name: "Reddit research and engagement",
    promptPatterns: [/\breddit\b/i],
  },
  {
    key: "time-tracking",
    name: "Time tracking and reporting",
    promptPatterns: [/time[- ]?track/i, /tracker/i, /how many hours/i, /total hours/i, /hours (did|spent|we.?ve got)/i, /billable/i, /invoice/i, /timesheet/i, /work[- ]?time/i],
  },
  {
    key: "analytics",
    name: "Analytics and attribution support",
    promptPatterns: [/posthog/i, /attribution/i, /utm/i, /funnel/i, /signup source/i],
    toolPatterns: [/posthog/i],
  },
  {
    key: "appflowy-records",
    name: "AppFlowy records and audit trail",
    promptPatterns: [/appflowy/i, /daily log/i, /\beod\b/i, /time entries/i],
    toolPatterns: [/appflowy/i],
  },
  {
    key: "community",
    name: "Channel research and community engagement",
    promptPatterns: [/discord/i, /linkedin/i, /outreach/i, /engag/i, /community/i, /friend request/i, /\bdm\b/i],
  },
  {
    key: "design-system",
    name: "Design-system and branding groundwork",
    promptPatterns: [/component/i, /reusable/i, /button/i, /footer/i, /\bnav\b|navigation/i, /design system/i, /template deck/i, /brand/i, /typography/i, /font/i],
    toolPatterns: [/figma/i, /paper/i],
  },
  {
    key: "inspiration",
    name: "External inspiration and design research",
    promptPatterns: [/inspo\b|inspiration/i, /visual (reference|direction|map)/i, /brand kit/i],
  },
  {
    key: "sitemap-ia",
    name: "Information architecture and sitemap",
    promptPatterns: [/sitemap/i, /information architecture/i, /\bia\b/i, /\broutes?\b/i],
  },
  {
    key: "website-audit",
    name: "Website research and content audit",
    promptPatterns: [/trust center/i, /content audit/i, /website research/i],
  },
  {
    key: "automation",
    name: "Engagement automation and agent tooling",
    promptPatterns: [/localterm/i, /automat/i, /nonstop/i, /continu(ous|ously)/i, /schedul/i, /\bmcp\b/i],
  },
  {
    key: "incident",
    name: "Incident handling and follow-up",
    promptPatterns: [/malformed/i, /corrupt/i, /incident/i, /recovery investigation/i],
  },
];

export function labelFor(prompt?: string, toolNames?: string[]): { label: string; source: "prompt" | "tools" } | undefined {
  const text = (prompt ?? "").slice(0, 2000);
  if (text) {
    for (const def of TASK_LABELS) {
      if (def.promptPatterns.some(p => p.test(text))) return { label: def.key, source: "prompt" };
    }
  }
  const tools = toolNames ?? [];
  if (tools.length) {
    for (const def of TASK_LABELS) {
      if (def.toolPatterns?.some(p => tools.some(t => p.test(String(t))))) return { label: def.key, source: "tools" };
    }
  }
  return undefined;
}

export function resolveSessionLabel(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const match = labelFor(trimmed);
  if (match) return match.label;
  return trimmed.slice(0, 80);
}
