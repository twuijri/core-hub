/**
 * The Worker's entry (wrangler.toml `main`). Everything lives in `relay.ts`; this file only
 * hands the runtime's `fetch` and clock to it.
 */
import { createRelay } from './relay.js';

export default createRelay();
