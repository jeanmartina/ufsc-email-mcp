import { createConnection, type Socket } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitForTcp } from 'mcp-integration-harness';

import { buildDocx, buildPdf } from '../document-fixtures.js';

/**
 * Fills the throwaway GreenMail with mail to read.
 *
 * GreenMail has **no seeding, no import and no persistence**. The only way to
 * put a message into it is to deliver one over SMTP, which is why the compose
 * file publishes port 3025 as well: the fixtures are real deliveries, so what
 * the read tools parse is a real RFC 5322 message that travelled a real SMTP
 * dialogue rather than a string somebody typed into a test.
 *
 * The account is created by `-Dgreenmail.users` at startup and cannot be added
 * afterwards, so the credentials belong in `compose.yml` and are repeated here.
 */

const IMAP_PORT = process.env.GREENMAIL_IMAP_PORT ?? '3143';
const SMTP_PORT = process.env.GREENMAIL_SMTP_PORT ?? '3025';

export const USER = 'integration';
export const PASSWORD = 'integration-not-a-secret';
export const ADDRESS = 'integration@example.net';

export interface Sandbox {
  /** The whole environment the server is started with. */
  env: Record<string, string>;
  /** Where `get_attachments` is allowed to write. */
  downloadDir: string;
  /** Subjects of the seeded messages, in delivery order. */
  subjects: string[];
}

/** A one-shot SMTP conversation. Enough for a fixture, and no dependency. */
async function deliver(message: string, to = ADDRESS): Promise<void> {
  const socket: Socket = createConnection({
    host: '127.0.0.1',
    port: Number(SMTP_PORT),
  });
  socket.setEncoding('utf8');
  let buffer = '';

  const expect = (code: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`SMTP: timed out waiting for ${code}; got ${buffer}`)
          ),
        15_000
      );
      const check = (): void => {
        // A reply is complete when a line starts with the code and a space —
        // "250-" lines are continuations of a multi-line greeting.
        if (new RegExp(`^${code} `, 'm').test(buffer)) {
          clearTimeout(timer);
          socket.off('data', onData);
          buffer = '';
          resolve();
        } else if (/^[45]\d\d /m.test(buffer)) {
          clearTimeout(timer);
          reject(new Error(`SMTP refused: ${buffer.trim()}`));
        }
      };
      const onData = (chunk: string): void => {
        buffer += chunk;
        check();
      };
      socket.on('data', onData);
      socket.on('error', reject);
      check();
    });

  await expect('220');
  socket.write('EHLO integration\r\n');
  await expect('250');
  socket.write(`MAIL FROM:<sender@example.org>\r\n`);
  await expect('250');
  socket.write(`RCPT TO:<${to}>\r\n`);
  await expect('250');
  socket.write('DATA\r\n');
  await expect('354');
  socket.write(`${message.replace(/\n\./g, '\n..')}\r\n.\r\n`);
  await expect('250');
  socket.write('QUIT\r\n');
  socket.end();
}

/** A plain message. */
function plain(subject: string, body: string): string {
  return [
    `From: Sender <sender@example.org>`,
    `To: Integration <${ADDRESS}>`,
    `Subject: ${subject}`,
    `Date: Mon, 01 Sep 2026 10:00:00 +0000`,
    `Message-ID: <${subject.replace(/\W+/g, '-')}@example.org>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\r\n');
}

/** A message with one small attachment, for `get_attachments`. */
function withAttachment(subject: string): string {
  const boundary = 'integration-boundary';
  return [
    `From: Sender <sender@example.org>`,
    `To: Integration <${ADDRESS}>`,
    `Subject: ${subject}`,
    `Date: Mon, 01 Sep 2026 11:00:00 +0000`,
    `Message-ID: <${subject.replace(/\W+/g, '-')}@example.org>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `The report is attached.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; name="report.txt"`,
    `Content-Disposition: attachment; filename="report.txt"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from('integration attachment\n').toString('base64'),
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

/**
 * A message whose attachment is executable and does not look it.
 *
 * `application/xml` is in the default type allowlist and a ClickOnce manifest
 * genuinely is XML, so the declaration passes and the magic bytes pass — the
 * extension is the only gate left, and `appref-ms` sat in the blocklist for
 * months without ever being read out of a filename. Delivered over real SMTP so
 * the refusal is measured against a real MIME part rather than a fixture.
 */
function withExecutableAttachment(subject: string): string {
  const boundary = 'integration-executable';
  const manifest =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1"/>\n';
  return [
    `From: Sender <sender@example.org>`,
    `To: Integration <${ADDRESS}>`,
    `Subject: ${subject}`,
    `Date: Mon, 01 Sep 2026 12:00:00 +0000`,
    `Message-ID: <${subject.replace(/\W+/g, '-')}@example.org>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your invoice is attached.`,
    ``,
    `--${boundary}`,
    `Content-Type: application/xml; name="Rechnung-2026.appref-ms"`,
    `Content-Disposition: attachment; filename="Rechnung-2026.appref-ms"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(manifest).toString('base64'),
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

/**
 * A message carrying a real PDF and a real .docx, for `mode: "text"`.
 *
 * Built by the same helpers the unit tests use, but delivered over real SMTP
 * and read back through real IMAP base64 decoding. That round trip is the whole
 * value of this suite for extraction: it is the only place where unpdf and
 * fflate see bytes that travelled the wire rather than bytes handed straight to
 * them in the same process.
 */
function withDocuments(subject: string): string {
  const boundary = 'integration-documents';
  return [
    `From: Sender <sender@example.org>`,
    `To: Integration <${ADDRESS}>`,
    `Subject: ${subject}`,
    `Date: Mon, 01 Sep 2026 11:00:00 +0000`,
    `Message-ID: <${subject.replace(/\W+/g, '-')}@example.org>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Rechnung und Vertrag im Anhang.`,
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="rechnung.pdf"`,
    `Content-Disposition: attachment; filename="rechnung.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap(buildPdf({ text: 'Rechnung 1200,00 EUR' }).toString('base64')),
    ``,
    `--${boundary}`,
    `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="vertrag.docx"`,
    `Content-Disposition: attachment; filename="vertrag.docx"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap(buildDocx(['Vertragsbeginn ist der 1. Oktober']).toString('base64')),
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

/** base64 in a mail body is wrapped; a single 800-character line is not legal. */
function wrap(encoded: string): string {
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n');
}

export const SUBJECTS = {
  first: 'Integration first message',
  second: 'Integration second message',
  attachment: 'Integration message with an attachment',
  executable: 'Integration message with an executable attachment',
  documents: 'Integration message with document attachments',
  toMove: 'Integration message to move',
  toDelete: 'Integration message to delete',
};

export async function bootstrap(): Promise<Sandbox> {
  // Not `waitForHttp`: an IMAP greeting is not an HTTP response, so `fetch`
  // rejects against this port and the wait would report a timeout for a server
  // that came up in a second. Waiting for the greeting rather than for the
  // connection matters here too — Docker publishes the port before GreenMail's
  // JVM is listening on it.
  await waitForTcp('127.0.0.1', Number(IMAP_PORT), {
    timeoutSeconds: 180,
    expect: '* OK',
  });
  await waitForTcp('127.0.0.1', Number(SMTP_PORT), {
    timeoutSeconds: 180,
    expect: '220',
  });

  const subjects = [
    SUBJECTS.first,
    SUBJECTS.second,
    SUBJECTS.toMove,
    SUBJECTS.toDelete,
  ];
  for (const subject of subjects) {
    await deliver(plain(subject, `Body of "${subject}".`));
  }
  await deliver(withAttachment(SUBJECTS.attachment));
  await deliver(withExecutableAttachment(SUBJECTS.executable));
  await deliver(withDocuments(SUBJECTS.documents));

  const downloadDir = await mkdtemp(join(tmpdir(), 'imap-mcp-integration-'));

  return {
    downloadDir,
    subjects: [
      ...subjects,
      SUBJECTS.attachment,
      SUBJECTS.executable,
      SUBJECTS.documents,
    ],
    env: {
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT,
      IMAP_TLS: 'none',
      IMAP_USER: USER,
      IMAP_PASSWORD: PASSWORD,
      // Defaults to true; the suite exists to exercise the write tools.
      IMAP_READ_ONLY: 'false',
      IMAP_DOWNLOAD_DIR: downloadDir,
      IMAP_DRAFTS_MAILBOX: 'Drafts',
      // Stated rather than defaulted, so the suite pins the value the
      // documentation gives.
      IMAP_MAX_EXTRACT_BYTES: '10485760',
    },
  };
}
