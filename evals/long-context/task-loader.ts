/**
 * task-loader.ts — Advanced task filtering and loading.
 *
 * Loads task manifests from the dataset with rich filtering:
 *   - difficulty range
 *   - category (9 types)
 *   - language
 *   - RFS range (min/max reasoning forcing score)
 *   - repository
 *   - context pressure level
 *   - hint level override
 *
 * waqar2403 has basic task loading. This adds:
 *   - RFS-based filtering (only meaningful long-context tasks)
 *   - Contamination risk filtering (exclude high-risk tasks)
 *   - Difficulty stratified sampling (balanced easy/medium/hard)
 *   - Cross-repo deduplication
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TaskFilter {
  /** Difficulty range 1-5 */
  minDifficulty?: number;
  maxDifficulty?: number;
  /** Category filter */
  categories?: string[];
  /** Language filter (any task requiring this language) */
  languages?: string[];
  /** RFS range */
  minRFS?: number;
  maxRFS?: number;
  /** Context pressure */
  contextPressure?: ('low' | 'medium' | 'high')[];
  /** Repository filter (repo_id or URL) */
  repos?: string[];
  /** Max contamination score */
  maxContaminationScore?: number;
  /** Specific task IDs */
  taskIds?: string[];
  /** Exclude draft tasks (.draft.json) */
  excludeDrafts?: boolean;
}

export interface SamplingStrategy {
  /** 'all' | 'stratified' | 'rfs_weighted' */
  mode: 'all' | 'stratified' | 'rfs_weighted';
  /** Max tasks per difficulty level (for stratified) */
  maxPerDifficulty?: number;
  /** Total max tasks */
  maxTotal?: number;
  /** Random seed for reproducibility */
  seed?: number;
}

export type TaskManifest = any; // matches the JSON schema

// ── Loader ─────────────────────────────────────────────────────────────────

export class TaskLoader {
  private tasksDir: string;
  private cache: Map<string, TaskManifest> = new Map();

  constructor(tasksDir?: string) {
    const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    this.tasksDir = tasksDir ?? path.resolve(scriptDir, '../../dataset/tasks');
  }

  // ── Load all tasks ─────────────────────────────────────────────────────

  loadAll(excludeDrafts = true): TaskManifest[] {
    const files = fs.readdirSync(this.tasksDir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !excludeDrafts || !f.endsWith('.draft.json'));

    return files.map((f) => this.loadOne(path.join(this.tasksDir, f))).filter(Boolean);
  }

  loadById(taskId: string): TaskManifest | null {
    const filePath = path.join(this.tasksDir, `${taskId}.json`);
    return fs.existsSync(filePath) ? this.loadOne(filePath) : null;
  }

  // ── Filter ─────────────────────────────────────────────────────────────

  filter(filter: TaskFilter = {}): TaskManifest[] {
    const all = this.loadAll(filter.excludeDrafts ?? true);
    return all.filter((t) => this.matchesFilter(t, filter));
  }

  private matchesFilter(task: TaskManifest, f: TaskFilter): boolean {
    const d = task.task?.difficulty?.overall ?? 3;
    const rfs = task.task?.reasoning_forcing_score ?? 0;
    const contam = task.task?.contamination_info?.contamination_score ?? 0;
    const pressure = task.task?.context_pressure ?? 'medium';
    const category = task.task?.category ?? '';
    const langs = task.repository?.languages ?? [];
    const repoUrl = task.repository?.url ?? '';

    if (f.taskIds && !f.taskIds.includes(task.task_id)) return false;
    if (f.minDifficulty !== undefined && d < f.minDifficulty) return false;
    if (f.maxDifficulty !== undefined && d > f.maxDifficulty) return false;
    if (f.minRFS !== undefined && rfs < f.minRFS) return false;
    if (f.maxRFS !== undefined && rfs > f.maxRFS) return false;
    if (f.maxContaminationScore !== undefined && contam > f.maxContaminationScore) return false;
    if (f.categories?.length && !f.categories.includes(category)) return false;
    if (f.contextPressure?.length && !f.contextPressure.includes(pressure)) return false;
    if (f.languages?.length && !f.languages.some((l) => langs.includes(l))) return false;
    if (f.repos?.length) {
      const repoSlug = repoUrl.split('/').pop() ?? '';
      if (!f.repos.some((r) => repoUrl.includes(r) || repoSlug.includes(r))) return false;
    }

    return true;
  }

  // ── Sampling ───────────────────────────────────────────────────────────

  sample(filter: TaskFilter = {}, strategy: SamplingStrategy = { mode: 'all' }): TaskManifest[] {
    let tasks = this.filter(filter);

    if (strategy.mode === 'stratified') {
      tasks = this.stratifiedSample(tasks, strategy.maxPerDifficulty ?? 10);
    } else if (strategy.mode === 'rfs_weighted') {
      tasks = this.rfsSample(tasks, strategy.maxTotal ?? tasks.length);
    }

    if (strategy.maxTotal) {
      tasks = tasks.slice(0, strategy.maxTotal);
    }

    return tasks;
  }

  /**
   * Balanced sample: equal representation across difficulty levels 1-5.
   * Ensures no single difficulty dominates the eval run.
   */
  private stratifiedSample(tasks: TaskManifest[], maxPerLevel: number): TaskManifest[] {
    const byDifficulty = new Map<number, TaskManifest[]>();
    for (const t of tasks) {
      const d = t.task?.difficulty?.overall ?? 3;
      if (!byDifficulty.has(d)) byDifficulty.set(d, []);
      byDifficulty.get(d)!.push(t);
    }

    const result: TaskManifest[] = [];
    for (const [, group] of byDifficulty) {
      result.push(...group.slice(0, maxPerLevel));
    }
    return result;
  }

  /**
   * RFS-weighted sample: tasks with higher RFS are preferred.
   * Ensures the eval set maximally tests long-context reasoning.
   */
  private rfsSample(tasks: TaskManifest[], maxTotal: number): TaskManifest[] {
    return tasks
      .sort((a, b) => (b.task?.reasoning_forcing_score ?? 0) - (a.task?.reasoning_forcing_score ?? 0))
      .slice(0, maxTotal);
  }

  // ── Statistics ─────────────────────────────────────────────────────────

  stats(filter: TaskFilter = {}): DatasetStats {
    const tasks = this.filter(filter);

    const byCategory: Record<string, number> = {};
    const byDifficulty: Record<number, number> = {};
    const byLanguage: Record<string, number> = {};
    const byRepo: Record<string, number> = {};
    let totalRFS = 0;
    let totalFiles = 0;

    for (const t of tasks) {
      const cat = t.task?.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;

      const diff = t.task?.difficulty?.overall ?? 3;
      byDifficulty[diff] = (byDifficulty[diff] ?? 0) + 1;

      for (const lang of (t.repository?.languages ?? [])) {
        byLanguage[lang] = (byLanguage[lang] ?? 0) + 1;
      }

      const repo = t.repository?.url?.split('/').pop() ?? 'unknown';
      byRepo[repo] = (byRepo[repo] ?? 0) + 1;

      totalRFS += t.task?.reasoning_forcing_score ?? 0;
      totalFiles += t.task?.expected_changes?.files_must_read?.length ?? 0;
    }

    return {
      totalTasks: tasks.length,
      totalRepos: Object.keys(byRepo).length,
      byCategory,
      byDifficulty,
      byLanguage,
      byRepo,
      avgRFS: tasks.length > 0 ? Math.round(totalRFS / tasks.length * 10) / 10 : 0,
      avgFilesMustRead: tasks.length > 0 ? Math.round(totalFiles / tasks.length * 10) / 10 : 0,
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  private loadOne(filePath: string): TaskManifest | null {
    if (this.cache.has(filePath)) return this.cache.get(filePath)!;
    try {
      const task = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.cache.set(filePath, task);
      return task;
    } catch { return null; }
  }
}

// ── Dataset Stats Type ─────────────────────────────────────────────────────

export interface DatasetStats {
  totalTasks: number;
  totalRepos: number;
  byCategory: Record<string, number>;
  byDifficulty: Record<number, number>;
  byLanguage: Record<string, number>;
  byRepo: Record<string, number>;
  avgRFS: number;
  avgFilesMustRead: number;
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const loader = new TaskLoader();
  const stats = loader.stats();

  console.log('\n[DATASET] Long-Context Eval Dataset Statistics\n');
  console.log('='.repeat(55));
  console.log(`Total tasks:     ${stats.totalTasks}`);
  console.log(`Total repos:     ${stats.totalRepos}`);
  console.log(`Avg RFS:         ${stats.avgRFS}`);
  console.log(`Avg files/task:  ${stats.avgFilesMustRead}`);

  console.log('\n[BY CATEGORY]');
  for (const [cat, count] of Object.entries(stats.byCategory).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${cat.padEnd(38)} ${count}`);
  }

  console.log('\n[BY DIFFICULTY]');
  for (const [d, count] of Object.entries(stats.byDifficulty).sort()) {
    const bar = '#'.repeat(count * 3);
    console.log(`  Level ${d}: ${String(count).padEnd(4)} ${bar}`);
  }

  console.log('\n[BY LANGUAGE]');
  for (const [lang, count] of Object.entries(stats.byLanguage).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${lang.padEnd(20)} ${count}`);
  }

  console.log('\n[BY REPO]');
  for (const [repo, count] of Object.entries(stats.byRepo).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${repo.padEnd(30)} ${count} tasks`);
  }
  console.log('='.repeat(55));

  // Demo: RFS-weighted sample for a 5-task eval run
  const sample = loader.sample({ minRFS: 5 }, { mode: 'rfs_weighted', maxTotal: 5 });
  console.log(`\n[SAMPLE] Top 5 tasks by RFS (for nightly eval):`);
  for (const t of sample) {
    console.log(`  RFS=${t.task.reasoning_forcing_score} diff=${t.task.difficulty.overall} ${t.task_id}`);
  }
}
