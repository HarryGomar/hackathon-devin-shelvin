import { router } from 'expo-router';
import { useState } from 'react';

import type { ProductIdentity, ScanType } from '@/api/types';
import { useSession } from '@/state/session';
import { Button, DemoNotice, EmptyState, ErrorBanner, Screen } from '@/ui';

import { EditForm } from './edit-form';
import { draftFrom, identityFromAlternative, identityFromDraft, splitAlternatives, type Alternative, type IdentityDraft } from './identity';
import { IdentityCard, IdentitySkeleton } from './identity-card';
import { InputSummary } from './input-summary';
import { NotQuite } from './not-quite';
import { SearchOptions } from './search-options';
import { strings } from './strings';
import { useIdentify } from './use-identify';

/** ② Confirm product: check what was identified, fix it if needed, choose what to search. */
export function ConfirmScreen() {
  const input = useSession((s) => s.input);
  const identity = useSession((s) => s.identity);
  const setIdentity = useSession((s) => s.setIdentity);
  const setScanOptions = useSession((s) => s.setScanOptions);
  const [scanType, setScanType] = useState<ScanType>(() => useSession.getState().scanType);
  const [includeSimilar, setIncludeSimilar] = useState(() => useSession.getState().includeSimilar);
  // 'manual' starts from empty fields (after an identify error), 'edit' from the current identity.
  const [editing, setEditing] = useState<false | 'edit' | 'manual'>(false);
  const { identifying, error, retry } = useIdentify();

  if (!input && !identity) {
    return (
      <Screen>
        <EmptyState
          icon="barcode.viewfinder"
          iconFallback="▥"
          title={strings.noInputTitle}
          message={strings.noInputMessage}
          action={{ title: strings.backHome, onPress: () => router.dismissTo('/') }}
        />
      </Screen>
    );
  }

  const photoUri = input?.kind === 'photo' ? input.uri : undefined;

  const save = (draft: IdentityDraft) => {
    setIdentity(identityFromDraft(draft, editing === 'edit' ? identity : undefined));
    setEditing(false);
  };
  const selectAlternative = (alt: Alternative) => {
    if (identity) setIdentity(identityFromAlternative(identity, alt, input));
  };
  const findPages = () => {
    setScanOptions({ scanType, includeSimilar });
    router.push('/sources');
  };

  return (
    <Screen
      footer={
        <Button
          title={strings.findPages}
          variant="primary"
          size="lg"
          end={{ icon: 'arrow.right', fallback: '→' }}
          disabled={identifying || !identity || editing !== false}
          onPress={findPages}
        />
      }>
      {input ? <InputSummary input={input} /> : null}

      {editing ? (
        <EditForm
          initial={editing === 'edit' ? draftFrom(identity, input) : draftFrom(undefined, input)}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : identifying ? (
        <IdentitySkeleton />
      ) : error ? (
        <>
          <ErrorBanner message={`${strings.identifyFailed}\n${error}`} onRetry={retry} />
          <Button title={strings.enterManually} variant="secondary" icon="pencil" iconFallback="✎" onPress={() => setEditing('manual')} />
        </>
      ) : identity ? (
        <IdentityResult identity={identity} photoUri={photoUri} onSelect={selectAlternative} onEdit={() => setEditing('edit')} />
      ) : null}

      {identity || identifying ? (
        <SearchOptions scanType={scanType} includeSimilar={includeSimilar} onScanTypeChange={setScanType} onIncludeSimilarChange={setIncludeSimilar} />
      ) : null}
    </Screen>
  );
}

function IdentityResult({
  identity,
  photoUri,
  onSelect,
  onEdit,
}: {
  identity: ProductIdentity;
  photoUri?: string;
  onSelect: (alt: Alternative) => void;
  onEdit: () => void;
}) {
  // Mock identification returns a canned product whatever was scanned: say so before anything else.
  const demo = identity.source === 'mock';
  return (
    <>
      {demo ? <DemoNotice label={strings.demoResult} message={strings.demoResultMessage} /> : null}
      <IdentityCard identity={identity} photoUri={photoUri} onSelectSize={onSelect} />
      <NotQuite alternatives={demo ? (identity.alternatives ?? []) : splitAlternatives(identity).others} demo={demo} onSelect={onSelect} onEdit={onEdit} />
    </>
  );
}
