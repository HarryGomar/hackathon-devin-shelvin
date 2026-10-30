import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { getApi } from '@/api/client';
import { failureReasonLabel, isBlockedCode } from '@/features/results/failure-reason';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { Button, ErrorBanner, Screen, Text } from '@/ui';

import { BuildPanel } from './build-panel';
import { domainOfUrl } from './build-run';
import { errorText } from './errors';
import { isValidPageUrl } from './pages';
import { strings } from './strings';

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/sources');
}

/** Modal: paste a product page URL, build a scraper for its site, add the page to the list. */
export function AddSourceScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const productId = useSession((s) => s.identity?.id);
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [mine, setMine] = useState<{ jobId: string; domain: string; url: string }>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const trackBuild = useSession((s) => s.trackBuild);
  // The build itself lives in the session (the root layout polls it), so Pages found shows it too.
  const tracked = useSession((s) => (mine ? s.builds[mine.domain] : undefined));
  const entry = tracked && tracked.jobId === mine?.jobId ? tracked : undefined;

  useEffect(() => {
    if (entry?.status === 'succeeded') close();
  }, [entry?.status]);

  const valid = isValidPageUrl(url);
  const running = entry?.status === 'queued' || entry?.status === 'running';
  const building = starting || running || entry?.status === 'succeeded';
  const failed = entry?.status === 'failed' && mine?.url === url.trim();
  // The site doesn't allow scraping: say so, with no Try again, and no Build for that same URL.
  const access = failed ? entry.run?.access : undefined;
  const refused = access?.status === 'refused' && entry?.run?.state === 'refused';
  const blocked = refused ? failureReasonLabel(access.code, access.label ?? access.reason) : undefined;
  // Same words as Pages found: BLOCKED when the site said no, NOT COLLECTED otherwise.
  const refusalMessage = blocked && (isBlockedCode(access?.code) ? strings.buildBlocked(blocked) : strings.buildNotCollected(blocked));
  const error = startError ?? (failed && !refused ? (entry.error ?? entry.run?.note) : undefined);

  const build = async () => {
    setTouched(true);
    if (!valid) return;
    setStarting(true);
    setStartError(undefined);
    const sent = url.trim();
    try {
      const created = await getApi().startBuildScraper({ url: sent, productId });
      const domain = created.agentRun?.domain ?? domainOfUrl(sent);
      // Track first: a refusal arrives on the first poll.
      trackBuild(domain, created.jobId);
      setMine({ jobId: created.jobId, domain, url: sent });
    } catch (e) {
      setStartError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const showInvalid = touched && url.trim().length > 0 && !valid;

  return (
    <Screen
      footer={
        <>
          <Button title={strings.buildScraper} size="lg" end={{ icon: 'arrow.right', fallback: '→' }} loading={building} disabled={!valid || !!blocked} onPress={build} />
          <Button title={strings.cancel} variant="ghost" onPress={close} />
        </>
      }>
      <Text variant="caption" color="secondary">
        {strings.addIntro}
      </Text>

      <View style={{ gap: spacing.sm }}>
        <Text variant="label" color="secondary">
          {strings.urlLabel.toUpperCase()}
        </Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          onBlur={() => setTouched(true)}
          onSubmitEditing={blocked ? undefined : build}
          editable={!building}
          placeholder={strings.urlPlaceholder}
          placeholderTextColor={colors.textSecondary}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="url"
          inputMode="url"
          returnKeyType="go"
          accessibilityLabel={strings.urlLabel}
          style={[
            typography.mono,
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.background,
              borderColor: showInvalid ? colors.danger : colors.text,
              borderRadius: radius.lg,
              paddingHorizontal: spacing.md,
            },
          ]}
        />
        {showInvalid ? (
          <Text variant="mono" color="danger">
            {strings.urlInvalid}
          </Text>
        ) : null}
      </View>

      {refusalMessage ? (
        <ErrorBanner message={refusalMessage} />
      ) : error ? (
        <ErrorBanner message={`${strings.buildFailed} ${error}`} onRetry={build} />
      ) : null}
      {entry && !refused ? <BuildPanel entry={entry} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, fontSize: 14 },
});
