#!/usr/bin/env node
import { launchPlugin } from './plugin-launcher.mjs';
launchPlugin('traceme@cc-market', 'traceme', 'scripts/traceme-cli.mjs', { nodeArgs: ['--no-warnings'], errorPrefix: 'traceme' });
