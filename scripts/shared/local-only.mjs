// scripts/shared/local-only.mjs -- the one switch that keeps a session on this machine.
//
// The launcher sets it for a keyless local provider (cc-launcher.mjs, `ccla`); every hook that would send
// a session's content off the box (the bridge mirror to Telegram and the dashboard) reads it and stays out.

export const LOCAL_ONLY_ENV = 'HARNESS_LOCAL_ONLY';

/** Whether *env* is a local-only session. */
export const isLocalOnly = (env = process.env) => env[LOCAL_ONLY_ENV] === '1';
