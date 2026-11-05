import { describe, expect, it } from 'vitest';

import {
  addressListParam,
  addressParam,
  dateParam,
  flagListParam,
  flagParam,
  limitParam,
  mailboxParam,
  searchTextParam,
  uidListParam,
  uidParam,
  MAX_LIMIT,
} from '../src/schema.js';

describe('mailboxParam', () => {
  it.each(['INBOX', 'INBOX/Archive', 'INBOX.Sent', 'Gelöschte Elemente'])(
    'accepts %s',
    (value) => {
      expect(mailboxParam.safeParse(value).success).toBe(true);
    }
  );

  it.each([
    ['a line break', 'INBOX\r\nLOGOUT'],
    ['a bare newline', 'INBOX\nX'],
    ['a NUL', 'INBOX\u0000'],
    ['the % wildcard', 'INBOX/%'],
    ['the * wildcard', '*'],
    ['an empty name', ''],
    // The CR/LF/NUL check let the rest of the C0/C1 range through. A bare CR
    // is the one that matters most: the confirmation a person reads before
    // losing messages is line-oriented, and a CR-padded name overwrites it.
    ['a bare carriage return', 'INBOX\rArchive'],
    ['a bell character', 'INBOX'],
    ['an escape character', 'INBOX[2J'],
    ['a DEL', 'INBOX'],
    ['a C1 control', 'INBOX'],
  ])('refuses %s', (_name, value) => {
    expect(mailboxParam.safeParse(value).success).toBe(false);
  });

  it('still accepts a folder that someone else named badly', () => {
    // Not the same call. A zero-width space in a folder name is a problem to
    // show, not one to refuse: the folder exists, and a parameter that rejected
    // its name would leave it unreadable and undeletable through this server.
    expect(mailboxParam.safeParse('Archive\u200b').success).toBe(true);
  });

  it('refuses an absurdly long name', () => {
    expect(mailboxParam.safeParse('a'.repeat(256)).success).toBe(false);
  });
});

describe('uidParam', () => {
  it.each([1, 4294967295])('accepts %s', (value) => {
    expect(uidParam.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 1.5, '3'])('refuses %s', (value) => {
    expect(uidParam.safeParse(value).success).toBe(false);
  });
});

describe('uidListParam', () => {
  it('accepts a list', () => {
    expect(uidListParam.safeParse([1, 2, 3]).success).toBe(true);
  });

  it('refuses an empty list', () => {
    expect(uidListParam.safeParse([]).success).toBe(false);
  });

  it('refuses more than the cap', () => {
    expect(
      uidListParam.safeParse(
        Array.from({ length: MAX_LIMIT + 1 }, (_u, i) => i + 1)
      ).success
    ).toBe(false);
  });
});

describe('limitParam', () => {
  it('accepts a value inside the cap and rejects above it', () => {
    expect(limitParam.safeParse(MAX_LIMIT).success).toBe(true);
    expect(limitParam.safeParse(MAX_LIMIT + 1).success).toBe(false);
    expect(limitParam.safeParse(0).success).toBe(false);
    expect(limitParam.safeParse(undefined).success).toBe(true);
  });
});

describe('dateParam', () => {
  it.each(['2026-08-24', '2024-02-29'])('accepts %s', (value) => {
    expect(dateParam.safeParse(value).success).toBe(true);
  });

  it('refuses a date that does not exist', () => {
    // V8 rolls 2026-02-30 over into March instead of rejecting it, so the
    // schema has to round-trip rather than trust the Date constructor.
    expect(dateParam.safeParse('2026-02-30').success).toBe(false);
    expect(dateParam.safeParse('2023-02-29').success).toBe(false);
  });

  it.each(['24.08.2026', '2026-8-4', 'yesterday', '2026-08-24T10:00:00Z'])(
    'refuses %s',
    (value) => {
      expect(dateParam.safeParse(value).success).toBe(false);
    }
  );
});

describe('addressParam', () => {
  it.each(['person@example.net', 'first.last+tag@sub.example.net'])(
    'accepts %s',
    (value) => {
      expect(addressParam.safeParse(value).success).toBe(true);
    }
  );

  it('refuses a header injection attempt', () => {
    // The attack: an address that appends a Bcc to a message a human approved.
    expect(
      addressParam.safeParse('person@example.net\r\nBcc: attacker@example.org')
        .success
    ).toBe(false);
  });

  it.each([
    'not-an-address',
    'no@domain',
    'two@@example.net',
    'spaces in@example.net',
    '"Name" <person@example.net>',
  ])('refuses %s', (value) => {
    expect(addressParam.safeParse(value).success).toBe(false);
  });

  it('caps the list length', () => {
    expect(
      addressListParam.safeParse(
        Array.from({ length: 51 }, (_u, i) => `p${i}@example.net`)
      ).success
    ).toBe(false);
  });
});

describe('flagParam', () => {
  it.each(['\\Seen', '\\Flagged', 'AiSeen', '$Forwarded'])(
    'accepts %s',
    (value) => {
      expect(flagParam.safeParse(value).success).toBe(true);
    }
  );

  it.each(['\\Seen)', 'two words', 'with"quote', '\\\\double', ''])(
    'refuses %s',
    (value) => {
      expect(flagParam.safeParse(value).success).toBe(false);
    }
  );

  it('caps how many flags one call may set', () => {
    expect(
      flagListParam.safeParse(Array.from({ length: 21 }, (_u, i) => `K${i}`))
        .success
    ).toBe(false);
  });
});

describe('searchTextParam', () => {
  it('accepts an ordinary term', () => {
    expect(searchTextParam.safeParse('invoice').success).toBe(true);
  });

  it('refuses a line break and an over-long term', () => {
    expect(searchTextParam.safeParse('a\r\nb').success).toBe(false);
    expect(searchTextParam.safeParse('x'.repeat(257)).success).toBe(false);
  });
});
