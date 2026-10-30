import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { BuildBatchResult, ScrapeSite, SimilarProduct, SourcePage } from '@/api/types';
import { apiMode, getApi, searchMode } from '@/api/client';
import { liveParts } from '@/features/home/mode';
import { identifyMode } from '@/services/identify';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { ProductHeader as ProductTitle } from '@/features/results';
import { retailerLabel } from '@/features/results/retailer';
import { Button, Cell, DemoNotice, EmptyState, ErrorBanner, GroupLabel, ProgressSteps, Row, Screen, SectionHeader, StatsStrip, StatusWord, Text, type ProgressStep } from '@/ui';

import { siteStateWord, skippedBySite, skippedReason } from './build-run';
import { errorText } from './errors';
import { PAGE_COLUMNS, PageRow, RejectedRow } from './page-row';
import { batchBuildPageIds, buildablePages, isScrapable } from './pages';
import { identityForSimilar, SimilarProductRows } from './similar-products';
import { strings } from './strings';
import { useScrapeFlow } from './use-scrape-flow';
import { useSearchFlow } from './use-search-flow';

// `search`, `verify`, `rank` come from the search job; `scrapers` is the matchScrapers call after it.
const SEARCH_STEPS: ProgressStep[] = [
  { key: 'search', label: strings.searchSteps.search },
  { key: 'verify', label: strings.searchSteps.verify },
  { key: 'rank', label: strings.searchSteps.rank },
  { key: 'scrapers', label: strings.searchSteps.scrapers },
];

// Pages are demo only when the mock backend runs its canned search (a live backend searches for real).
const LIVE = liveParts({ apiMode, searchMode, identifyMode });

const SCRAPE_STEPS: ProgressStep[] = [
  { key: 'scrape', label: strings.scrapeSteps.scrape },
  { key: 'taxonomy', label: strings.scrapeSteps.taxonomy },
  { key: 'save', label: strings.scrapeSteps.save },
];

/** ③ Pages found: run the search once, let the user pick pages and build missing scrapers, then scrape. */
export function SourcesScreen() {
  const { phase, retry, pause } = useSearchFlow();
  const identity = useSession((s) => s.identity);

  if (phase.kind === 'no-product' || !identity) {
    return (
      <Screen>
        <EmptyState
          icon="barcode.viewfinder"
          iconFallback="▦"
          title={strings.noProductTitle}
          message={strings.noProductMessage}
          action={{ title: strings.backHome, onPress: goHome }}
        />
      </Screen>
    );
  }

  if (phase.kind !== 'ready') {
    return (
      <Screen>
        <ProductHeader />
        {phase.kind === 'error' ? (
          <ErrorBanner message={`${strings.searchFailed} ${phase.message}`} onRetry={retry} />
        ) : (
          <View style={{ gap: 6 }}>
            <Text variant="label" color="secondary">
              {strings.searchTitle.toUpperCase()}
            </Text>
            <ProgressSteps
              steps={SEARCH_STEPS}
              currentKey={phase.kind === 'matching' ? 'scrapers' : phase.step}
              message={phase.kind === 'matching' ? strings.scrapersMessage : phase.message}
            />
          </View>
        )}
      </Screen>
    );
  }

  return <PagesFound onLeave={pause} />;
}

function goHome() {
  if (router.canDismiss()) router.dismissAll();
  else router.replace('/');
}

/** Product name and EAN, the search options in mono, and once pages are in, the found / verified / unsure / rejected strip. */
function ProductHeader() {
  const { spacing } = useTheme();
  const identity = useSession((s) => s.identity);
  const scanType = useSession((s) => s.scanType);
  const includeSimilar = useSession((s) => s.includeSimilar);
  const search = useSession((s) => s.search);
  const pages = useSession((s) => s.pages);
  if (!identity) return null;
  const options = [strings.scanType[scanType], includeSimilar ? strings.similarOn : strings.similarOff].join(' · ').toUpperCase();
  const count = (status: SourcePage['verification']['status']) => pages.filter((p) => p.verification.status === status).length;
  return (
    <View style={{ gap: spacing.md }}>
      <ProductTitle product={identity} note={options} />
      {!LIVE.search ? <DemoNotice label={strings.demoPages} message={strings.demoPagesMessage} /> : null}
      {search ? (
        <StatsStrip
          items={[
            { value: pages.length, label: strings.stats.found },
            { value: count('verified'), label: strings.stats.verified },
            { value: count('uncertain'), label: strings.stats.unsure, tone: 'warning' },
            { value: count('rejected'), label: strings.stats.rejected, tone: 'danger' },
          ]}
        />
      ) : null}
    </View>
  );
}

function PagesFound({ onLeave }: { onLeave: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const identity = useSession((s) => s.identity);
  const search = useSession((s) => s.search);
  const pages = useSession((s) => s.pages);
  const scanType = useSession((s) => s.scanType);
  const selectedPageIds = useSession((s) => s.selectedPageIds);
  const scrapedPageIds = useSession((s) => s.scrapedPageIds);
  const togglePage = useSession((s) => s.togglePage);
  const pickOtherProduct = useSession((s) => s.pickOtherProduct);
  const scrape = useScrapeFlow();
  const [showRejected, setShowRejected] = useState(false);

  const accepted = pages.filter((p) => p.verification.status !== 'rejected');
  const rejected = pages.filter((p) => p.verification.status === 'rejected');
  const official = accepted.filter((p) => p.matchType === 'exact' && p.sourceType === 'first_party');
  const retailers = accepted.filter((p) => p.matchType === 'exact' && p.sourceType === 'third_party');
  const similarGroups = groupSimilar(accepted.filter((p) => p.matchType === 'similar'), search?.similarProducts ?? []);
  const similarProducts = search?.similarProducts ?? [];

  const scrapable = new Set(pages.filter(isScrapable).map((p) => p.id));
  const selectedIds = selectedPageIds.filter((id) => scrapable.has(id));

  const renderRows = (list: SourcePage[]) =>
    list.map((p) => (
      <PageRow
        key={p.id}
        page={p}
        productId={identity?.id}
        selected={selectedPageIds.includes(p.id)}
        scraped={scrapedPageIds.includes(p.id)}
        onToggle={() => togglePage(p.id)}
      />
    ));

  const pickSimilar = (s: SimilarProduct) => {
    onLeave();
    pickOtherProduct(identityForSimilar(s));
    // Back to the Confirm screen below instead of pushing a second one.
    router.dismissTo('/confirm');
  };

  const footer = (
    <>
      {scrape.error ? <ErrorBanner message={`${strings.scrapeFailed} ${scrape.error}`} onRetry={() => scrape.start(selectedIds)} /> : null}
      <Button
        title={selectedIds.length > 0 ? strings.scrapeN(selectedIds.length) : strings.scrapeNone}
        size="lg"
        end={strings.scrapeCount(selectedIds.length, scrapable.size)}
        disabled={selectedIds.length === 0}
        loading={scrape.scraping}
        onPress={() => scrape.start(selectedIds)}
      />
    </>
  );

  return (
    <View style={styles.flex}>
      <Screen footer={footer}>
        <ProductHeader />

        <View>
          {scanType !== 'third_party' || official.length > 0 ? (
            <Group label={strings.official} count={official.length} header>
              {renderRows(official)}
            </Group>
          ) : null}

          {scanType !== 'first_party' || retailers.length > 0 ? (
            <Group label={strings.retailers} count={retailers.length} header={scanType === 'third_party' && official.length === 0}>
              {renderRows(retailers)}
            </Group>
          ) : null}

          {similarGroups.map((g) => (
            <Group key={g.key} label={strings.similarPages(g.title)} count={g.pages.length}>
              {renderRows(g.pages)}
            </Group>
          ))}

          {rejected.length > 0 ? (
            <View>
              <GroupLabel label={strings.rejected(rejected.length)} onPress={() => setShowRejected((v) => !v)} expanded={showRejected} />
              {showRejected ? (
                <>
                  <Text variant="mono" color="secondary" style={{ paddingTop: spacing.sm }}>
                    {strings.rejectedHint}
                  </Text>
                  {rejected.map((p) => (
                    <RejectedRow key={p.id} page={p} />
                  ))}
                </>
              ) : null}
            </View>
          ) : null}
        </View>

        <BuildAll productId={identity?.id} />

        <Button title={strings.addPage} variant="secondary" onPress={() => router.push('/add-source')} />

        {similarProducts.length > 0 ? (
          <View>
            <SectionHeader title={strings.similar} subtitle={strings.similarHint} />
            <SimilarProductRows products={similarProducts} onPick={pickSimilar} />
          </View>
        ) : null}
      </Screen>

      {scrape.scraping ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.overlay, padding: spacing.xl }]}>
          <View style={[styles.overlayCard, { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background, borderColor: colors.text, borderRadius: radius.lg }]}>
            <Text variant="label" color="secondary">
              {strings.scrapingTitle.toUpperCase()}
            </Text>
            <ProgressSteps steps={SCRAPE_STEPS} currentKey={scrape.step} message={scrape.message} />
            {scrape.sites?.length ? <SiteProgress sites={scrape.sites} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * "Build all missing": one build per site without a scraper, in parallel (POST /scrapers/build-batch). Each build
 * shows in its site's row; the pages the backend skipped are listed with the reason.
 */
function BuildAll({ productId }: { productId?: string }) {
  const { spacing } = useTheme();
  const pages = useSession((s) => s.pages);
  const builds = useSession((s) => s.builds);
  const trackBuild = useSession((s) => s.trackBuild);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<BuildBatchResult>();

  const isRunning = (domain: string) => builds[domain]?.status === 'queued' || builds[domain]?.status === 'running';
  const missing = buildablePages(pages).filter((p) => !isRunning(p.domain));
  const running = new Set(pages.map((p) => p.domain).filter(isRunning)).size;
  if (missing.length === 0 && running === 0 && !result) return null;

  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      const batch = await getApi().startBuildBatch({ productId, pageIds: batchBuildPageIds(pages) });
      for (const b of batch.builds) if (!b.duplicate) trackBuild(b.domain, b.jobId, b.pageId);
      setResult(batch);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const skipped = skippedBySite(result?.skipped.filter((k) => k.code !== 'has_scraper' && k.reason !== 'already has a scraper') ?? []);
  const byId = new Map(pages.map((p) => [p.id, p]));
  return (
    <View style={{ gap: spacing.sm }}>
      <GroupLabel
        label={strings.missingScrapers(missing.length)}
        right={
          running > 0 ? (
            <Text variant="label" color="accent">
              {strings.buildsRunning(running).toUpperCase()}
            </Text>
          ) : undefined
        }
      />
      {missing.length > 0 ? (
        <>
          <Text variant="caption" color="secondary">
            {strings.buildAllHint(missing.length, result?.parallel)}
          </Text>
          <Button title={strings.buildAll(missing.length)} variant="secondary" loading={starting} onPress={start} />
        </>
      ) : null}
      {error ? <ErrorBanner message={`${strings.buildAllFailed} ${error}`} onRetry={start} /> : null}
      {result ? (
        <Text variant="mono" color="secondary">
          {strings.buildAllStarted(result.builds.filter((b) => !b.duplicate).length, result.parallel)}
        </Text>
      ) : null}
      {skipped.length > 0 ? (
        <View>
          <Text variant="label" color="secondary">
            {strings.skippedTitle(skipped.length).toUpperCase()}
          </Text>
          {skipped.map((k) => (
            <Row key={k.pageId}>
              <Cell>
                <Text variant="subheading" numberOfLines={1}>
                  {retailerLabel(byId.get(k.pageId)?.retailerName ?? k.domain ?? k.pageId).name}
                  {k.pages > 1 ? <Text variant="mono" color="secondary">{`  ${strings.pagesCount(k.pages)}`}</Text> : null}
                </Text>
                <Text variant="mono" color="secondary">
                  {skippedReason(k)}
                </Text>
              </Cell>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** While scraping: one row per page with the site's state (waiting, reading, done, failed, refused) and rows read. */
function SiteProgress({ sites }: { sites: ScrapeSite[] }) {
  return (
    <View>
      <GroupLabel label={strings.sitesTitle} />
      <ScrollView style={styles.sites} nestedScrollEnabled>
        {sites.map((site) => (
          <Row key={site.pageId} style={styles.siteRow}>
            <Cell>
              <Text variant="subheading" numberOfLines={1}>
                {retailerLabel(site.retailerName).name}
              </Text>
              <Text variant="mono" color="secondary" numberOfLines={1}>
                {site.message}
              </Text>
            </Cell>
            <Cell width={60} align="right">
              <Text variant="mono" color="secondary">
                {site.rows > 0 ? strings.siteRows(site.rows) : ''}
              </Text>
            </Cell>
            <Cell width={66} align="right">
              <StatusWord {...siteStateWord(site.state)} />
            </Cell>
          </Row>
        ))}
      </ScrollView>
    </View>
  );
}

/** One group of the pages table: dashed label with its count (the first one also names the MATCH and STATUS columns). */
function Group({ label, count, header, children }: { label: string; count: number; header?: boolean; children: ReactNode }) {
  const columns = header ? (
    <View style={styles.columns}>
      <Text variant="label" color="secondary" style={[styles.colText, { width: PAGE_COLUMNS.match }]}>
        {strings.matchColumn.toUpperCase()}
      </Text>
      <Text variant="label" color="secondary" style={[styles.colText, { width: PAGE_COLUMNS.status }]}>
        {strings.statusColumn.toUpperCase()}
      </Text>
    </View>
  ) : undefined;
  return (
    <View>
      <GroupLabel label={strings.groupCount(label, count)} right={columns} />
      {count === 0 ? (
        <Text variant="mono" color="secondary" style={styles.empty}>
          {strings.noPagesInSection}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

/** Similar-product pages grouped by product, in the order of `similarProducts`. */
function groupSimilar(pages: SourcePage[], products: SimilarProduct[]) {
  const groups = new Map<string, { key: string; title: string; pages: SourcePage[] }>();
  for (const s of products) groups.set(s.id, { key: s.id, title: s.productName, pages: [] });
  for (const p of pages) {
    const key = p.similarProductId ?? 'other';
    if (!groups.has(key)) groups.set(key, { key, title: key, pages: [] });
    groups.get(key)!.pages.push(p);
  }
  return [...groups.values()].filter((g) => g.pages.length > 0);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  columns: { flexDirection: 'row', gap: 10 },
  colText: { textAlign: 'right' },
  empty: { paddingVertical: 10 },
  overlay: { alignItems: 'center', justifyContent: 'center' },
  overlayCard: { width: '100%', maxWidth: 420, borderWidth: 1, maxHeight: '90%' },
  sites: { maxHeight: 260 },
  siteRow: { paddingVertical: 7 },
});
