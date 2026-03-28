#!/usr/bin/env npx tsx
/**
 * benchmark-runner.ts — Orchestrates multi-model, multi-task eval runs.
 *
 * Coordinates:
 *   1. Task selection via TaskLoader (filter by RFS, difficulty, category)
 *   2. Sequential/parallel model evaluation
 *   3. Result persistence per task per model
 *   4. Progress reporting with ETA
 *   5. Automatic leaderboard + analysis on completion
 *
 * Usage:
 *   npx tsx scripts/benchmark-runner.ts --dry-run
 *   npx tsx scripts/benchmark-runner.ts --model gemini-2.5-flash --min-rfs 5
 *   npx tsx scripts/benchmark-runner.ts --models all --hint-level file_hint
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskLoader, type TaskFilter, type SamplingStrategy } from '../evals/long-context/task-loader.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface RunnerConfig {
  models: string[];
  hintLevel: 'symptom_only' | 'file_hint' | 'function_hint';
  filter: TaskFilter;
  sampling: SamplingStrategy;
  dryRun: boolean;
  resultsDir: string;
  maxConcurrent: number;
}

interface RunSummary {
  model: string;
  taskId: string;
  hintLevel: string;
  success: boolean | null;
  durationMs: number;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ALL_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const DEFAULT_RESULTS_DIR = path.resolve(SCRIPT_DIR, '../evals/logs/results');

// ── Config from CLI args ───────────────────────────────────────────────────

function parseArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const has = (flag: string) => args.includes(flag);

  const modelsArg = get('--models') ?? get('--model');
  const models = modelsArg === 'all' ? ALL_MODELS
    : modelsArg ? [modelsArg]
    : [process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash'];

  const minRFS = parseInt(get('--min-rfs') ?? get('--minRFS') ?? process.env['MIN_RFS'] ?? '3', 10);
  const maxDiff = parseInt(get('--max-difficulty') ?? '5', 10);
  const category = get('--category');
  const repo = get('--repo');

  return {
    models,
    hintLevel: (get('--hint-level') ?? process.env['LONG_CONTEXT_HINT_LEVEL'] ?? 'symptom_only') as any,
    filter: {
      minRFS,
      maxDifficulty: maxDiff,
      maxContaminationScore: 0.4,
      excludeDrafts: true,
      ...(category ? { categories: [category] } : {}),
      ...(repo ? { repos: [repo] } : {}),
    },
    sampling: {
      mode: has('--stratified') ? 'stratified' : 'rfs_weighted',
      maxTotal: parseInt(get('--max-tasks') ?? '100', 10),
    },
    dryRun: has('--dry-run') || has('--dry'),
    resultsDir: get('--results-dir') ?? DEFAULT_RESULTS_DIR,
    maxConcurrent: 1, // Sequential for now (rate limiting)
  };
}

// ── Progress Reporter ──────────────────────────────────────────────────────

class ProgressReporter {
  private total: number;
  private done = 0;
  private passed = 0;
  private startTime = Date.now();

  constructor(total: number) {
    this.total = total;
  }

  report(summary: RunSummary): void {
    this.done++;
    if (summary.success) this.passed++;

    const pct = Math.round(this.done / this.total * 100);
    const elapsed = Date.now() - this.startTime;
    const eta = this.done > 0
      ? Math.round((elapsed / this.done) * (this.total - this.done) / 1000)
      : '?';

    const status = summary.success === null ? 'SKIP'
      : summary.success ? 'PASS' : 'FAIL';

    console.log(
      `[${String(this.done).padStart(3)}/${this.total}] ${status} ` +
      `${summary.taskId} (${summary.model}) ` +
      `${(summary.durationMs / 1000).toFixed(1)}s | ` +
      `${pct}% done, ETA ${eta}s`
    );
  }

  final(): void {
    const total = Date.now() - this.startTime;
    console.log('\n' + '='.repeat(60));
    console.log(`Completed: ${this.done} runs, ${this.passed} passed (${Math.round(this.passed/this.done*100)}%)`);
    console.log(`Total time: ${(total / 1000 / 60).toFixed(1)} minutes`);
    console.log('='.repeat(60));
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function runBenchmark(config: RunnerConfig): Promise<void> {
  const loader = new TaskLoader();
  const tasks = loader.sample(config.filter, config.sampling);

  if (tasks.length === 0) {
    console.error('No tasks match the filter. Try relaxing --min-rfs or --category.');
    process.exit(1);
  }

  const totalRuns = tasks.length * config.models.length;
  console.log('\n[BENCHMARK] Long-Context Eval Benchmark Runner');
  console.log('='.repeat(60));
  console.log(`Tasks:      ${tasks.length}`);
  console.log(`Models:     ${config.models.join(', ')}`);
  console.log(`Hint level: ${config.hintLevel}`);
  console.log(`Total runs: ${totalRuns}`);
  console.log(`Results to: ${config.resultsDir}`);

  if (config.dryRun) {
    console.log('\n[DRY RUN] Tasks that would be evaluated:\n');
    for (const t of tasks) {
      console.log(`  RFS=${t.task.reasoning_forcing_score} diff=${t.task.difficulty.overall} ${t.task_id}`);
    }
    console.log(`\nWould run ${totalRuns} evaluations across ${config.models.length} model(s).`);
    return;
  }

  fs.mkdirSync(config.resultsDir, { recursive: true });

  const progress = new ProgressReporter(totalRuns);
  const summaries: RunSummary[] = [];

  for (const model of config.models) {
    for (const task of tasks) {
      const resultFile = path.join(
        config.resultsDir,
        `${task.task_id}--${model.replace(/[^a-z0-9]/gi, '-')}--${config.hintLevel}.json`
      );

      // Skip already-completed runs (resume support)
      if (fs.existsSync(resultFile)) {
        const cached = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        const summary: RunSummary = {
          model, taskId: task.task_id, hintLevel: config.hintLevel,
          success: cached.success, durationMs: cached.durationMs,
        };
        summaries.push(summary);
        progress.report({ ...summary });
        continue;
      }

      const start = Date.now();
      let summary: RunSummary;

      try {
        // Dynamically import LongContextRig to avoid loading it in dry-run mode
        const { LongContextRig } = await import('../evals/long-context/long-context-rig.js');
        const rig = new LongContextRig({ hintLevel: config.hintLevel });

        try {
          const result = await rig.run(task);
          fs.writeFileSync(resultFile, JSON.stringify({ ...result, model }, null, 2));
          summary = {
            model, taskId: task.task_id, hintLevel: config.hintLevel,
            success: result.success, durationMs: Date.now() - start,
          };
        } finally {
          await rig.cleanup();
        }
      } catch (err) {
        const durationMs = Date.now() - start;
        summary = {
          model, taskId: task.task_id, hintLevel: config.hintLevel,
          success: null, durationMs, error: (err as Error).message,
        };
        // Write error result so it's not retried
        fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2));
      }

      summaries.push(summary);
      progress.report(summary);
    }
  }

  progress.final();

  // Auto-generate leaderboard
  console.log('\nGenerating leaderboard...');
  const { execSync } = await import('node:child_process');
  try {
    execSync(`npx tsx ${path.resolve(SCRIPT_DIR, 'leaderboard.ts')} --dir "${config.resultsDir}"`, {
      stdio: 'inherit', cwd: path.resolve(SCRIPT_DIR, '..'),
    });
  } catch { /* non-fatal */ }

  console.log('\nRun `npm run analyze` for detailed metrics and failure breakdown.');
}

// ── Entry Point ────────────────────────────────────────────────────────────

const config = parseArgs();
runBenchmark(config).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
