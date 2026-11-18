/**
 * Structured JSON logs. Every log line carries request_id and, when known,
 * submission_id / attempt_id so a reviewer can follow one operation across
 * the API and the worker. NEVER log credentials, student source code, or
 * hidden test inputs/expected outputs.
 */
export interface LogFields {
  requestId?: string;
  submissionId?: string;
  attemptId?: string;
  [key: string]: unknown;
}

function write(level: string, msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  // eslint-disable-next-line no-console
  console.log(line);
}

export const log = {
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};

export function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
