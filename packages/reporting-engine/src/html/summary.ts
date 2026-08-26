import { FailureCategory, TestOutcome, type RootCauseAnalysis, type Run } from '@aitp/shared';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Self-contained summary — no external CSS or JS — so it can be emailed,
 * archived as a Jenkins artifact or attached to a Jira ticket and still render.
 * The Phase 3 dashboard reads run.json instead; this is the portable fallback.
 */
export function renderRunSummaryHtml(run: Run): string {
  const summary = run.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
    passRate: 0,
  };

  const failures = run.results.filter(
    (result) => result.outcome === TestOutcome.Failed || result.outcome === TestOutcome.TimedOut,
  );

  const rows = run.results
    .map((result) => {
      const tone =
        result.outcome === TestOutcome.Passed
          ? '#0f7b4f'
          : result.outcome === TestOutcome.Skipped
            ? '#6b7280'
            : result.outcome === TestOutcome.Flaky
              ? '#b45309'
              : '#b91c1c';
      return `<tr>
        <td><span style="color:${tone};font-weight:600">${escapeHtml(result.outcome)}</span></td>
        <td>${escapeHtml(result.title)}</td>
        <td>${escapeHtml(result.project)}</td>
        <td style="text-align:right">${duration(result.durationMs)}</td>
      </tr>`;
    })
    .join('\n');

  const failureBlocks = failures
    .map(
      (result) => `<div class="failure">
        <h3>${escapeHtml(result.title)}</h3>
        <p class="file">${escapeHtml(result.file)} · ${escapeHtml(result.project)}</p>
        ${renderRca(result.error?.rca)}
        <pre>${escapeHtml((result.error?.message ?? '').slice(0, 1500))}</pre>
      </div>`,
    )
    .join('\n');

  const categories = countCategories(run);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Run ${escapeHtml(run.id)} — ${escapeHtml(run.status)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; background: #f7f7f8; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #111113; color: #e8e8ea; } .card, table { background: #1c1c1f !important; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
  .card { background: #fff; border: 1px solid rgba(128,128,128,.25); border-radius: 10px; padding: 14px 18px; min-width: 110px; }
  .card .label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  .card .value { font-size: 24px; font-weight: 650; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid rgba(128,128,128,.25); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid rgba(128,128,128,.18); font-size: 14px; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  tr:last-child td { border-bottom: none; }
  .failure { margin-top: 20px; border-left: 3px solid #b91c1c; padding-left: 14px; }
  .failure h3 { margin: 0 0 2px; font-size: 15px; }
  .failure .file { margin: 0 0 8px; color: #6b7280; font-size: 12px; }
  .failure .rca { background: rgba(37,99,235,.10); padding: 10px 12px; border-radius: 6px; font-size: 13px; margin: 0 0 10px; }
  .failure .rca .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; background: rgba(128,128,128,.2); }
  .badge.application-bug { background: rgba(185,28,28,.18); color: #b91c1c; }
  .badge.test-bug, .badge.selector { background: rgba(180,83,9,.18); color: #b45309; }
  .badge.environment { background: rgba(109,40,217,.18); color: #6d28d9; }
  .badge.test-data { background: rgba(15,123,79,.18); color: #0f7b4f; }
  .badge.flaky, .badge.unknown { background: rgba(107,114,128,.2); color: #6b7280; }
  .conf { font-size: 12px; color: #6b7280; }
  .failure .rca ul { margin: 6px 0 0; padding-left: 18px; }
  .failure .rca li { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; color: #6b7280; }
  .failure .fix { margin-top: 6px; }
  pre { background: rgba(128,128,128,.12); padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
</style>
</head>
<body>
  <h1>Run ${escapeHtml(run.id)} — ${escapeHtml(run.status.toUpperCase())}</h1>
  <p class="meta">
    Environment <strong>${escapeHtml(run.request.environment)}</strong> ·
    started ${escapeHtml(run.startedAt ?? run.createdAt)} ·
    duration ${duration(summary.durationMs)}
  </p>

  <div class="tiles">
    <div class="card"><div class="label">Pass rate</div><div class="value">${summary.passRate}%</div></div>
    <div class="card"><div class="label">Total</div><div class="value">${summary.total}</div></div>
    <div class="card"><div class="label">Passed</div><div class="value">${summary.passed}</div></div>
    <div class="card"><div class="label">Failed</div><div class="value">${summary.failed}</div></div>
    <div class="card"><div class="label">Flaky</div><div class="value">${summary.flaky}</div></div>
    <div class="card"><div class="label">Skipped</div><div class="value">${summary.skipped}</div></div>
  </div>

  ${
    categories.length
      ? `<div class="tiles">${categories
          .map(
            ([category, count]) =>
              `<div class="card"><div class="label">${escapeHtml(category)}</div><div class="value">${count}</div></div>`,
          )
          .join('')}</div>`
      : ''
  }

  <table>
    <thead><tr><th>Result</th><th>Test</th><th>Project</th><th style="text-align:right">Duration</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${failures.length ? `<h2 style="font-size:17px;margin-top:32px">Failures (${failures.length})</h2>${failureBlocks}` : ''}
</body>
</html>`;
}

function countCategories(run: Run): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const result of run.results) {
    const category = result.error?.rca?.category;
    if (!category || category === FailureCategory.Unknown) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Confidence is shown, not hidden: a low-confidence verdict is presented as a
 * guess so nobody files a bug on the strength of a coin flip.
 */
function renderRca(rca: RootCauseAnalysis | undefined): string {
  if (!rca) return '';

  const confident = rca.confidence >= 0.5;
  const label = confident ? 'Root cause' : 'Possible cause (low confidence)';
  const evidence = rca.evidence.length
    ? `<ul>${rca.evidence.map((line) => `<li>${escapeHtml(line.slice(0, 200))}</li>`).join('')}</ul>`
    : '';
  const fix = rca.suggestedFix
    ? `<div class="fix"><strong>Suggested fix:</strong> ${escapeHtml(rca.suggestedFix)}</div>`
    : '';

  return `<div class="rca">
      <div class="head">
        <span class="badge ${escapeHtml(rca.category)}">${escapeHtml(rca.category)}</span>
        <strong>${label}</strong>
        <span class="conf">${Math.round(rca.confidence * 100)}% · ${escapeHtml(rca.analyzedBy)}</span>
      </div>
      ${escapeHtml(rca.rootCause)}
      ${fix}
      ${evidence}
    </div>`;
}
