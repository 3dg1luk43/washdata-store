// Registers the washstore loader hook (used via `node --import`).
import { register } from 'node:module';
register(new URL('./washstore_loader.mjs', import.meta.url));
