/**
 * Long-Context Eval: sniffChunks OOM (#22170)
 *
 * Tests whether the agent can identify and fix unbounded buffer growth
 * in shellExecutionService.ts by tracing the sniffChunks accumulation
 * pattern across two functions (childProcessFallback and executeWithPty)
 * and comparing against the existing appendAndTruncate() pattern.
 *
 * This eval uses LongContextRig to spawn the REAL Gemini CLI binary
 * against a cloned repo worktree — not mock data.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LongContextRig, type TaskManifest, type RunResult } from './long-context-rig.js';
import { RepoManager } from './repo-manager.js';

// ── Task Loader ────────────────────────────────────────────────────────────

function loadTask(taskFile: string): TaskManifest {
  const taskPath = path.resolve(__dirname, '../../dataset/tasks', taskFile);
  return JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
}

// ── Assertion Helpers ──────────────────────────────────────────────────────

function assertDiffContains(diff: string, patterns: string[]): void {
  for (const pattern of patterns) {
    expect(diff).toMatch(new RegExp(pattern, 'i'));
  }
}

function assertDiffNotContains(diff: string, patterns: string[]): void {
  for (const pattern of patterns) {
    expect(diff).not.toMatch(new RegExp(pattern, 'i'));
  }
}

function assertFilesRead(result: RunResult, required: string[]): void {
  for (const file of required) {
    const found = result.filesRead.some(
      (f) => f.includes(file) || f.endsWith(file)
    );
    expect(found, `Agent should have read: ${file}`).toBe(true);
  }
}

// ── Shared Rig (cache reused across tests) ─────────────────────────────────

const repoManager = new RepoManager({ verbose: true });
const TASK_FILE = 'gemini-cli-sniffchunks-oom-001.json';

afterAll(() => {
  repoManager.cleanupAll();
});

// ── Eval Suite ─────────────────────────────────────────────────────────────

describe('long-context-eval: sniffchunks-oom', () => {
  const task = loadTask(TASK_FILE);

  /**
   * LIVE MODE: When GEMINI_API_KEY is set, spawns the real CLI binary.
   * MOCK MODE: Otherwise, uses mock results to validate the framework.
   *
   * This dual-mode approach lets the eval run in CI (live) and locally (mock).
   * Mirrors upstream pattern: runEval('USUALLY_PASSES', ...) skips
   * without RUN_EVALS env var.
   */
  const isLiveMode = !!process.env['GEMINI_API_KEY'] && !!process.env['RUN_EVALS'];

  // ── Live eval at symptom_only level (hardest) ──────────────────────────

  const liveTest = isLiveMode ? it : it.skip;

  liveTest('[live][symptom_only] agent identifies sniffChunks unbounded growth', async () => {
    const rig = new LongContextRig({
      repoManager,
      hintLevel: 'symptom_only',
      verbose: true,
    });

    try {
      const result = await rig.run(task);

      // Save result for analyze-results.ts
      const resultsDir = path.resolve(__dirname, '../logs/results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, `${task.task_id}-symptom_only.json`),
        JSON.stringify({ ...result, model: process.env['GEMINI_MODEL'] ?? 'unknown' }, null, 2)
      );

      // Core assertions
      assertDiffContains(result.diff, task.task.expected_changes.key_assertions);
      assertFilesRead(result, task.task.expected_changes.files_must_read);

      // Only expected files modified
      for (const modified of result.filesModified) {
        const expected = task.task.expected_changes.files_modified.some(
          (f) => modified.includes(f) || modified.endsWith(f)
        );
        expect(expected, `Unexpected file modified: ${modified}`).toBe(true);
      }

      // Negative assertions
      if (task.task.expected_changes.negative_assertions) {
        assertDiffNotContains(result.diff, task.task.expected_changes.negative_assertions);
      }

      // PES > 0.3 (agent should navigate somewhat efficiently)
      expect(result.pathEfficiencyScore).toBeGreaterThan(0.3);

      // No complete hallucination
      expect(result.failureMode).not.toBe('complete_hallucination');
    } finally {
      await rig.cleanup();
    }
  }, task.eval_config.timeout_ms);

  liveTest('[live][file_hint] agent fixes with file hint', async () => {
    const rig = new LongContextRig({
      repoManager,
      hintLevel: 'file_hint',
      verbose: true,
    });

    try {
      const result = await rig.run(task);

      fs.mkdirSync(path.resolve(__dirname, '../logs/results'), { recursive: true });
      fs.writeFileSync(
        path.resolve(__dirname, `../logs/results/${task.task_id}-file_hint.json`),
        JSON.stringify({ ...result, model: process.env['GEMINI_MODEL'] ?? 'unknown' }, null, 2)
      );

      assertDiffContains(result.diff, ['sniffChunks', 'length']);
      expect(result.pathEfficiencyScore).toBeGreaterThan(0.5);
    } finally {
      await rig.cleanup();
    }
  }, task.eval_config.timeout_ms);

  // ── Framework validation (always runs, no API key needed) ──────────────

  it('[framework] task loads and validates correctly', () => {
    expect(task.schema_version).toBe('1.0.0');
    expect(task.task_id).toMatch(/^[a-z0-9-]+-[0-9]{3}$/);
    expect(task.task.reasoning_forcing_score).toBeGreaterThanOrEqual(3);
  });

  it('[framework] files_must_read is superset of files_modified', () => {
    const mustRead = new Set(task.task.expected_changes.files_must_read);
    for (const modified of task.task.expected_changes.files_modified) {
      expect(mustRead.has(modified), `files_must_read missing: ${modified}`).toBe(true);
    }
  });

  it('[framework] reasoning chain covers difficulty steps', () => {
    expect(task.task.reasoning_chain.length).toBeGreaterThanOrEqual(
      task.task.difficulty.reasoning_steps
    );
  });

  it('[framework] hint levels provide progressive disclosure', () => {
    const symptom = task.task.hint_levels.symptom_only.toLowerCase();
    const fileHint = task.task.hint_levels.file_hint.toLowerCase();
    const funcHint = task.task.hint_levels.function_hint.toLowerCase();

    // Symptom should NOT contain file paths
    for (const file of task.task.expected_changes.files_modified) {
      expect(symptom).not.toContain(path.basename(file).toLowerCase());
    }

    // File hint SHOULD mention at least one file
    const mentionsFile = task.task.expected_changes.files_modified.some(
      (f) => fileHint.includes(path.basename(f).toLowerCase()) ||
             fileHint.includes(path.dirname(f).split('/').pop()!.toLowerCase())
    );
    expect(mentionsFile, 'file_hint should mention a file or directory').toBe(true);

    // Function hint should be the most specific
    expect(funcHint.length).toBeGreaterThan(symptom.length);
  });

  it('[metric] RFS ensures long-context reasoning is required', () => {
    // RFS ≥ 3 means this task cannot be solved without reading multiple files
    expect(task.task.reasoning_forcing_score).toBeGreaterThanOrEqual(3);
    expect(task.task.difficulty.context_depth).not.toBe('single_function');
  });

  it('[metric] contamination risk is acceptable', () => {
    expect(task.task.contamination_info.training_cutoff_risk).toBe('low');
    if (task.task.contamination_info.contamination_score !== undefined) {
      expect(task.task.contamination_info.contamination_score).toBeLessThan(0.3);
    }
  });
});
