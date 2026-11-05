/**
 * Buffers a stream, giving up once the cap is passed.
 *
 * imapflow's own `maxBytes` is asked for as well, but that bounds what is
 * *requested*, not what arrives — a server that ignores it would otherwise
 * stream straight into memory. Returns undefined rather than throwing so the
 * caller can explain which limit was hit.
 */
export async function readCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      // Tear the read down rather than draining politely: the point is to stop
      // the bytes arriving, not to receive all of them and discard them.
      (stream as { destroy?: () => void }).destroy?.();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
