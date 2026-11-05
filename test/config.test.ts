import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    IMAP_HOST: 'imap.example.net',
    IMAP_USER: 'me@example.net',
    IMAP_PASSWORD: 'secret-password',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env()).elicitation).toBe(true);
    expect(loadConfig(env({ ELICITATION: '' })).elicitation).toBe(true);
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(loadConfig(env({ ELICITATION: raw })).elicitation, raw).toBe(
        false
      );
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ELICITATION: raw }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.IMAP_PASSWORD).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(env());
    expect(config.imap.host).toBe('imap.example.net');
    expect(config.imap.port).toBe(993);
    expect(config.imap.tls).toBe('implicit');
    expect(config.imap.mailbox).toBe('INBOX');
    expect(config.imap.seenKeyword).toBe('AiSeen');
    expect(config.imap.maxMessages).toBe(100);
    // Read-only unless explicitly turned off — the opposite default from the
    // rest of the family, and deliberately so: this reaches a mailbox.
    expect(config.readOnly).toBe(true);
    expect(config.imap.downloadDir).toBeUndefined();
    expect(config.imap.maxExtractBytes).toBe(10 * 1024 * 1024);
  });

  it('removes the password from the environment', () => {
    const environment = env();
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
  });

  it('removes the password even when the rest of the config is missing', () => {
    // The early return for "no host" used to run before the delete in an
    // earlier project; a token then survived on exactly the failure path.
    const environment: NodeJS.ProcessEnv = { IMAP_PASSWORD: 'secret-password' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  it('starts without credentials and only warns', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({});
    expect(config.imap.host).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'IMAP_HOST',
      'IMAP_USER',
      'IMAP_PASSWORD',
    ]);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('defaults the port to 143 without implicit TLS', () => {
    expect(loadConfig(env({ IMAP_TLS: 'starttls' })).imap.port).toBe(143);
    expect(loadConfig(env({ IMAP_TLS: 'none' })).imap.port).toBe(143);
  });

  it('only the literal string false turns read-only off', () => {
    // Fails closed: anything that is not exactly "false" leaves the write
    // tools unregistered, so a typo cannot hand out mailbox writes.
    expect(loadConfig(env({ IMAP_READ_ONLY: 'false' })).readOnly).toBe(false);
    expect(loadConfig(env({ IMAP_READ_ONLY: 'False' })).readOnly).toBe(true);
    expect(loadConfig(env({ IMAP_READ_ONLY: '0' })).readOnly).toBe(true);
    expect(loadConfig(env({ IMAP_READ_ONLY: 'no' })).readOnly).toBe(true);
    expect(loadConfig(env({})).readOnly).toBe(true);
  });

  it('refuses to start when the removed IMAP_ALLOW_WRITE is still set', () => {
    // Ignoring it would be the worst option: whoever set it once believes it
    // is still in force, and would get a read-only server without being told.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() => loadConfig(env({ IMAP_ALLOW_WRITE: 'true' }))).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('IMAP_READ_ONLY');
    // Even the harmless-looking value is refused: it says the same thing.
    expect(() => loadConfig(env({ IMAP_ALLOW_WRITE: 'false' }))).toThrow(
      'exit'
    );
  });

  it('warns about cleartext to a remote host but keeps going', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({ IMAP_TLS: 'none' }));
    expect(config.imap.tls).toBe('none');
    expect(errors.mock.calls.flat().join(' ')).toContain('unencrypted');
  });

  it('does not warn about cleartext to loopback', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: '127.0.0.1' }));
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['::1'],
    ['[::1]'],
    ['::ffff:127.0.0.1'],
    ['localhost.'],
    ['LOCALHOST'],
  ])('recognises %s as loopback too', (host) => {
    // IMAP_HOST is a bare hostname rather than a URL, so the bracketed form is
    // not the only spelling that reaches here — but the mapped IPv4 address,
    // the root label and the casing all did get past the old comparison.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: host }));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it.each([
    ['IMAP_HOST', { IMAP_HOST: 'imap.example.net\r\nX-Evil: 1' }],
    ['IMAP_HOST with a scheme', { IMAP_HOST: 'imaps://imap.example.net' }],
    ['IMAP_HOST with credentials', { IMAP_HOST: 'user:pass@imap.example.net' }],
    ['IMAP_PORT', { IMAP_PORT: '99999' }],
    ['IMAP_PORT non-numeric', { IMAP_PORT: 'imap' }],
    ['IMAP_TLS', { IMAP_TLS: 'sometimes' }],
    ['IMAP_SEEN_KEYWORD', { IMAP_SEEN_KEYWORD: 'Ai Seen' }],
    ['IMAP_MAX_MESSAGES', { IMAP_MAX_MESSAGES: 'lots' }],
    ['IMAP_MAX_MESSAGES zero', { IMAP_MAX_MESSAGES: '0' }],
    ['IMAP_MAX_EXTRACT_BYTES', { IMAP_MAX_EXTRACT_BYTES: 'ten megabytes' }],
    ['IMAP_MAX_EXTRACT_BYTES zero', { IMAP_MAX_EXTRACT_BYTES: '0' }],
    // Named rather than clamped, and fatal rather than ignored: the other
    // two size variables buy a big answer, this one buys a buffer inside a
    // parser working on bytes a stranger chose. A typo there would leave an
    // operator believing there is a limit.
    [
      'IMAP_MAX_EXTRACT_BYTES over the ceiling',
      { IMAP_MAX_EXTRACT_BYTES: String(1024 * 1024 * 1024) },
    ],
  ])('exits on a malformed %s', (_name, overrides) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() => loadConfig(env(overrides))).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
    // The rejected value is never echoed: config errors end up in logs.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('secret-password');
  });

  it('treats an empty keyword as new-mail tracking off', () => {
    expect(loadConfig(env({ IMAP_SEEN_KEYWORD: '' })).imap.seenKeyword).toBe(
      ''
    );
  });

  it('parses the attachment type allowlist', () => {
    const config = loadConfig(
      env({ IMAP_ATTACHMENT_TYPES: 'application/pdf, IMAGE/PNG ,' })
    );
    expect(config.imap.allowedAttachmentTypes).toEqual([
      'application/pdf',
      'image/png',
    ]);
  });
});

describe('missingConfigMessage', () => {
  it('names the variables and the optional ones', () => {
    const message = missingConfigMessage(['IMAP_HOST']);
    expect(message).toContain('IMAP_HOST');
    expect(message).toContain('IMAP_READ_ONLY');
    expect(message).toContain('IMAP_DOWNLOAD_DIR');
  });
});

describe('values that cannot be sent to the server', () => {
  // Each of these is fatal at startup rather than sanitised: a line break in
  // a mailbox name would end the IMAP command early, a port that is not a
  // port is a typo nobody would otherwise learn about, and an extraction
  // ceiling above the hard one would be a promise the child cannot keep.
  it.each([
    ['IMAP_DRAFTS_MAILBOX', 'Drafts\nNOOP', 'control characters'],
    // Trimmed first, so the break has to sit inside the value to count.
    ['IMAP_TRUSTED_AUTHSERV_ID', 'mx.example\r\nnet', 'plain hostname'],
    ['IMAP_PORT', 'nine-nine-three', '65535'],
    ['IMAP_PORT', '70000', '65535'],
    ['IMAP_SEEN_KEYWORD', 'Ai Seen', 'letters, digits'],
    ['IMAP_MAX_EXTRACT_BYTES', String(65 * 1024 * 1024), 'must not exceed'],
  ])('refuses to start with %s=%j', (name, raw, phrase) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() => loadConfig(env({ [name]: raw }))).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    const message = String(error.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(name);
    expect(message).toContain(phrase);
  });
});
