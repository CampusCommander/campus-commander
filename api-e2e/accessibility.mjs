import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

export async function auditAccessibility(page, name) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const directory = 'dist/phase-2-evidence';
  await mkdir(directory, { recursive: true });
  const report = {
    name,
    engine: result.testEngine,
    recordedAt: new Date().toISOString(),
    violations: result.violations,
    incomplete: result.incomplete,
    passedRuleIds: result.passes.map(({ id }) => id),
    accessibilityTree: await page.locator('body').ariaSnapshot(),
    computedTheme: await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      color: getComputedStyle(document.documentElement).color,
      background: getComputedStyle(document.documentElement).backgroundColor,
    })),
    screenReaderWalkthrough: 'not-run',
  };
  await writeFile(
    `${directory}/${name}-accessibility.json`,
    JSON.stringify(report, null, 2),
  );
  assert.deepEqual(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
    [],
    `${name} accessibility violations`,
  );
}
