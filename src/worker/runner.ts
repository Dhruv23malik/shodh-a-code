/**
 * JudgeRunner — the boundary between the worker and code execution.
 *
 * Two implementations:
 *  - RealRunner: spawns one sandboxed Docker container per attempt
 *    (judge/Dockerfile.runner). Requires Docker on the worker host.
 *  - DoubleRunner: in-process deterministic test double, selected by
 *    JUDGE_MODE=double. No Docker needed; behaviour is injected per
 *    attempt/submission so race/recovery tests can coordinate with
 *    barriers instead of sleeps.
 *
 * A runner NEVER returns a student verdict for an infrastructure
 * problem. Docker failures, a non-zero runner exit, a missing or
 * malformed verdict.json, or an unsupported language all throw
 * JudgeInfraError. The worker treats that as "leave the attempt
 * running for the reaper" — never as a wrong answer.
 */
import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaseResult, Verdict } from '../core/types';

export class JudgeInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeInfraError';
  }
}

export interface JudgeCaseInput {
  position: number;
  name: string;
  input: string;
  expectedOutput: string;
}

export interface JudgeJob {
  submissionId: string;
  attemptId: string;
  code: string;
  language: string;
  cases: JudgeCaseInput[];
  /** Per-case wall-time limit (ms) from the problem. */
  timeLimitMs: number;
  /** Per-case memory limit (MB) from the problem. */
  memoryMb: number;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  cases: CaseResult[];
}

export interface JudgeRunOptions {
  signal?: AbortSignal;
}

export interface JudgeRunner {
  run(job: JudgeJob, opts?: JudgeRunOptions): Promise<JudgeResult>;
}

const STUDENT_VERDICTS: Verdict[] = [
  'accepted',
  'wrong_answer',
  'compile_error',
  'runtime_error',
  'time_limit',
];

const CASE_OUTCOMES = new Set([
  'ok',
  'wrong_output',
  'runtime_error',
  'time_limit',
  'output_limit',
]);

export interface RealRunnerOptions {
  image?: string;
  /** Passed verbatim to `docker run --cpus`. */
  cpu?: string;
  /** Passed verbatim to `docker run --memory <n>m`. */
  memoryMb?: number;
  pidsLimit?: number;
  maxOutputBytes?: number;
}

/**
 * Executes each attempt in a fresh, throwaway Docker container.
 *
 * Per attempt:
 *  1. Create a temp dir under os.tmpdir() (prefix `shodh-<attemptId>-`;
 *     the random suffix avoids collisions when a requeued attempt is
 *     judged again while a previous temp dir still exists).
 *  2. Write code.py + tests.json into it.
 *  3. `docker run --rm --network none --user 10001 ... -v <dir>:/work <image>`
 *  4. Read /work/verdict.json, validate its shape, return it.
 *  5. ALWAYS clean up: docker --rm plus fs.rm(tmpdir, recursive, force)
 *     in a finally block.
 *
 * Wall-clock timeout = sum of per-case limits + 10 s grace. On expiry the
 * container is killed by name. A time_limit verdict is returned ONLY if
 * the runner actually wrote a verdict.json showing a case timed out;
 * otherwise a wall-clock expiry is a JudgeInfraError (the runner itself
 * was stuck, which is infrastructure, not a student error).
 */
export class RealRunner implements JudgeRunner {
  private readonly image: string;
  private readonly cpu: string;
  private readonly memoryMb: number;
  private readonly pidsLimit: number;
  private readonly maxOutputBytes: number;

  constructor(opts: RealRunnerOptions = {}) {
    this.image = opts.image ?? process.env.JUDGE_IMAGE ?? 'shodh-runner:latest';
    this.cpu = opts.cpu ?? process.env.JUDGE_CPU ?? '0.5';
    this.memoryMb =
      opts.memoryMb ?? Number(process.env.JUDGE_MEMORY_MB ?? 128);
    this.pidsLimit =
      opts.pidsLimit ?? Number(process.env.JUDGE_PIDS_LIMIT ?? 64);
    this.maxOutputBytes =
      opts.maxOutputBytes ??
      Number(process.env.JUDGE_MAX_OUTPUT_BYTES ?? 1024 * 1024);
  }

  async run(job: JudgeJob, opts: JudgeRunOptions = {}): Promise<JudgeResult> {
    if (job.language !== 'python') {
      throw new JudgeInfraError(
        `unsupported language for this runner: ${job.language}`,
      );
    }
    if (job.cases.length === 0) {
      throw new JudgeInfraError('judge job has no test cases');
    }

    // Keep the child's RLIMIT_AS inside the container's --memory cap.
    // Operators should set JUDGE_MEMORY_MB >= the largest problem
    // memory_mb; if a problem asks for more, the runner limit is
    // clamped so the container OOM-killer does not fire first.
    const effectiveMemoryMb = Math.min(job.memoryMb, this.memoryMb);
    const dir = await mkdtemp(join(tmpdir(), `shodh-${job.attemptId}-`));
    // The runner runs as uid 10001 and must write verdict.json into
    // /work. This dir is per-attempt and deleted in the finally below.
    await chmod(dir, 0o777);
    const containerName = `shodh-run-${job.attemptId}`;
    const wallClockMs =
      job.cases.reduce((sum) => sum + job.timeLimitMs, 0) + 10_000;

    try {
      await writeFile(join(dir, 'code.py'), job.code, 'utf8');
      await writeFile(
        join(dir, 'tests.json'),
        JSON.stringify({
          time_limit_ms: job.timeLimitMs,
          memory_mb: effectiveMemoryMb,
          max_output_bytes: this.maxOutputBytes,
          cases: job.cases.map((c) => ({
            position: c.position,
            name: c.name,
            input: c.input,
            expected_output: c.expectedOutput,
          })),
        }),
        'utf8',
      );

      const args = [
        'run',
        '--rm',
        '--name',
        containerName,
        '--network',
        'none',
        '--user',
        '10001',
        '--cpus',
        this.cpu,
        '--memory',
        `${this.memoryMb}m`,
        '--pids-limit',
        String(this.pidsLimit),
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-e',
        'PYTHONDONTWRITEBYTECODE=1',
        '-v',
        `${dir}:/work`,
        this.image,
      ];

      const outcome = await this.spawnDocker(args, wallClockMs, opts.signal);
      if (outcome.timedOut) {
        // The runner may have written verdict.json just before the kill.
        // Only then can we honestly report a case timeout.
        const verdict = await this.readVerdict(dir).catch(() => null);
        if (verdict) return verdict;
        throw new JudgeInfraError(
          `runner wall-clock timeout after ${wallClockMs}ms with no verdict`,
        );
      }
      if (outcome.code !== 0) {
        throw new JudgeInfraError(
          `runner exited with code ${outcome.code}: ${truncate(outcome.stderr, 500)}`,
        );
      }
      const verdict = await this.readVerdict(dir);
      if (!verdict) {
        throw new JudgeInfraError('runner exited 0 but wrote no verdict.json');
      }
      return verdict;
    } finally {
      // Best-effort: a killed container may survive if --rm did not fire.
      await this.removeContainer(containerName).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async readVerdict(dir: string): Promise<JudgeResult | null> {
    let raw: string;
    try {
      raw = await readFile(join(dir, 'verdict.json'), 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JudgeInfraError('verdict.json is not valid JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !STUDENT_VERDICTS.includes(
        (parsed as { verdict?: string }).verdict as Verdict,
      ) ||
      typeof (parsed as { reason?: unknown }).reason !== 'string' ||
      !Array.isArray((parsed as { cases?: unknown }).cases)
    ) {
      throw new JudgeInfraError('verdict.json has an unexpected shape');
    }
    const p = parsed as {
      verdict: Verdict;
      reason: string;
      cases: unknown[];
    };
    const cases: CaseResult[] = p.cases.map((c) => {
      const cc = c as Partial<CaseResult>;
      if (
        typeof cc.position !== 'number' ||
        typeof cc.name !== 'string' ||
        typeof cc.passed !== 'boolean' ||
        typeof cc.outcome !== 'string' ||
        !CASE_OUTCOMES.has(cc.outcome) ||
        typeof cc.runtimeMs !== 'number'
      ) {
        throw new JudgeInfraError('verdict.json case entry has an unexpected shape');
      }
      // Only carry the safe fields; never forward unexpected content.
      const out: CaseResult = {
        position: cc.position,
        name: cc.name,
        passed: cc.passed,
        outcome: cc.outcome,
        runtimeMs: cc.runtimeMs,
      };
      if (typeof cc.detail === 'string') out.detail = cc.detail;
      return out;
    });
    cases.sort((a, b) => a.position - b.position);
    return { verdict: p.verdict, reason: p.reason, cases };
  }

  private spawnDocker(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, stderr, timedOut });
      };
      const killContainer = () => {
        // Kill by name; --rm removes the container afterwards.
        execFile('docker', ['kill', args[args.indexOf('--name') + 1]], () => undefined);
        child.kill('SIGKILL');
      };
      const onAbort = () => {
        timedOut = true;
        killContainer();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killContainer();
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        // Docker stderr never contains test data (the runner prints none),
        // but cap it anyway.
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code));
    });
  }

  private removeContainer(name: string): Promise<void> {
    return new Promise((resolve) => {
      execFile('docker', ['rm', '-f', name], { timeout: 5000 }, () => resolve());
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// DoubleRunner (test double)
// ---------------------------------------------------------------------------

export type DoubleFailpoint =
  | 'none'
  | 'crash_before_verdict'
  | 'hang'
  | 'runner_crash';

export interface DoubleCaseBehavior {
  passed: boolean;
  outcome: CaseResult['outcome'];
  runtimeMs?: number;
  detail?: string;
}

export interface DoubleBehavior {
  verdict?: Verdict;
  reason?: string;
  /** Per-case behaviour, keyed by case position (record) or in case order (array). */
  cases?: Record<number, DoubleCaseBehavior> | DoubleCaseBehavior[];
  failpoint?: DoubleFailpoint;
  /** Artificial delay before returning (ms). Abortable via the run signal. */
  delayMs?: number;
}

function deriveVerdict(cases: CaseResult[]): { verdict: Verdict; reason: string } {
  if (cases.some((c) => c.outcome === 'time_limit')) {
    return { verdict: 'time_limit', reason: 'timeout' };
  }
  if (cases.some((c) => c.outcome === 'output_limit')) {
    return { verdict: 'runtime_error', reason: 'output_limit' };
  }
  if (cases.some((c) => c.outcome === 'runtime_error')) {
    return { verdict: 'runtime_error', reason: 'runtime_error' };
  }
  if (cases.some((c) => c.outcome === 'wrong_output')) {
    return { verdict: 'wrong_answer', reason: 'wrong_output' };
  }
  return { verdict: 'accepted', reason: 'all_passed' };
}

/**
 * Deterministic in-process double. Behaviour is looked up by attemptId
 * first, then submissionId, then the default behaviour (all cases pass).
 *
 * Failpoints:
 *  - 'runner_crash': throw JudgeInfraError immediately (runner died
 *    before producing a verdict).
 *  - 'crash_before_verdict': compute the verdict, emit judgeDone, then
 *    throw JudgeInfraError — simulates a crash between judging and ack.
 *  - 'hang': never resolve until the run signal aborts, then throw
 *    JudgeInfraError('judge aborted').
 *
 * Events (also emitted under the `on<Event>` alias so race tests can
 * subscribe either way): 'judgeStart' / 'onJudgeStart',
 * 'judgeDone' / 'onJudgeDone'. Payload: { submissionId, attemptId }.
 */
export class DoubleRunner implements JudgeRunner {
  readonly events = new EventEmitter();
  private readonly behaviors = new Map<string, DoubleBehavior>();
  private defaultBehavior: DoubleBehavior;

  constructor(
    behaviors?: Map<string, DoubleBehavior> | Record<string, DoubleBehavior>,
    defaultBehavior: DoubleBehavior = {},
  ) {
    if (behaviors) {
      for (const [k, v] of Object.entries(
        behaviors instanceof Map ? Object.fromEntries(behaviors) : behaviors,
      )) {
        this.behaviors.set(k, v);
      }
    }
    this.defaultBehavior = defaultBehavior;
  }

  setBehavior(key: string, behavior: DoubleBehavior): void {
    this.behaviors.set(key, behavior);
  }

  setDefaultBehavior(behavior: DoubleBehavior): void {
    this.defaultBehavior = behavior;
  }

  private lookup(job: JudgeJob): DoubleBehavior {
    return (
      this.behaviors.get(job.attemptId) ??
      this.behaviors.get(job.submissionId) ??
      this.defaultBehavior
    );
  }

  async run(job: JudgeJob, opts: JudgeRunOptions = {}): Promise<JudgeResult> {
    const behavior = this.lookup(job);
    const failpoint = behavior.failpoint ?? 'none';
    const payload = { submissionId: job.submissionId, attemptId: job.attemptId };
    this.events.emit('judgeStart', payload);
    this.events.emit('onJudgeStart', payload);

    if (failpoint === 'runner_crash') {
      throw new JudgeInfraError('simulated runner crash (double failpoint)');
    }
    if (failpoint === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(new JudgeInfraError('judge aborted'));
          return;
        }
        opts.signal?.addEventListener(
          'abort',
          () => reject(new JudgeInfraError('judge aborted')),
          { once: true },
        );
        // No other resolution: hangs until aborted.
      });
    }
    if (behavior.delayMs && behavior.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, behavior.delayMs);
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new JudgeInfraError('judge aborted'));
          },
          { once: true },
        );
        if (opts.signal?.aborted) {
          clearTimeout(timer);
          reject(new JudgeInfraError('judge aborted'));
        }
      });
    }

    const cases: CaseResult[] = job.cases.map((c, i) => {
      const b = Array.isArray(behavior.cases)
        ? behavior.cases[i]
        : behavior.cases?.[c.position];
      if (!b) {
        return {
          position: c.position,
          name: c.name,
          passed: true,
          outcome: 'ok',
          runtimeMs: 5,
        };
      }
      const out: CaseResult = {
        position: c.position,
        name: c.name,
        passed: b.passed,
        outcome: b.outcome,
        runtimeMs: b.runtimeMs ?? 5,
      };
      if (b.detail !== undefined) out.detail = b.detail;
      return out;
    });

    const derived = deriveVerdict(cases);
    const result: JudgeResult = {
      verdict: behavior.verdict ?? derived.verdict,
      reason: behavior.reason ?? derived.reason,
      cases,
    };

    this.events.emit('judgeDone', { ...payload, verdict: result.verdict });
    this.events.emit('onJudgeDone', { ...payload, verdict: result.verdict });

    if (failpoint === 'crash_before_verdict') {
      // Verdict computed (and judgeDone emitted) but never returned:
      // the worker must treat this exactly like a real crash — leave
      // the attempt 'running' for the reaper.
      throw new JudgeInfraError(
        'simulated crash before verdict ack (double failpoint)',
      );
    }
    return result;
  }
}

export interface CreateRunnerOptions extends RealRunnerOptions {
  mode?: 'real' | 'double';
  doubleBehaviors?: Map<string, DoubleBehavior> | Record<string, DoubleBehavior>;
  doubleDefaultBehavior?: DoubleBehavior;
}

/** Factory used by the worker (and by tests). Mode from JUDGE_MODE env. */
export function createRunner(opts: CreateRunnerOptions = {}): JudgeRunner {
  const mode = opts.mode ?? (process.env.JUDGE_MODE === 'double' ? 'double' : 'real');
  if (mode === 'double') {
    return new DoubleRunner(opts.doubleBehaviors, opts.doubleDefaultBehavior);
  }
  return new RealRunner(opts);
}
