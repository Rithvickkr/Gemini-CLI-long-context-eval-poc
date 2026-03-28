#!/usr/bin/env npx tsx
/**
 * leaderboard.ts — Generates a markdown leaderboard from eval results.
 *
 * Reads run results and produces:
 *   - Model ranking by pass rate
 *   - Per-category breakdown
 *   - Per-difficulty breakdown
 *   - PES ranking (navigation efficiency)
 *   - Badge-ready summary line
 *
 * Output: evals/logs/LEADERBOARD.md (can be committed to GitHub)
 *
 * Usage:
 *   npx tsx scripts/leaderboard.ts
 *   npx tsx scripts/leaderboard.ts --dir evals/logs/results --out LEADERBOARD.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface RunResult {
  taskId: string;
  model?: string;
  hintLevel?: string;
  success: boolean;
  pathEfficiencyScore: number;
  failureMode: string | null;
  durationMs: number;
}

interface ModelEntry {
  model: string;
  runs: number;
  passed: number;
  passRate: number;
  avgPES: number;
  avgDurationMs: number;
  byCategory: Record<string, { passed: number; total: number }>;
  byDifficulty: Record<string, { passed: number; total: number }>;
}

function loadResults(resultsDir: string): RunResult[] {
  if (!fs.existsSync(resultsDir)) return [];
  return fs.readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')); }
      catch { return null; }
    }).filter(Boolean);
}

function loadTasks(tasksDir: string): Map<string, any> {
  const map = new Map<string, any>();
  if (!fs.existsSync(tasksDir)) return map;
  for (const f of fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'))) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8'));
      map.set(t.task_id, t);
    } catch { /* skip */ }
  }
  return map;
}

function buildLeaderboard(results: RunResult[], taskMeta: Map<string, any>): ModelEntry[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of results) {
    const m = r.model ?? 'unknown';
    if (!byModel.has(m)) byModel.set(m, []);
    byModel.get(m)!.push(r);
  }

  return [...byModel.entries()].map(([model, runs]) => {
    const passed = runs.filter((r) => r.success).length;
    const byCategory: Record<string, { passed: number; total: number }> = {};
    const byDifficulty: Record<string, { passed: number; total: number }> = {};

    for (const r of runs) {
      const task = taskMeta.get(r.taskId);
      const cat = task?.task?.category ?? 'unknown';
      const diff = String(task?.task?.difficulty?.overall ?? '?');

      if (!byCategory[cat]) byCategory[cat] = { passed: 0, total: 0 };
      byCategory[cat].total++;
      if (r.success) byCategory[cat].passed++;

      if (!byDifficulty[diff]) byDifficulty[diff] = { passed: 0, total: 0 };
      byDifficulty[diff].total++;
      if (r.success) byDifficulty[diff].passed++;
    }

    return {
      model,
      runs: runs.length,
      passed,
      passRate: Math.round(passed / runs.length * 1000) / 10,
      avgPES: Math.round(runs.reduce((s, r) => s + r.pathEfficiencyScore, 0) / runs.length * 100) / 100,
      avgDurationMs: Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length),
      byCategory,
      byDifficulty,
    };
  }).sort((a, b) => b.passRate - a.passRate);
}

function renderMarkdown(board: ModelEntry[], taskMeta: Map<string, any>, date: string): string {
  const lines: string[] = [];

  lines.push('# Long-Context Eval Leaderboard');
  lines.push('');
  lines.push(`> Generated: ${date} | Tasks: ${taskMeta.size} | Repos: ${new Set([...taskMeta.values()].map((t) => t.repository?.url)).size}`);
  lines.push('');

  // Overall ranking
  lines.push('## Overall Ranking');
  lines.push('');
  lines.push('| Rank | Model | Pass Rate | PES | Tasks | Avg Time |');
  lines.push('|------|-------|-----------|-----|-------|----------|');
  board.forEach((e, i) => {
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    lines.push(
      `| ${rank} | \`${e.model}\` | **${e.passRate}%** | ${e.avgPES} | ${e.passed}/${e.runs} | ${(e.avgDurationMs / 1000).toFixed(1)}s |`
    );
  });
  lines.push('');

  // Per-category breakdown
  const allCategories = new Set(
    board.flatMap((e) => Object.keys(e.byCategory))
  );

  if (allCategories.size > 0) {
    lines.push('## Pass Rate by Category');
    lines.push('');
    const header = ['| Category', ...board.map((e) => `\`${e.model.split('/').pop()}\``), '|'].join(' | ');
    const sep = ['|---', ...board.map(() => '---'), '|'].join('|');
    lines.push(header);
    lines.push(sep);

    for (const cat of [...allCategories].sort()) {
      const row = board.map((e) => {
        const s = e.byCategory[cat];
        if (!s) return '-';
        return `${Math.round(s.passed / s.total * 100)}%`;
      });
      lines.push(`| \`${cat}\` | ${row.join(' | ')} |`);
    }
    lines.push('');
  }

  // Per-difficulty breakdown
  lines.push('## Pass Rate by Difficulty (1=Easy, 5=Hard)');
  lines.push('');
  const diffHeader = ['| Difficulty', ...board.map((e) => `\`${e.model.split('/').pop()}\``), '|'].join(' | ');
  lines.push(diffHeader);
  lines.push(['|---', ...board.map(() => '---'), '|'].join('|'));
  for (const diff of ['1', '2', '3', '4', '5']) {
    const hasAny = board.some((e) => e.byDifficulty[diff]);
    if (!hasAny) continue;
    const row = board.map((e) => {
      const s = e.byDifficulty[diff];
      if (!s) return '-';
      return `${Math.round(s.passed / s.total * 100)}% (${s.passed}/${s.total})`;
    });
    lines.push(`| Level ${diff} | ${row.join(' | ')} |`);
  }
  lines.push('');

  // Navigation efficiency
  lines.push('## Navigation Efficiency (PES)');
  lines.push('');
  lines.push('> PES = relevant_files_read / total_files_read. Higher = more direct navigation to the bug.');
  lines.push('');
  lines.push('| Model | Avg PES | Interpretation |');
  lines.push('|-------|---------|----------------|');
  for (const e of board) {
    const interp = e.avgPES >= 0.7 ? 'Excellent — navigates directly' :
                   e.avgPES >= 0.5 ? 'Good — minimal distraction' :
                   e.avgPES >= 0.3 ? 'Fair — some irrelevant reads' : 'Poor — scattered exploration';
    lines.push(`| \`${e.model}\` | ${e.avgPES} | ${interp} |`);
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('*Generated by [long-context-eval-poc](https://github.com/google-gemini/gemini-cli) — GSoC 2026*');

  return lines.join('\n');
}

function generateDemoBoard(taskMeta: Map<string, any>): RunResult[] {
  const models = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  const results: RunResult[] = [];
  for (const [taskId] of taskMeta) {
    for (const model of models) {
      const bonus = model.includes('pro') ? 0.3 : model.includes('2.5') ? 0.1 : 0;
      results.push({
        taskId,
        model,
        hintLevel: 'symptom_only',
        success: Math.random() < 0.5 + bonus,
        pathEfficiencyScore: 0.3 + Math.random() * 0.5 + bonus * 0.2,
        failureMode: null,
        durationMs: 40000 + Math.random() * 80000,
      });
    }
  }
  return results;
}

function main(): void {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const outIdx = args.indexOf('--out');

  const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const resultsDir = dirIdx !== -1 ? args[dirIdx + 1] : path.resolve(scriptDir, '../evals/logs/results');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : path.resolve(scriptDir, '../evals/logs/LEADERBOARD.md');
  const tasksDir = path.resolve(scriptDir, '../dataset/tasks');

  const taskMeta = loadTasks(tasksDir);
  let results = loadResults(resultsDir);

  if (results.length === 0) {
    console.log('No results found — generating demo leaderboard...');
    results = generateDemoBoard(taskMeta);
  }

  const board = buildLeaderboard(results, taskMeta);
  const md = renderMarkdown(board, taskMeta, new Date().toISOString().split('T')[0]);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, md, 'utf-8');

  console.log(`\nLeaderboard written to: ${outFile}`);
  console.log(`Models ranked: ${board.map((e) => `${e.model} (${e.passRate}%)`).join(', ')}`);
}

main();
