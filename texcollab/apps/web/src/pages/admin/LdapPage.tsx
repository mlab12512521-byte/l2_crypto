import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LDAP_DEFAULT_MEMBERSHIP_FILTER,
  LDAP_DEFAULT_USER_FILTER,
  type LdapSettings,
  type LdapSettingsView,
  type LdapTestResult,
} from '@texcollab/shared';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Field, fieldErrors, Spinner } from '../../components/ui';

type Form = Omit<LdapSettings, 'timeoutSeconds' | 'bindDn' | 'caCertificate' | 'requiredGroupDn' | 'adminGroupDn'> & {
  timeoutSeconds: string;
  bindDn: string;
  caCertificate: string;
  requiredGroupDn: string;
  adminGroupDn: string;
};

function toForm(v: LdapSettingsView): Form {
  return {
    enabled: v.enabled,
    url: v.url,
    startTls: v.startTls,
    allowUnencrypted: v.allowUnencrypted,
    caCertificate: v.caCertificate ?? '',
    bindDn: v.bindDn ?? '',
    userSearchBase: v.userSearchBase,
    userFilter: v.userFilter,
    usernameAttribute: v.usernameAttribute,
    displayNameAttribute: v.displayNameAttribute,
    emailAttribute: v.emailAttribute,
    requiredGroupDn: v.requiredGroupDn ?? '',
    adminGroupDn: v.adminGroupDn ?? '',
    groupMembershipFilter: v.groupMembershipFilter,
    timeoutSeconds: String(v.timeoutSeconds),
  };
}

function toSettings(f: Form): LdapSettings {
  return {
    ...f,
    timeoutSeconds: Number(f.timeoutSeconds),
    bindDn: f.bindDn.trim() || null,
    caCertificate: f.caCertificate.trim() || null,
    requiredGroupDn: f.requiredGroupDn.trim() || null,
    adminGroupDn: f.adminGroupDn.trim() || null,
  };
}

/** Bind password edit state: keep the stored one, replace it, or remove it. */
type PasswordChange = { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'remove' };

function passwordPayload(p: PasswordChange): { bindPassword?: string | null } {
  if (p.kind === 'set') return { bindPassword: p.value };
  if (p.kind === 'remove') return { bindPassword: null };
  return {};
}

export function LdapPage() {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['admin', 'ldap'],
    queryFn: () => api.get<LdapSettingsView>('/api/admin/ldap'),
  });
  const [form, setForm] = useState<Form | null>(null);
  const [password, setPassword] = useState<PasswordChange>({ kind: 'keep' });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (current.data) setForm(toForm(current.data));
  }, [current.data]);

  const save = useMutation({
    mutationFn: (f: Form) =>
      api.put<LdapSettingsView>('/api/admin/ldap', { settings: toSettings(f), ...passwordPayload(password) }),
    onMutate: () => setSaved(false),
    onSuccess: (v) => {
      qc.setQueryData(['admin', 'ldap'], v);
      setPassword({ kind: 'keep' });
      setSaved(true);
    },
  });

  if (current.isLoading || !form) {
    return (
      <div className="stack-lg">
        <h1>Directory (LDAP)</h1>
        {current.isLoading ? <Spinner /> : <ErrorBanner error={current.error} />}
      </div>
    );
  }
  const errors = fieldErrors(save.error);
  const err = (k: keyof LdapSettings) => errors[`settings.${k}`];
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const text = (k: keyof Form & keyof LdapSettings, label: string, hint?: string, placeholder?: string) => (
    <Field
      label={label}
      value={form[k] as string}
      onChange={(e) => set(k, e.target.value as never)}
      error={err(k)}
      {...(hint ? { hint } : {})}
      {...(placeholder ? { placeholder } : {})}
      spellCheck={false}
      autoComplete="off"
    />
  );
  const plain = form.url.toLowerCase().startsWith('ldap://');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };

  return (
    <div className="stack-lg">
      <h1>Directory (LDAP)</h1>
      <p className="muted">
        Let people sign in with their directory account (OpenLDAP, Active Directory, FreeIPA, …). Accounts are created
        automatically at first sign-in; passwords are always checked by the directory and never stored here.
      </p>
      <form onSubmit={submit} className="stack-lg" autoComplete="off">
        <section className="card stack">
          <label className="checkbox">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Allow sign-in with directory accounts
          </label>
          {text(
            'url',
            'Server URL',
            'ldaps://ldap.example.org or ldap://ldap.example.org:389 with StartTLS',
            'ldaps://',
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.startTls}
              disabled={!plain}
              onChange={(e) => set('startTls', e.target.checked)}
            />
            Use StartTLS (for ldap:// URLs)
          </label>
          {err('startTls') && <div className="field-error">{err('startTls')}</div>}
          {plain && !form.startTls && (
            <div className="banner banner-warning">
              Without TLS, passwords are sent over the network in clear text.
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.allowUnencrypted}
                  onChange={(e) => set('allowUnencrypted', e.target.checked)}
                />
                I understand; allow an unencrypted connection
              </label>
            </div>
          )}
          <TextArea
            label="Trusted CA certificate (optional)"
            hint="PEM certificate(s) of a private certificate authority. Public CAs are always trusted; certificates are always verified."
            value={form.caCertificate}
            error={err('caCertificate')}
            onChange={(v) => set('caCertificate', v)}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
          {text('timeoutSeconds', 'Timeout (seconds)')}
        </section>

        <section className="card stack">
          <h2>Finding users</h2>
          {text(
            'bindDn',
            'Bind DN (service account)',
            'Leave empty to search anonymously.',
            'cn=reader,dc=example,dc=org',
          )}
          <BindPassword
            stored={current.data?.hasBindPassword ?? false}
            change={password}
            onChange={setPassword}
            error={errors.bindPassword}
          />
          {text('userSearchBase', 'User search base', undefined, 'ou=people,dc=example,dc=org')}
          {text(
            'userFilter',
            'User filter',
            `{username} is replaced by the (escaped) name typed at sign-in. Active Directory: (&(objectClass=user)(sAMAccountName={username})). Default: ${LDAP_DEFAULT_USER_FILTER}`,
          )}
          <div className="limits-grid">
            {text('usernameAttribute', 'Username attribute', 'uid, sAMAccountName')}
            {text('displayNameAttribute', 'Name attribute', 'cn, displayName')}
            {text('emailAttribute', 'E-mail attribute', 'mail')}
          </div>
        </section>

        <section className="card stack">
          <h2>Groups</h2>
          {text(
            'requiredGroupDn',
            'Only allow members of (group DN)',
            'Leave empty to allow everyone the user filter finds.',
            'cn=texcollab-users,ou=groups,dc=example,dc=org',
          )}
          {text(
            'adminGroupDn',
            'Administrators group (DN)',
            'If set, membership decides administrator rights at every sign-in (changes made on the Users page are overwritten). Leave empty to manage administrators here.',
          )}
          {text(
            'groupMembershipFilter',
            'Membership filter',
            `Evaluated on the group entry; {dn} and {username} are replaced. Active Directory with nested groups: (member:1.2.840.113556.1.4.1941:={dn}). Default: ${LDAP_DEFAULT_MEMBERSHIP_FILTER}`,
          )}
        </section>

        <ErrorBanner error={save.error} />
        {saved && <div className="banner banner-success">Saved.</div>}
        <div>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            Save
          </button>
        </div>
      </form>
      <ConnectionTest form={form} password={password} />
    </div>
  );
}

function TextArea(props: {
  label: string;
  hint?: string;
  value: string;
  error?: string | undefined;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <textarea
        id={id}
        rows={4}
        className="mono"
        spellCheck={false}
        value={props.value}
        placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && !props.error && <div className="field-hint">{props.hint}</div>}
      {props.error && <div className="field-error">{props.error}</div>}
    </div>
  );
}

function BindPassword({
  stored,
  change,
  onChange,
  error,
}: {
  stored: boolean;
  change: PasswordChange;
  onChange: (c: PasswordChange) => void;
  error: string | undefined;
}) {
  const hint =
    change.kind === 'remove'
      ? 'The stored password will be removed when you save.'
      : change.kind === 'set'
        ? 'Stored encrypted when you save; it is never shown again.'
        : stored
          ? 'A password is stored. Type a new one to replace it. It is needed again if you change the server or bind DN.'
          : 'No password stored.';
  return (
    <div className="stack">
      <Field
        label="Bind password"
        type="password"
        autoComplete="new-password"
        value={change.kind === 'set' ? change.value : ''}
        placeholder={stored && change.kind === 'keep' ? '••••••••  (stored)' : ''}
        onChange={(e) => onChange(e.target.value ? { kind: 'set', value: e.target.value } : { kind: 'keep' })}
        hint={hint}
        error={error}
      />
      {stored && change.kind !== 'remove' && (
        <div>
          <button type="button" className="btn btn-small" onClick={() => onChange({ kind: 'remove' })}>
            Remove stored password
          </button>
        </div>
      )}
    </div>
  );
}

const STEP_LABELS: Record<string, string> = {
  connect: 'Connection',
  bind: 'Service account',
  search: 'Search',
  groups: 'Groups',
  'user-bind': 'User password',
};

function ConnectionTest({ form, password }: { form: Form; password: PasswordChange }) {
  const [username, setUsername] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const test = useMutation({
    mutationFn: () =>
      api.post<LdapTestResult>('/api/admin/ldap/test', {
        settings: toSettings(form),
        ...passwordPayload(password),
        ...(username ? { username } : {}),
        ...(username && userPassword ? { password: userPassword } : {}),
      }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    test.mutate();
  };
  let outcome: ReactNode = null;
  if (test.data) {
    outcome = (
      <div className="stack">
        <ul className="ldap-steps">
          {test.data.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed, ordered list
            <li key={i} className={s.ok ? 'ok' : 'fail'}>
              <span aria-hidden="true">{s.ok ? '✓' : '✗'}</span> <strong>{STEP_LABELS[s.step] ?? s.step}:</strong>{' '}
              {s.message}
            </li>
          ))}
        </ul>
        {test.data.user && (
          <dl className="ldap-user">
            <dt>DN</dt>
            <dd className="mono">{test.data.user.dn}</dd>
            <dt>Username</dt>
            <dd>{test.data.user.username}</dd>
            <dt>Name</dt>
            <dd>{test.data.user.displayName}</dd>
            <dt>E-mail</dt>
            <dd>{test.data.user.email ?? '—'}</dd>
            <dt>Administrator</dt>
            <dd>
              {test.data.user.admin === null ? 'not managed by the directory' : test.data.user.admin ? 'yes' : 'no'}
            </dd>
          </dl>
        )}
      </div>
    );
  }
  return (
    <section className="card stack">
      <h2>Test the configuration</h2>
      <p className="muted small">
        Tests the settings above (saved or not). Optionally look up a user and check their password; nothing is stored
        and no account is created.
      </p>
      <form onSubmit={submit} className="limits-grid" autoComplete="off">
        <Field label="Username (optional)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field
          label="Password (optional)"
          type="password"
          autoComplete="new-password"
          value={userPassword}
          disabled={!username}
          onChange={(e) => setUserPassword(e.target.value)}
        />
        <div>
          <button type="submit" className="btn" disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test'}
          </button>
        </div>
      </form>
      <ErrorBanner error={test.error} />
      {outcome}
    </section>
  );
}
