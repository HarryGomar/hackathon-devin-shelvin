import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { getApi } from '@/api/client';
import type { SourcePage } from '@/api/types';
import { useSession, type BuildEntry } from '@/state/session';
import { useTheme, type Tone } from '@/theme';
import { failureReasonLabel, isBlockedCode } from '@/features/results/failure-reason';
import { retailerLabel } from '@/features/results/retailer';
import { Cell, CheckMark, RetailerLogo, Row, StatusWord, Text } from '@/ui';

import { BuildPanel } from './build-panel';
import { buildStateWord, builtSummary, runningSummary } from './build-run';
import { errorText } from './errors';
import { strings } from './strings';

const VERIFICATION: Record<SourcePage['verification']['status'], { label: string; tone: Tone }> = {
  verified: { label: strings.verified, tone: 'success' },
  uncertain: { label: strings.unsure, tone: 'warning' },
  user_added: { label: strings.userAdded, tone: 'info' },
  rejected: { label: strings.rejectedBadge, tone: 'danger' },
};

// Column widths shared with the table header in sources-screen.
export const PAGE_COLUMNS = { check: 18, match: 44, status: 74 };

interface PageRowProps {
  page: SourcePage;
  productId?: string;
  selected: boolean;
  scraped: boolean;
  onToggle: () => void;
}

/**
 * One page found by the search, as a table row: checkbox | logo + store + domain | match % | status.
 * A "↳" line under it gives the reason for Unsure pages, or the scraper state with "build" when the site has none,
 * or "BLOCKED" with the reason when `access` is refused (no build, no way around it; the site's official
 * alternative, if any, under it).
 */
export function PageRow({ page, productId, selected, scraped, onToggle }: PageRowProps) {
  const [showReason, setShowReason] = useState(false);
  const refused = page.access?.status === 'refused';
  const available = page.scraper.status === 'available' && !refused;
  const unsure = page.verification.status === 'uncertain';
  const build = useSession((s) => s.builds[page.domain]);
  const lines: ReactNode[] = [];
  if (unsure || showReason) lines.push(<SubLine key="reason" tone={unsure ? 'warning' : 'neutral'} text={page.verification.reason.toLowerCase()} />);
  if (refused) lines.push(<BlockedLines key="blocked" page={page} />);
  else if (!available) lines.push(<ScraperLine key="scraper" page={page} productId={productId} entry={build} />);
  else if (build?.status === 'succeeded' && build.run) lines.push(<BuiltLine key="built" entry={build} />);
  if (scraped) lines.push(<SubLine key="scraped" tone="success" text={strings.scrapedLine} />);

  return (
    <View>
      <Row rule={lines.length ? 'none' : 'solid'}>
        {available ? (
          // Checkbox and name are one target; the status word is its own button, so they sit side by side, not nested.
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={strings.selectPage(page.retailerName)}
            onPress={onToggle}
            style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}>
            <View style={[styles.check, { width: PAGE_COLUMNS.check }]}>
              <CheckMark checked={selected} />
            </View>
            <PageName page={page} />
          </Pressable>
        ) : (
          <>
            <View style={[styles.check, { width: PAGE_COLUMNS.check }]}>
              <CheckMark checked={false} unavailable />
            </View>
            <PageName page={page} />
          </>
        )}
        <Cell width={PAGE_COLUMNS.match} align="right">
          <Text variant="mono" style={styles.cellText}>
            {strings.percent(page.verification.confidence)}
          </Text>
        </Cell>
        <Cell width={PAGE_COLUMNS.status} align="right">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${VERIFICATION[page.verification.status].label}: ${page.verification.reason}`}
            onPress={() => setShowReason((v) => !v)}
            hitSlop={8}
            style={styles.statusHit}>
            <StatusWord {...VERIFICATION[page.verification.status]} />
          </Pressable>
        </Cell>
      </Row>
      {lines.length ? <SubRows>{lines}</SubRows> : null}
    </View>
  );
}

/** A page the agent rejected: struck-through name, never selectable, its reason in red. */
export function RejectedRow({ page }: { page: SourcePage }) {
  return (
    <View>
      <Row rule="none">
        <View style={{ width: PAGE_COLUMNS.check }} />
        <PageName page={page} struck />
        <Cell width={PAGE_COLUMNS.match} align="right">
          <Text variant="mono" color="secondary" style={styles.cellText}>
            {strings.percent(page.verification.confidence)}
          </Text>
        </Cell>
        <Cell width={PAGE_COLUMNS.status} align="right">
          <View style={styles.statusHit}>
            <StatusWord {...VERIFICATION.rejected} />
          </View>
        </Cell>
      </Row>
      <SubRows>
        <SubLine tone="danger" text={page.verification.reason} />
        {page.access?.status === 'refused' ? <BlockedLines page={page} /> : null}
      </SubRows>
    </View>
  );
}

function PageName({ page, struck }: { page: SourcePage; struck?: boolean }) {
  const { spacing } = useTheme();
  const { name } = retailerLabel(page.retailerName, page.sourceType);
  return (
    <Cell>
      <View style={[styles.nameRow, { gap: spacing.sm }]}>
        <RetailerLogo domain={page.domain} name={name} size={18} />
        <Text variant="subheading" color={struck ? 'secondary' : 'text'} numberOfLines={1} style={[styles.shrink, struck && styles.struck]}>
          {name}
        </Text>
      </View>
      <Text variant="mono" color="secondary" numberOfLines={1} style={styles.domain}>
        {page.domain}
      </Text>
    </Cell>
  );
}

/** Indented "↳" lines under a row, closed by the row's hairline. */
function SubRows({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[styles.subRows, { borderBottomColor: colors.border, paddingLeft: PAGE_COLUMNS.check + 10 }]}>{children}</View>;
}

function SubLine({
  text,
  tone,
  action,
  secondAction,
  accessibilityLabel,
}: {
  text: string;
  tone: Tone;
  action?: { label: string; onPress: () => void };
  secondAction?: { label: string; onPress: () => void };
  accessibilityLabel?: string;
}) {
  const color = tone === 'warning' ? 'warning' : tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'secondary';
  return (
    <View style={styles.subLine} accessible={accessibilityLabel ? true : undefined} accessibilityLabel={accessibilityLabel}>
      <Text variant="mono" color={color} style={styles.shrink}>
        ↳ {text}
      </Text>
      {action ? <SubAction {...action} /> : null}
      {secondAction ? <SubAction {...secondAction} /> : null}
    </View>
  );
}

function SubAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={12}>
      {({ pressed }) => (
        <Text variant="mono" color="accent" style={[styles.action, pressed && styles.pressed]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** "↳ BLOCKED · this site blocks AI agents" and "↳ instead: <official API>": the site's refusal, with nothing to press. */
function BlockedLines({ page }: { page: SourcePage }) {
  const access = page.access;
  if (!access) return null;
  const reason = failureReasonLabel(access.code, access.label ?? access.reason);
  const line = isBlockedCode(access.code) ? strings.blockedLine(reason) : strings.notCollectedLine(reason);
  return (
    <>
      <SubLine tone="danger" text={line} accessibilityLabel={strings.blockedA11y(page.retailerName, access.reason)} />
      {access.alternative ? <SubLine tone="neutral" text={strings.insteadLine(access.alternative)} /> : null}
    </>
  );
}

/**
 * "↳ no scraper yet · build" for sites without a scraper. The build lives in the session (shared with
 * "Build all missing" and Add a page): while it runs the line names the agent and attempt, with the live build panel
 * under it (open on the row it was started for); a failed build says why, with retry and the gate report.
 */
function ScraperLine({ page, productId, entry }: { page: SourcePage; productId?: string; entry?: BuildEntry }) {
  const { colors, spacing } = useTheme();
  const trackBuild = useSession((s) => s.trackBuild);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [open, setOpen] = useState<boolean>();

  const build = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      const created = await getApi().startBuildScraper({ url: page.url, productId, pageId: page.id });
      trackBuild(page.domain, created.jobId, page.id);
      setOpen(true);
    } catch (e) {
      setStartError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const running = entry && (entry.status === 'queued' || entry.status === 'running');
  const failed = entry?.status === 'failed';
  const showPanel = entry && (open ?? (running && (entry.pageId === undefined || entry.pageId === page.id)));
  const toggle = { label: showPanel ? strings.hideDetails : strings.details, onPress: () => setOpen(!showPanel) };

  if (starting) {
    return (
      <View style={[styles.building, { gap: spacing.sm }]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={colors.accent} />
        <Text variant="mono" style={styles.flex}>
          {strings.buildingScraper.toLowerCase()}
        </Text>
      </View>
    );
  }
  if (entry && (running || failed)) {
    const line = running
      ? runningSummary(entry.run, entry.status)
      : strings.buildEndedLine(buildStateWord(entry.run?.state, entry.status).label, entry.run?.note ?? entry.error ?? strings.scraperFailed);
    // The whole recording (Build screen, GET /builds/:id) while it runs.
    const buildId = entry.run?.buildId;
    const trace = buildId ? { label: strings.traceShort, onPress: () => router.push({ pathname: '/builds/[id]', params: { id: buildId } }) } : undefined;
    return (
      <>
        <SubLine tone={running ? 'neutral' : 'danger'} text={line} action={toggle} secondAction={failed ? { label: strings.retryBuildShort, onPress: build } : trace} />
        {showPanel ? <BuildPanel entry={entry} /> : null}
      </>
    );
  }
  const error = startError ?? (page.scraper.status === 'failed' ? strings.scraperFailed : undefined);
  if (error) return <SubLine tone="danger" text={error.toLowerCase()} action={{ label: strings.retryBuildShort, onPress: build }} />;
  return <SubLine tone="neutral" text={strings.noScraper} action={{ label: strings.buildShort, onPress: build }} />;
}

/** "↳ built by Devin · attempt 2 of 3 · gate 14/14 · details": which agent made this site's scraper. */
function BuiltLine({ entry }: { entry: BuildEntry }) {
  const [open, setOpen] = useState(false);
  if (!entry.run) return null;
  return (
    <>
      <SubLine tone="success" text={builtSummary(entry.run)} action={{ label: open ? strings.hideDetails : strings.details, onPress: () => setOpen((v) => !v) }} />
      {open ? <BuildPanel entry={entry} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  building: { flexDirection: 'row', alignItems: 'center', minHeight: 20 },
  check: { paddingTop: 1 },
  toggle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  domain: { marginTop: 2, marginLeft: 26 },
  struck: { textDecorationLine: 'line-through' },
  cellText: { lineHeight: 20 },
  statusHit: { minHeight: 20, justifyContent: 'center' },
  subRows: { paddingBottom: 10, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: -4 },
  subLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, minHeight: 20 },
  action: { fontWeight: '700', textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
