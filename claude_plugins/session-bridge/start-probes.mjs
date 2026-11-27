// start-probes.mjs — the session-bridge channel's slow start probes, on a worker thread
// (server.mjs probeInWorker): each blocks for up to 30 s, and the MCP loop must not wait on them.
import { parentPort } from 'worker_threads';
import { readChannelDeclaration } from '../../scripts/shared/channel-declaration.mjs';
import { readProcessTable } from '../../scripts/shared/process-tree.mjs';

const declaration = readChannelDeclaration();
const { table, error } = readProcessTable();
parentPort.postMessage({ declaration, table: [...table], tableError: error });
