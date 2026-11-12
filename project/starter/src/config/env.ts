/**
 * Loads .env into process.env.
 *
 * Imported first by src/main.ts: ES module imports are evaluated before the importing module's body,
 * so modules that read process.env at load time (logger, MCP config) must see the values already.
 * Values in .env take precedence over the shell environment (see README "Using Personal API Key").
 */
import * as dotenv from 'dotenv';

dotenv.config({ override: true });
