import { expect, test } from '@playwright/test';
import { Api, createUser, signIn, typeAfterPlaceholder } from './helpers';

test('saves a named version, shows the diff and restores an earlier version', async ({ page }) => {
  const user = await createUser(await Api.admin());
  await signIn(page, user.username);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('E2E history');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await typeAfterPlaceholder(page, ' Added later.');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  page.once('dialog', (d) => void d.accept('First draft'));
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.version-label', { hasText: 'First draft' })).toBeVisible();
  await expect(page.locator('.diff-add').first()).toContainText('Added later.');

  page.once('dialog', (d) => void d.accept());
  await page.locator('.version').last().click();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.cm-line', { hasText: 'Start writing here.' })).not.toContainText('Added later.');
});
