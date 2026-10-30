import { StyleSheet, View } from 'react-native';

import type { ScrapeFailure, SourcePage } from '@/api/types';
import { useTheme } from '@/theme';
import { Cell, RetailerLogo, Row, SectionHeader, Text } from '@/ui';

import { failureReasonLabel, splitFailures } from './failure-reason';
import { domainOf } from './format';
import { strings } from './strings';

/**
 * Pages that weren't fetched, in two tables: "Blocked by the site" (robots.txt, AI-agent opt-out, 401/403/429),
 * which offers no way around the block, and "Couldn't fetch" (timeouts and the rest), with `retryHint` under it.
 */
export function FailuresCard({ failures, pages, retryHint }: { failures: ScrapeFailure[]; pages: SourcePage[]; retryHint: string }) {
  const { blocked, failed } = splitFailures(failures);
  return (
    <>
      {blocked.length > 0 ? (
        <View>
          <SectionHeader title={strings.blockedTitle(blocked.length)} subtitle={strings.blockedSubtitle} />
          {blocked.map((failure, i) => (
            <FailureRow key={`${failure.pageId}-${i}`} failure={failure} pages={pages} blocked />
          ))}
        </View>
      ) : null}
      {failed.length > 0 ? (
        <View>
          <SectionHeader title={strings.failuresTitle(failed.length)} subtitle={retryHint} />
          {failed.map((failure, i) => (
            <FailureRow key={`${failure.pageId}-${i}`} failure={failure} pages={pages} />
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Store and domain (or URL), then "↳ reason" and the backend's own detail when it says more. */
function FailureRow({ failure, pages, blocked }: { failure: ScrapeFailure; pages: SourcePage[]; blocked?: boolean }) {
  const { spacing } = useTheme();
  const page = pages.find((p) => p.id === failure.pageId);
  const domain = page?.domain ?? domainOf(failure.url);
  const name = page?.retailerName ?? failure.retailerName ?? domain ?? failure.pageId;
  const label = failureReasonLabel(failure.code, failure.error);
  const where = blocked ? domain : failure.url;
  return (
    <Row>
      <Cell>
        <View style={[styles.store, { gap: spacing.sm }]}>
          <RetailerLogo domain={domain ?? ''} name={name} size={20} />
          <Text variant="subheading" numberOfLines={1} style={styles.shrink}>
            {name}
          </Text>
        </View>
        {where ? (
          <Text variant="mono" color="secondary" numberOfLines={1} style={styles.sub}>
            {where}
          </Text>
        ) : null}
        <Text variant="mono" color={blocked ? 'danger' : 'warning'} style={styles.sub}>
          ↳ {label}
        </Text>
        {label !== failure.error ? (
          <Text variant="mono" color="secondary" style={styles.detail}>
            {failure.error}
          </Text>
        ) : null}
      </Cell>
    </Row>
  );
}

const styles = StyleSheet.create({
  store: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
  sub: { marginTop: 2, marginLeft: 28 },
  // Lines up under the reason, after "↳ ".
  detail: { marginTop: 2, marginLeft: 44 },
});
