// Strings for the developer console: watch and steer scraper builds.
import type { BuildControl } from '@/api/types';

export const strings = {
  title: 'Console',
  demo: 'Demo console',
  demoMessage: 'A scripted story from the demo backend: messages, stops and gate runs answer, but no real session runs.',
  loadFailed: "Couldn't load the builds.",
  buildFailed: "Couldn't load this build.",
  actingAs: 'Acting as',
  defaultActor: 'Harry',
  views: { builds: 'Builds', decisions: 'Decisions' },

  // Strip
  builders: 'Builders',
  buildersSub: (cost: string | undefined) => (cost ? `today ${cost}` : 'nothing spent today'),
  needsYou: 'Needs you',
  needsYouSub: (domain: string | undefined) => (domain ? `first: ${domain}` : 'all clear'),
  checks: 'Checks',
  checksSub: (paths: number, refused: number) => `failed gates · ${paths} allowed_paths · ${refused} refused`,

  // Board
  groups: { needs: 'Needs you', building: 'Building', queued: 'Queued', passed: 'Passed', failed: 'Failed' },
  asking: 'Asking',
  cutOff: 'Cut off',
  pick: 'Pick a build on the board.',
  back: '‹ Board',

  // Build pane
  stop: 'Stop',
  confirmStop: 'Stop? Tap again',
  gateNow: 'Gate now',
  retry: 'Another attempt',
  continues: (id: string) => `continues ${id}`,
  devinAsking: 'Devin is asking',
  answerBelow: 'Answer below',
  gateRunning: 'Gate run requested; waiting for the result',
  noEvents: 'Nothing recorded yet.',
  manual: 'manual',
  noControls: "This backend doesn't run the console yet.",
  tabs: { trace: 'Trace', decisions: 'Decisions', changes: 'Changes', gate: 'Gate', insights: 'Insights' },

  // Composer
  about: 'About',
  removeContext: 'Remove what the message is about',
  placeholder: 'Message Devin about this build',
  retryPlaceholder: 'A note for the next attempt',
  send: 'Send to Devin',
  retryWithNote: 'Another attempt with this note',
  cancelRetry: 'Cancel',
  sent: 'Sent. Devin answers in the trace.',
  retried: (id: string, same: boolean) => `Started ${id}${same ? ' in the same session' : ' in a fresh session'}.`,

  // Decisions
  decisionsEmpty: 'No decisions recorded yet.',
  startedFrom: 'Started from',
  from: (source: string) => `from ${source}`,
  statuses: { proposed: 'proposed', confirmed: (by: string) => `confirmed by ${by}`, changed: (by: string) => `changed by ${by}` },
  confirm: 'Confirm',
  other: 'Other…',
  otherPlaceholder: 'Another choice',
  whyPlaceholder: 'Why (optional)',
  change: 'Change',
  sentToBuilder: 'Sent to Devin.',

  // Changes
  changesHead: (head: string | null, base: string | null) => [head, base].filter(Boolean).join(' vs '),
  tooBig: 'Too big to show: only the counts.',
  noChanges: 'No changed files.',

  // Gate
  latestManual: (by: string | undefined) => (by ? `Manual gate · asked by ${by}` : 'Manual gate'),

  // Insights
  generate: 'Generate insights',
  analysing: 'Devin is analysing the session…',
  insightsFailed: "Devin couldn't analyse this session.",
  issues: 'Issues',
  actionItems: 'Action items',
  skillUsage: 'Skill usage',
  good: 'Good',
  bad: 'Bad',
  suggestedPrompt: 'Suggested prompt',
  original: 'Original',
  suggested: 'Suggested',
  timeline: 'Timeline',
  messages: (user: number, devin: number) => `${user} you · ${devin} Devin`,
  size: (size: string) => `size ${size.toUpperCase()}`,

  // Library
  libraryEmpty: 'No saved decisions yet. A passed build saves its decisions for the next similar one.',
  libraryIntro: 'What the next build with each reader starts from, and whether starting from it pays.',
  uses: (n: number) => (n === 1 ? '1 build' : `${n} builds`),
  fresh: 'Fresh',
  reusedCol: 'Reused',
  perf: { builds: 'Builds', passed: 'Passed', firstTry: 'First try', attempts: 'Avg attempts', acus: 'Avg ACU', minutes: 'Avg minutes' },
  dash: '—',

  controls: { message: 'Message', stop: 'Stop', retry: 'Another attempt', gate: 'Gate now', changes: 'Changes', insights: 'Insights', decide: 'Decide' } satisfies Record<BuildControl, string>,
};
