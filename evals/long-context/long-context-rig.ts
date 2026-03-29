/**
 * long-context-rig.ts — Spawns the real Gemini CLI binary against external repos.
 *
 * Unlike mock-based evals, this rig:
 *   1. Clones the target repo via RepoManager (bare cache + worktree)
 *   2. Spawns `node bundle/gemini.js --approval-mode=yolo` in the worktree
 *   3. Captures stdout, stderr, activity logs (JSONL), and git diff
 *   4. Classifies failures into 7 taxonomy modes
 *   5. Computes Path Efficiency Score from tool call traces
 *
 * Mirrors upstream TestRig patterns (spawn, _getCleanEnv, GEMINI_CLI_HOME)
 * but adds: RepoManager integration, fail_to_pass/pass_to_pass test oracle,
 * failure taxonomy, and navigation metrics.
 */

import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { RepoManager, type RepoSpec, type WorktreeHandle } from './repo-manager.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TaskManifest {
  schema_version: string;
  task_id: string;
  repository: RepoSpec & {
    languages: string[];
    size_files: number;
    size_lines: number;
    license: string;
  };
  task: {
    type: string;
    category: string;
    prompt: string;
    hint_levels: {
      symptom_only: string;
      file_hint: string;
      function_hint: string;
    };
    reasoning_forcing_score: number;
    difficulty: {
      overall: number;
      reasoning_steps: number;
      context_depth: string;
      [key: string]: unknown;
    };
    reasoning_chain: string[];
    expected_changes: {
      files_modified: string[];
      files_must_read: string[];
      key_assertions: string[];
      negative_assertions?: string[];
      assertion_type?: string;
    };
    test_oracle?: {
      fail_to_pass: string[];
      pass_to_pass: string[];
      test_command: string;
      weak_test_ids?: string[];
      semantic_correctness?: 'test_sufficient' | 'test_necessary_not_sufficient' | 'manual_review_required';
    } | null;
    contamination_info: {
      training_cutoff_risk: string;
      contamination_score?: number;
      [key: string]: unknown;
    };
  };
  eval_config: {
    timeout_ms: number;
    policy: string;
    setup: string;
    semantic_correctness?: string;
  };
}

export type FailureMode =
  | 'context_insufficient'
  | 'wrong_files_targeted'
  | 'shallow_fix'
  | 'cross_component_miss'
  | 'test_regression'
  | 'timeout'
  | 'complete_hallucination';

export interface RunResult {
  taskId: string;
  success: boolean;
  diff: string;
  filesRead: string[];
  filesModified: string[];
  toolCalls: ToolCall[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  tokenEstimate: number;
  failureMode: FailureMode | null;
  pathEfficiencyScore: number;
  assertionResults: {
    keyAssertions: { pattern: string; found: boolean }[];
    negativeAssertions: { pattern: string; found: boolean }[];
    failToPass: { test: string; passed: boolean }[];
    passToPass: { test: string; passed: boolean }[];
  };
}

export interface ToolCall {
  name: string;
  args: string;
  success: boolean;
  duration_ms: number;
  prompt_id?: string;
  error?: string;
}

interface LongContextRigOptions {
  /** Path to gemini CLI bundle. Auto-detected if not provided. */
  cliBundlePath?: string;
  /** Hint level to use. Default: 'symptom_only' */
  hintLevel?: 'symptom_only' | 'file_hint' | 'function_hint';
  /** RepoManager instance (shared across tests for cache reuse) */
  repoManager?: RepoManager;
  /** Verbose logging */
  verbose?: boolean;
}

// ── Bundle path detection ──────────────────────────────────────────────────

const BUNDLE_CANDIDATES = [
  // Environment override — checked FIRST so it wins
  process.env['GEMINI_CLI_BUNDLE_PATH'] ?? '',
  // Sibling directory layout (e.g., e:\GeminiCLI\gemini-cli\bundle\gemini.js)
  path.resolve(__dirname, '../../../../../gemini-cli/bundle/gemini.js'),
  // Relative to this POC at evals/long-context/ — go up 4 levels then into sibling
  path.resolve(__dirname, '../../../../gemini-cli/bundle/gemini.js'),
  // Relative to monorepo root
  path.resolve(__dirname, '../../../bundle/gemini.js'),
].filter(Boolean);

function findBundle(override?: string): string {
  if (override && fs.existsSync(override)) return override;
  for (const candidate of BUNDLE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Cannot find gemini CLI bundle. Set GEMINI_CLI_BUNDLE_PATH or pass cliBundlePath option.'
  );
}

// ── LongContextRig ─────────────────────────────────────────────────────────

export class LongContextRig {
  private repoManager: RepoManager;
  private bundlePath: string;
  private hintLevel: 'symptom_only' | 'file_hint' | 'function_hint';
  private verbose: boolean;
  private worktree: WorktreeHandle | null = null;
  private homeDir: string | null = null;

  constructor(options: LongContextRigOptions = {}) {
    this.repoManager = options.repoManager ?? new RepoManager({ verbose: options.verbose });
    this.bundlePath = findBundle(options.cliBundlePath);
    this.hintLevel = options.hintLevel ?? 'symptom_only';
    this.verbose = options.verbose ?? false;
  }

  // ── Main Entry Point ───────────────────────────────────────────────────

  async run(task: TaskManifest): Promise<RunResult> {
    const startTime = Date.now();

    // 1. Get isolated worktree
    this.worktree = await this.repoManager.getWorktree({
      url: task.repository.url,
      commit: task.repository.commit,
      sparseCheckoutPaths: task.repository.sparseCheckoutPaths,
    });

    // 2. Create isolated home directory
    this.homeDir = this.createHomeDir(task.task_id);
    const activityLogFile = path.join(this.homeDir, 'activity.jsonl');

    // 3. Select prompt based on hint level
    const prompt = task.task.hint_levels[this.hintLevel];

    // 4. Spawn CLI
    this.log(`Running task ${task.task_id} @ ${this.hintLevel}`);
    this.log(`  Worktree: ${this.worktree.path}`);
    this.log(`  Prompt: ${prompt.slice(0, 80)}...`);

    const cliResult = await this.spawnCLI(prompt, {
      cwd: this.worktree.path,
      homeDir: this.homeDir,
      activityLogFile,
      timeout: task.eval_config.timeout_ms,
    });

    // 5. Collect results
    const diff = this.getGitDiff(this.worktree.path);
    const toolCalls = this.parseActivityLog(activityLogFile);
    const filesRead = this.extractFilesRead(toolCalls);
    const filesModified = this.extractFilesModified(diff);

    // 6. Run assertions
    const assertionResults = this.runAssertions(task, diff);

    // 7. Run test oracle if available
    if (task.task.test_oracle) {
      const oracleResults = this.runTestOracle(
        task.task.test_oracle,
        this.worktree.path
      );
      assertionResults.failToPass = oracleResults.failToPass;
      assertionResults.passToPass = oracleResults.passToPass;
    }

    // 8. Compute metrics
    const pes = this.computePES(filesRead, task.task.expected_changes.files_must_read);
    const success = this.isSuccess(assertionResults);
    const failureMode = success ? null : this.classifyFailure(
      task, diff, filesRead, filesModified, cliResult, assertionResults
    );

    const durationMs = Date.now() - startTime;

    return {
      taskId: task.task_id,
      success,
      diff,
      filesRead,
      filesModified,
      toolCalls,
      stdout: cliResult.stdout,
      stderr: cliResult.stderr,
      exitCode: cliResult.exitCode,
      durationMs,
      tokenEstimate: this.estimateTokens(cliResult.stdout),
      failureMode,
      pathEfficiencyScore: pes,
      assertionResults,
    };
  }

  // ── CLI Spawning (mirrors TestRig pattern) ─────────────────────────────

  private spawnCLI(
    prompt: string,
    options: { cwd: string; homeDir: string; activityLogFile: string; timeout: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      const env = this.getCleanEnv(options.homeDir, options.activityLogFile);

      const child = spawn('node', [this.bundlePath, '--approval-mode=yolo', '-p', prompt], {
        cwd: options.cwd,
        stdio: 'pipe',
        env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, options.timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
      });
    });
  }

  /**
   * Mirrors TestRig._getCleanEnv() — strips GEMINI_* vars,
   * sets GEMINI_CLI_HOME, preserves API keys.
   */
  private getCleanEnv(homeDir: string, activityLogFile: string): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Strip all GEMINI_* vars except API keys
    const preserve = new Set([
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL',
    ]);
    for (const key of Object.keys(env)) {
      if ((key.startsWith('GEMINI_') || key.startsWith('GOOGLE_GEMINI_'))
          && !preserve.has(key)) {
        delete env[key];
      }
    }

    // Set eval-specific env
    env['GEMINI_CLI_HOME'] = homeDir;
    env['GEMINI_PTY_INFO'] = 'child_process';
    env['GEMINI_CLI_ACTIVITY_LOG_TARGET'] = activityLogFile;

    // Disable telemetry in eval
    env['GEMINI_CLI_DISABLE_TELEMETRY'] = '1';

    return env;
  }

  private createHomeDir(taskId: string): string {
    const id = crypto.randomBytes(4).toString('hex');
    const dir = path.join(os.tmpdir(), `gemini-eval-home-${taskId}-${id}`);
    fs.mkdirSync(dir, { recursive: true });

    // Create minimal .gemini config (mirrors TestRig setup)
    const geminiDir = path.join(dir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'settings.json'),
      JSON.stringify({ general: { telemetryDisabled: true } })
    );

    return dir;
  }

  // ── Result Collection ──────────────────────────────────────────────────

  private getGitDiff(worktreePath: string): string {
    try {
      return execSync('git diff', {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  }

  private parseActivityLog(logFile: string): ToolCall[] {
    if (!fs.existsSync(logFile)) return [];

    const calls: ToolCall[] = [];
    const content = fs.readFileSync(logFile, 'utf-8');

    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.attributes?.['event.name'] === 'function_call' ||
            entry.attributes?.function_name) {
          calls.push({
            name: entry.attributes.function_name ?? 'unknown',
            args: entry.attributes.function_args ?? '',
            success: entry.attributes.success ?? false,
            duration_ms: entry.attributes.duration_ms ?? 0,
            prompt_id: entry.attributes.prompt_id,
            error: entry.attributes.error,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return calls;
  }

  private extractFilesRead(toolCalls: ToolCall[]): string[] {
    const files = new Set<string>();
    const readTools = new Set(['read_file', 'view_file', 'ReadFile', 'read']);

    for (const call of toolCalls) {
      if (readTools.has(call.name)) {
        try {
          const args = JSON.parse(call.args);
          if (args.path || args.file_path) {
            files.add(args.path ?? args.file_path);
          }
        } catch {
          // Extract path from string args
          const match = call.args.match(/["']?([^"'\s]+\.[a-z]+)["']?/i);
          if (match) files.add(match[1]);
        }
      }
    }

    return [...files];
  }

  private extractFilesModified(diff: string): string[] {
    const files = new Set<string>();
    const regex = /^diff --git a\/(.+?) b\/(.+)/gm;
    let match;
    while ((match = regex.exec(diff)) !== null) {
      files.add(match[2]);
    }
    return [...files];
  }

  // ── Assertions ─────────────────────────────────────────────────────────

  private runAssertions(task: TaskManifest, diff: string) {
    const keyAssertions = (task.task.expected_changes.key_assertions ?? []).map(
      (pattern) => ({
        pattern,
        found: new RegExp(pattern, 'i').test(diff),
      })
    );

    const negativeAssertions = (task.task.expected_changes.negative_assertions ?? []).map(
      (pattern) => ({
        pattern,
        found: new RegExp(pattern, 'i').test(diff),
      })
    );

    return {
      keyAssertions,
      negativeAssertions,
      failToPass: [] as { test: string; passed: boolean }[],
      passToPass: [] as { test: string; passed: boolean }[],
    };
  }

  // ── SWE-bench Compatible Test Oracle ───────────────────────────────────

  private runTestOracle(
    oracle: NonNullable<TaskManifest['task']['test_oracle']>,
    worktreePath: string
  ): { failToPass: { test: string; passed: boolean }[]; passToPass: { test: string; passed: boolean }[] } {
    const runTests = (testIds: string[]): { test: string; passed: boolean }[] => {
      return testIds.map((testId) => {
        try {
          execSync(`${oracle.test_command} --testNamePattern="${testId}"`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 60_000,
            stdio: 'pipe',
          });
          return { test: testId, passed: true };
        } catch {
          return { test: testId, passed: false };
        }
      });
    };

    const result: {
      failToPass: { test: string; passed: boolean }[];
      passToPass: { test: string; passed: boolean }[];
      weakTestResults?: { test: string; passed: boolean }[];
      differentialTestingVerdict?: 'correct_fix' | 'plausible_but_wrong' | 'inconclusive';
    } = {
      failToPass: runTests(oracle.fail_to_pass),
      passToPass: runTests(oracle.pass_to_pass),
    };

    // Differential testing: run weak tests to catch plausible-but-wrong patches.
    // If the fix passes weak_test_ids but fails fail_to_pass, the model produced
    // a shallow fix that satisfies weak tests but not the real ones.
    if (oracle.weak_test_ids?.length) {
      result.weakTestResults = runTests(oracle.weak_test_ids);
      const allWeakPassed = result.weakTestResults.every((t) => t.passed);
      const allStrongPassed = result.failToPass.every((t) => t.passed);

      if (allWeakPassed && !allStrongPassed) {
        result.differentialTestingVerdict = 'plausible_but_wrong';
      } else if (allStrongPassed) {
        result.differentialTestingVerdict = 'correct_fix';
      } else {
        result.differentialTestingVerdict = 'inconclusive';
      }
    }

    return result;
  }

  // ── Failure Taxonomy (7 modes) ─────────────────────────────────────────

  private classifyFailure(
    task: TaskManifest,
    diff: string,
    filesRead: string[],
    filesModified: string[],
    cliResult: { exitCode: number | null; stdout: string },
    assertions: RunResult['assertionResults']
  ): FailureMode {
    // 1. Timeout — CLI was killed
    if (cliResult.exitCode === null || cliResult.exitCode === 137 || cliResult.exitCode === 143) {
      return 'timeout';
    }

    // 2. Complete hallucination — no diff at all, or modified completely wrong files
    if (!diff.trim()) {
      return 'complete_hallucination';
    }

    const expectedFiles = new Set(task.task.expected_changes.files_modified);
    const actualFiles = new Set(filesModified);
    const overlap = [...actualFiles].filter((f) => expectedFiles.has(f));

    if (overlap.length === 0 && actualFiles.size > 0) {
      return 'complete_hallucination';
    }

    // 3. Wrong files targeted — modified some right files but also many wrong ones
    const wrongFiles = [...actualFiles].filter((f) => !expectedFiles.has(f));
    if (wrongFiles.length > overlap.length) {
      return 'wrong_files_targeted';
    }

    // 4. Context insufficient — didn't read enough files
    const mustRead = new Set(task.task.expected_changes.files_must_read);
    const readSet = new Set(filesRead.map((f) => {
      const idx = f.indexOf('packages/');
      return idx !== -1 ? f.slice(idx) : f;
    }));
    const readCoverage = [...mustRead].filter((f) => readSet.has(f)).length / mustRead.size;
    if (readCoverage < 0.5) {
      return 'context_insufficient';
    }

    // 5. Cross-component miss — read the right files but missed cross-file connection
    if (task.task.category.includes('cross') && readCoverage < 0.8) {
      return 'cross_component_miss';
    }

    // 6. Test regression — key assertions pass but pass_to_pass tests fail
    const passToPassFailed = assertions.passToPass.some((t) => !t.passed);
    if (passToPassFailed) {
      return 'test_regression';
    }

    // 7. Shallow fix — touched the right files but assertions don't pass
    return 'shallow_fix';
  }

  /**
   * Determine if the run was successful.
   * A run is successful if:
   *   - All key assertions are found in the diff
   *   - No negative assertions are found
   *   - All fail_to_pass tests pass (if test oracle ran)
   *   - All pass_to_pass tests still pass (if test oracle ran)
   */
  private isSuccess(assertions: RunResult['assertionResults']): boolean {
    const keyPassed = assertions.keyAssertions.every((a) => a.found);
    const noNegatives = assertions.negativeAssertions.every((a) => !a.found);
    const failToPassOk = assertions.failToPass.length === 0 || assertions.failToPass.every((t) => t.passed);
    const passToPassOk = assertions.passToPass.length === 0 || assertions.passToPass.every((t) => t.passed);
    return keyPassed && noNegatives && failToPassOk && passToPassOk;
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  /**
   * Path Efficiency Score: relevant_files_read / total_files_read
   * Measures how directly the agent navigated to the bug.
   */
  private computePES(filesRead: string[], filesMustRead: string[]): number {
    if (filesRead.length === 0) return 0;

    const mustReadSet = new Set(filesMustRead);
    const normalized = filesRead.map((f) => {
      const idx = f.indexOf('packages/');
      return idx !== -1 ? f.slice(idx) : f;
    });

    const relevant = normalized.filter((f) => mustReadSet.has(f)).length;
    return Math.round((relevant / filesRead.length) * 100) / 100;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.round(text.length / 4);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.worktree) {
      this.worktree.cleanup();
      this.worktree = null;
    }
    if (this.homeDir && fs.existsSync(this.homeDir)) {
      fs.rmSync(this.homeDir, { recursive: true, force: true });
      this.homeDir = null;
    }
  }

  private log(msg: string): void {
    if (this.verbose) console.log(`  [LongContextRig] ${msg}`);
  }
}
