import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/context.js';
import { useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Button, CoreHubMark } from '../ui/index.js';

/**
 * A member enters only the profiles an admin gave them, and an empty list means none (owner,
 * 2026-09-24: «المفروض ما يضيفه له بدون ما ادخل انا واضيفه له»). Such a member can sign in,
 * but every page would only collect "profile not found" answers — so they get one page that
 * says what is going on and who can change it, instead of a shell full of errors.
 *
 * Owners and admins always have profiles (`default` cannot be archived); while the list is
 * loading, or if it cannot be read, the app renders as usual and each page reports its own.
 *
 * A member whose remembered profile is no longer among theirs — taken away, or archived — but
 * who still has others is moved to the first of those, the same one "Check again" opens.
 */
export function ProfileGate({ children }: { children: ReactNode }) {
  const { user, profile, setProfile } = useAuth();
  const profiles = useProfiles();
  const member = user?.role === 'member';
  // The profile this device remembers was taken from the member (or archived) while others are
  // still theirs: open the first one they were given instead of pages that each answer "not
  // found" (owner follow-up to 2026-09-24's explicit grants).
  const first = profiles.data?.[0]?.slug;
  const lost = member && !!first && !profiles.data?.some((p) => p.slug === profile);
  useEffect(() => {
    if (lost && first) setProfile(first);
  }, [lost, first, setProfile]);
  if (member && profiles.data && profiles.data.length === 0) {
    return <NoProfile onRetry={() => profiles.refetch()} />;
  }
  // One render while the switch lands, so nothing asks the hub about the lost profile.
  if (lost) return null;
  return <>{children}</>;
}

function NoProfile({
  onRetry,
}: {
  onRetry(): Promise<{ data?: Array<{ slug: string }> | undefined }>;
}) {
  const { t } = useI18n();
  const { profile, setProfile, signOut } = useAuth();
  const [checking, setChecking] = useState(false);

  const retry = async () => {
    setChecking(true);
    try {
      const { data } = await onRetry();
      // Granted since: open the first profile they were given, not the one the sign-in named.
      const first = data?.[0];
      if (first && !data.some((p) => p.slug === profile)) setProfile(first.slug);
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="gate">
      <section
        className="gate-card glass"
        aria-labelledby="no-profile-title"
        data-testid="no-profile"
      >
        <header className="gate-head">
          <span className="gate-mark" aria-hidden>
            <CoreHubMark size={36} />
          </span>
          <div className="gate-headings">
            <h1 id="no-profile-title" className="gate-title">
              {t('shell.no_profile_title')}
            </h1>
          </div>
        </header>
        <p className="text-sm">{t('shell.no_profile_body')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={checking} onClick={() => void retry()}>
            {t('shell.no_profile_retry')}
          </Button>
          <Button variant="ghost" onClick={() => void signOut()} data-testid="no-profile-sign-out">
            {t('nav.sign_out')}
          </Button>
        </div>
      </section>
    </main>
  );
}
