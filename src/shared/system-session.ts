/**
 * Fixed id of the dedicated session that owns all global scheduled (cron) jobs.
 *
 * Cron jobs are not tied to a user conversation: they live in this single
 * system session so every session's agent can see/manage them and so a job
 * survives deletion of whatever conversation created it. The session is
 * hidden from the conversation sidebar and protected from deletion.
 */
export const SYSTEM_SESSION_ID = '__system__'
