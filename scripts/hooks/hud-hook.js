#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

/**
 * Cross-platform find latest claude-hud plugin path
 */
function getLatestPluginPath() {
    // Auto-detect user home directory, Windows is C:\Users\xxx, Mac is /Users/xxx
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const baseDir = path.join(configDir, 'plugins', 'cache');

    if (!fs.existsSync(baseDir)) {
        console.error(`Error: Directory not found ${baseDir}`);
        process.exit(1);
    }

    let latestPath = "";
    let maxVersionValue = -1;

    try {
        // First level: iterate through vendor hash directories
        const vendors = fs.readdirSync(baseDir);
        for (const vendor of vendors) {
            const hudPath = path.join(baseDir, vendor, 'claude-hud');

            if (fs.existsSync(hudPath)) {
                // Second level: iterate through version directories (1.0.1, 1.0.2...)
                const versions = fs.readdirSync(hudPath);
                for (const v of versions) {
                    // Convert version to number for comparison (e.g., "1.2.3" -> 10203)
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
        console.error("Error searching plugin directory:", err);
        process.exit(1);
    }

    return latestPath;
}

// 1. Set COLUMNS environment variable (corresponds to stty size logic in original script)
// In Node.js we can get it directly via stdout.columns, default to 120
const cols = process.stdout.columns || 120;
process.env.COLUMNS = (cols > 4 ? cols - 4 : 1).toString();

// 2. Get latest plugin path
const pluginEntry = getLatestPluginPath();

if (pluginEntry) {
    // 3. Import and execute the plugin's main function
    const pluginModule = await import(`file://${pluginEntry.replace(/\\/g, '/')}`);
    if (pluginModule.main) {
        await pluginModule.main();
    }
} else {
    console.error("claude-hud index.js entry file not found");
    process.exit(1);
}
