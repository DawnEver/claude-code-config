#!/usr/bin/env node
import path from 'path';
import os from 'os';
import fs from 'fs';
import { PassThrough } from 'stream';

function getLatestPluginPath() {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const baseDir = path.join(configDir, 'plugins', 'cache');

    if (!fs.existsSync(baseDir)) {
        console.error(`Error: Directory not found ${baseDir}`);
        process.exit(1);
    }

    let latestPath = '';
    let maxVersionValue = -1;

    try {
        const vendors = fs.readdirSync(baseDir);
        for (const vendor of vendors) {
            const hudPath = path.join(baseDir, vendor, 'claude-hud');
            if (fs.existsSync(hudPath)) {
                const versions = fs.readdirSync(hudPath);
                for (const v of versions) {
                    const vParts = v.split('.').map(Number);
                    if (vParts.length >= 3) {
                        const vValue = vParts[0] * 10000 + vParts[1] * 100 + vParts[2];
                        if (vValue > maxVersionValue) {
                            const indexPath = path.join(hudPath, v, 'dist', 'index.js');
                            if (fs.existsSync(indexPath)) {
                                maxVersionValue = vValue;
                                latestPath = indexPath;
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error searching plugin directory:', err);
        process.exit(1);
    }

    return latestPath;
}

const cols = process.stdout.columns || process.stderr.columns || 120;
process.env.COLUMNS = String(Math.max(cols > 4 ? cols - 4 : cols, 40));

const pluginEntry = getLatestPluginPath();

if (!pluginEntry) {
    console.error('claude-hud index.js entry file not found');
    process.exit(1);
}

// Tee the statusLine payload: its rate_limits feed the bridge's fleet report (fleet.mjs).
// claude-hud then reads the same bytes from a replayed stdin.
// Never let the tee break the status line: any failure here leaves claude-hud to decide.
if (!process.stdin.isTTY) {
    try {
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
            const [{ teeClaudeUsage }, { configDir, usageFile }] = await Promise.all([import('../bridge/fleet.mjs'), import('../shared/seats.mjs')]);
            teeClaudeUsage(JSON.parse(raw), { file: usageFile(configDir()) });
        } catch { /* not JSON / no fleet.mjs */ }
        const replay = new PassThrough();
        replay.end(raw);
        Object.defineProperty(process, 'stdin', { value: replay, configurable: true });
    } catch { /* status line still renders */ }
}

const pluginModule = await import(`file://${pluginEntry.replace(/\\/g, '/')}`);
if (pluginModule.main) await pluginModule.main();
