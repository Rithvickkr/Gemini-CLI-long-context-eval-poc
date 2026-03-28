#!/usr/bin/env npx tsx
/**
 * validate.ts — Schema validator for long-context eval task definitions.
 *
 * Validates all task JSON files against dataset/schema.json using AJV.
 * Also performs semantic checks that JSON Schema alone cannot enforce:
 *   - files_must_read ⊇ files_modified
 *   - reasoning_chain length ≥ difficulty.reasoning_steps
 *   - RFS ≥ 3 (redundant with schema, but double-checked)
 *   - hint_levels progressive disclosure (no answer leakage in symptom_only)
 *
 * Usage:
 *   npx tsx scripts/validate.ts                    # validate all tasks
 *   npx tsx scripts/validate.ts --task <id>        # validate single task
 *   npx tsx scripts/validate.ts --verbose          # show per-field details
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

interface TaskFile {
  schema_version: string;
  task_id: string;
  repository: {
    url: string;
    commit: string;
    languages: string[];
    size_files: number;
    size_lines: number;
    license: string;
    sparse_checkout_paths?: string[];
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
    context_pressure: string;
    difficulty: {
      files_involved: number;
      languages_required: number;
      reasoning_steps: number;
      context_depth: string;
      domain_knowledge: string;
      overall: number;
    };
    expected_changes: {
      files_modified: string[];
      files_must_read: string[];
      key_assertions: string[];
      negative_assertions?: string[];
      assertion_type?: string;
    };
    reasoning_chain: string[];
    contamination_info: {
      issue_created: string;
      fix_merged: string | null;
      training_cutoff_risk: string;
      contamination_score?: number;
      obfuscation_applied?: boolean;
    };
  };
  eval_config: {
    timeout_ms: number;
    policy: string;
    setup: string;
    test_oracle?: string | null;
    cleanup?: string;
  };
}

interface ValidationResult {
  taskId: string;
  file: string;
  schemaValid: boolean;
  schemaErrors: string[];
  semanticErrors: string[];
  warnings: string[];
}

// ── Paths ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')));
const DATASET_DIR = path.resolve(ROOT, '..', 'dataset');
const SCHEMA_PATH = path.join(DATASET_DIR, 'schema.json');
const TASKS_DIR = path.join(DATASET_DIR, 'tasks');
const REPOS_DIR = path.join(DATASET_DIR, 'repos');

// ── Repo Validation ────────────────────────────────────────────────────────

interface RepoValidationResult {
  repoId: string;
  file: string;
  errors: string[];
  warnings: string[];
}

function validateRepos(taskFiles: TaskFile[]): RepoValidationResult[] {
  if (!fs.existsSync(REPOS_DIR)) return [];

  const repoFiles = fs.readdirSync(REPOS_DIR).filter((f) => f.endsWith('.json'));
  const results: RepoValidationResult[] = [];

  for (const file of repoFiles) {
    const filePath = path.join(REPOS_DIR, file);
    const errors: string[] = [];
    const warnings: string[] = [];

    let repo: any;
    try {
      repo = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      results.push({ repoId: file, file: filePath, errors: [`Invalid JSON: ${(e as Error).message}`], warnings: [] });
      continue;
    }

    // Required fields
    for (const field of ['repo_id', 'url', 'commit', 'languages', 'license', 'task_ids']) {
      if (!(field in repo)) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Commit must be 40-char hex
    if (repo.commit && !/^[a-f0-9]{40}$/.test(repo.commit)) {
      errors.push(`commit must be a 40-character hex SHA, got: "${repo.commit}"`);
    }

    // task_ids must reference existing task files
    if (Array.isArray(repo.task_ids)) {
      for (const taskId of repo.task_ids) {
        const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
        if (!fs.existsSync(taskPath)) {
          errors.push(`task_ids references "${taskId}" but no file found at ${taskPath}`);
        }
      }

      // Cross-check: tasks that reference this repo URL should be listed
      for (const task of taskFiles) {
        if (task.repository?.url === repo.url) {
          if (!repo.task_ids.includes(task.task_id)) {
            warnings.push(`Task "${task.task_id}" references this repo but is not listed in task_ids`);
          }
        }
      }
    }

    // Commit in repo metadata should match tasks
    if (repo.commit && Array.isArray(repo.task_ids)) {
      for (const taskId of repo.task_ids) {
        const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
        if (fs.existsSync(taskPath)) {
          const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
          if (task.repository?.commit && task.repository.commit !== repo.commit) {
            warnings.push(`Task "${taskId}" uses commit ${task.repository.commit.slice(0, 8)} but repo metadata has ${repo.commit.slice(0, 8)}`);
          }
        }
      }
    }

    results.push({ repoId: repo.repo_id ?? file, file: filePath, errors, warnings });
  }

  return results;
}

// ── Schema Validation ──────────────────────────────────────────────────────

function loadSchema(): object {
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  return JSON.parse(raw);
}

function createValidator(schema: object): Ajv {
  const ajv = new Ajv({ allErrors: true, verbose: true });
  addFormats(ajv);
  ajv.compile(schema);
  return ajv;
}

// ── Semantic Checks ────────────────────────────────────────────────────────

function semanticCheck(task: TaskFile): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. files_must_read must be a superset of files_modified
  const mustRead = new Set(task.task.expected_changes.files_must_read);
  for (const modified of task.task.expected_changes.files_modified) {
    if (!mustRead.has(modified)) {
      errors.push(
        `files_modified contains "${modified}" but files_must_read does not — ` +
        `files_must_read must be a superset of files_modified`
      );
    }
  }

  // 2. reasoning_chain length should be ≥ difficulty.reasoning_steps
  const chainLen = task.task.reasoning_chain.length;
  const stepsRequired = task.task.difficulty.reasoning_steps;
  if (chainLen < stepsRequired) {
    errors.push(
      `reasoning_chain has ${chainLen} steps but difficulty.reasoning_steps requires ${stepsRequired}`
    );
  }

  // 3. RFS must be ≥ 3 (also enforced by schema, but belt-and-suspenders)
  if (task.task.reasoning_forcing_score < 3) {
    errors.push(
      `reasoning_forcing_score is ${task.task.reasoning_forcing_score}, must be ≥ 3`
    );
  }

  // 4. Symptom-only hint should NOT leak file names from expected_changes
  const symptomHint = task.task.hint_levels.symptom_only.toLowerCase();
  for (const file of task.task.expected_changes.files_modified) {
    const basename = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (basename.length > 4 && symptomHint.includes(basename)) {
      warnings.push(
        `symptom_only hint contains "${basename}" which appears in files_modified — ` +
        `this may leak the answer location`
      );
    }
  }

  // 5. Prompt should not contain exact file paths from expected_changes
  const promptLower = task.task.prompt.toLowerCase();
  for (const file of task.task.expected_changes.files_modified) {
    if (promptLower.includes(file.toLowerCase())) {
      warnings.push(
        `prompt contains exact path "${file}" from files_modified — ` +
        `prompts should describe symptoms, not locations`
      );
    }
  }

  // 6. files_involved should roughly match files_must_read count
  const mustReadCount = task.task.expected_changes.files_must_read.length;
  const filesInvolved = task.task.difficulty.files_involved;
  if (filesInvolved < mustReadCount) {
    warnings.push(
      `difficulty.files_involved (${filesInvolved}) < files_must_read count (${mustReadCount})`
    );
  }

  // 7. Task ID format: {repo-slug}-{number}
  const idPattern = /^[a-z0-9-]+-[0-9]{3}$/;
  if (!idPattern.test(task.task_id)) {
    errors.push(
      `task_id "${task.task_id}" does not match pattern {slug}-{NNN}`
    );
  }

  // 8. Overall difficulty should be plausible weighted average
  const d = task.task.difficulty;
  const contextMap: Record<string, number> = {
    single_function: 1, cross_function: 2, cross_file: 3, cross_package: 4
  };
  const domainMap: Record<string, number> = {
    generic_coding: 1, framework_specific: 2, architecture_level: 3
  };
  const weightedSum =
    (d.files_involved * 2) +
    d.languages_required +
    (d.reasoning_steps * 2) +
    (contextMap[d.context_depth] ?? 2) +
    (domainMap[d.domain_knowledge] ?? 2);
  const weightedAvg = weightedSum / 8; // 2+1+2+1+1 = 7 weights, but scaled to 1-5
  const normalized = Math.min(5, Math.max(1, Math.round(weightedAvg)));
  if (Math.abs(d.overall - normalized) > 1) {
    warnings.push(
      `difficulty.overall (${d.overall}) differs from computed weighted average (${normalized}) by >1`
    );
  }

  // 9. Contamination score should align with training_cutoff_risk
  const contam = task.task.contamination_info;
  if (contam.contamination_score !== undefined) {
    if (contam.training_cutoff_risk === 'low' && contam.contamination_score > 0.3) {
      warnings.push(
        `training_cutoff_risk is "low" but contamination_score is ${contam.contamination_score} (>0.3)`
      );
    }
    if (contam.training_cutoff_risk === 'high' && contam.contamination_score < 0.5) {
      warnings.push(
        `training_cutoff_risk is "high" but contamination_score is ${contam.contamination_score} (<0.5)`
      );
    }
  }

  return { errors, warnings };
}

// ── Main ───────────────────────────────────────────────────────────────────

function validateTask(filePath: string, ajvValidate: Ajv['compile'] extends (s: any) => infer V ? V : never): ValidationResult {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: TaskFile;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      taskId: path.basename(filePath),
      file: filePath,
      schemaValid: false,
      schemaErrors: [`Invalid JSON: ${(e as Error).message}`],
      semanticErrors: [],
      warnings: [],
    };
  }

  const schemaValid = ajvValidate(parsed) as boolean;
  const schemaErrors = schemaValid
    ? []
    : (ajvValidate.errors ?? []).map(
        (e) => `${e.instancePath || '/'}: ${e.message} ${e.params ? JSON.stringify(e.params) : ''}`
      );

  const { errors: semanticErrors, warnings } = semanticCheck(parsed);

  return {
    taskId: parsed.task_id ?? path.basename(filePath),
    file: filePath,
    schemaValid,
    schemaErrors,
    semanticErrors,
    warnings,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const taskFlag = args.indexOf('--task');
  const specificTask = taskFlag !== -1 ? args[taskFlag + 1] : null;

  // Load schema
  const schema = loadSchema();
  const ajv = new Ajv({ allErrors: true, verbose: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  // Find task files
  let taskFiles: string[];
  if (specificTask) {
    const candidates = [
      path.join(TASKS_DIR, `${specificTask}.json`),
      path.join(TASKS_DIR, specificTask),
    ];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) {
      console.error(`Task not found: ${specificTask}`);
      process.exit(1);
    }
    taskFiles = [found];
  } else {
    if (!fs.existsSync(TASKS_DIR)) {
      console.error(`Tasks directory not found: ${TASKS_DIR}`);
      process.exit(1);
    }
    taskFiles = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(TASKS_DIR, f));
  }

  if (taskFiles.length === 0) {
    console.error('No task files found.');
    process.exit(1);
  }

  // Validate
  console.log(`\n[*] Validating ${taskFiles.length} task file(s)...\n`);

  const results = taskFiles.map((f) => validateTask(f, validate));

  let hasErrors = false;

  for (const r of results) {
    const status = r.schemaValid && r.semanticErrors.length === 0 ? 'PASS' : 'FAIL';
    if (status === 'FAIL') hasErrors = true;

    console.log(`${status} ${r.taskId}`);

    if (r.schemaErrors.length > 0) {
      for (const e of r.schemaErrors) {
        console.log(`   SCHEMA: ${e}`);
      }
    }

    if (r.semanticErrors.length > 0) {
      for (const e of r.semanticErrors) {
        console.log(`   SEMANTIC: ${e}`);
      }
    }

    if (r.warnings.length > 0) {
      for (const w of r.warnings) {
        console.log(`   WARN: ${w}`);
      }
    }

    if (verbose) {
      console.log(`   File: ${r.file}`);
      console.log(`   Schema valid: ${r.schemaValid}`);
      console.log(`   Semantic errors: ${r.semanticErrors.length}`);
      console.log(`   Warnings: ${r.warnings.length}`);
    }

    console.log();
  }

  // ── Repo validation ──────────────────────────────────────────────────

  // Load all tasks for cross-referencing
  const allTasks: TaskFile[] = taskFiles.map((f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
    catch { return null; }
  }).filter(Boolean);

  const repoResults = validateRepos(allTasks);

  if (repoResults.length > 0) {
    console.log(`[*] Validating ${repoResults.length} repo file(s)...\n`);

    for (const r of repoResults) {
      const status = r.errors.length === 0 ? 'PASS' : 'FAIL';
      if (status === 'FAIL') hasErrors = true;

      console.log(`${status} ${r.repoId}`);

      for (const e of r.errors) {
        console.log(`   REPO: ${e}`);
      }
      for (const w of r.warnings) {
        console.log(`   WARN: ${w}`);
      }
      console.log();
    }
  }

  // Summary
  const passed = results.filter((r) => r.schemaValid && r.semanticErrors.length === 0).length;
  const failed = results.length - passed;
  const repoPassed = repoResults.filter((r) => r.errors.length === 0).length;
  const repoFailed = repoResults.length - repoPassed;
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0)
    + repoResults.reduce((sum, r) => sum + r.warnings.length, 0);

  console.log('-'.repeat(60));
  console.log(`Tasks:  ${passed} passed, ${failed} failed`);
  if (repoResults.length > 0) {
    console.log(`Repos:  ${repoPassed} passed, ${repoFailed} failed`);
  }
  console.log(`Warnings: ${totalWarnings}`);
  console.log('-'.repeat(60));

  if (hasErrors) {
    process.exit(1);
  }
}

main();
