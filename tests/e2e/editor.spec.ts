import { test, expect } from '@playwright/test';

test('mode toggle switches views', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('AgentDiagram')).toBeVisible();
  // Default: editor mode
  await expect(page.getByText(/Examples/i)).toBeVisible();
  // Toggle to agent
  await page.getByRole('button', { name: /Agentic Explorer/i }).first().click();
  await expect(page.getByText(/AI Provider/i)).toBeVisible();
  await page.getByRole('button', { name: /Multi Layer/i }).first().click();
  await expect(page.getByText(/Generate layered diagrams/i)).toBeVisible();
  await expect(page.getByText(/Multi-Layer mode/i)).toBeVisible();
  await page.getByRole('button', { name: /Code Editor/i }).first().click();
  await expect(page.getByText(/Examples/i)).toBeVisible();
});

test('loading the tiny flow example renders a diagram', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tiny Flow' }).click();
  // Wait for SVG to render with at least one rect (group/node)
  const svg = page.locator('.diagram-canvas svg');
  await expect(svg).toBeVisible();
  await expect(svg.locator('rect')).not.toHaveCount(0);
});
