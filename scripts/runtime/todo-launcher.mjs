#!/usr/bin/env node
import { launchPlugin } from './plugin-launcher.mjs';
launchPlugin('rem@cc-market', 'rem', 'scripts/task-engine.js', { errorPrefix: 'todo' });
