import { defineConfig } from 'vitest/config';

/**
 * The integration suite: `npm run test:integration`.
 *
 * Separate from `vitest.config.ts` rather than a project inside it, so the unit
 * run stays a plain `vitest run` that needs nothing installed, and so the
 * coverage thresholds there keep measuring the same thing they always have.
 *
 * No coverage is collected here. What this suite proves is that the IMAP path behaves
 * as the code assumes, which is not a question about which lines ran.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    // One story, shared state, one GreenMail. Running the file's blocks against
    // each other in parallel would be a different test every time.
    fileParallelism: false,
    hookTimeout: 600_000,
    testTimeout: 120_000,
  },
});
