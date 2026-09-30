import { expect, test } from '@playwright/test';
import { Api, createUser, signIn, skipCompile, typeAfterPlaceholder } from './helpers';

test('creates a project, edits, adds a file and compiles', async ({ page }) => {
  const user = await createUser(await Api.admin());
  await signIn(page, user.username);

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('E2E paper');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();

  await typeAfterPlaceholder(page, ' Written by the end-to-end test.');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.cm-line', { hasText: 'Written by the end-to-end test.' })).toBeVisible();

  await page.getByTitle('New file').click();
  await page.getByPlaceholder('File name').fill('appendix.tex');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tree').getByText('appendix.tex')).toBeVisible();

  test.skip(skipCompile, 'no compile worker (E2E_SKIP_COMPILE=1)');
  await page.getByRole('button', { name: 'Recompile' }).click();
  await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.pdfViewer .textLayer')).toContainText('Written by the end-to-end test.', {
    timeout: 20_000,
  });
});

test('shows compile errors with their location', async ({ page }) => {
  test.skip(skipCompile, 'no compile worker (E2E_SKIP_COMPILE=1)');
  const user = await createUser(await Api.admin());
  await signIn(page, user.username);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('E2E broken');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await typeAfterPlaceholder(page, ' \\undefinedcommand');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recompile' }).click();
  await expect(page.locator('.count-error').first()).toBeVisible({ timeout: 60_000 });
  await page.getByTitle('Show compiler messages').click();
  await expect(page.locator('.logs-panel')).toContainText('Undefined control sequence');
});
