import { expect, test } from '@playwright/test';
import { Api, createUser, PASSWORD, signIn } from './helpers';

test('non-administrators cannot open the administration pages', async ({ page }) => {
  const user = await createUser(await Api.admin());
  await signIn(page, user.username);
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Users' })).toHaveCount(0);
});

test('an administrator disables an account, which can no longer sign in', async ({ browser, page }) => {
  const admin = await Api.admin();
  const adminUser = await createUser(admin, 'admin');
  const target = await createUser(admin, 'target');
  // Promote the helper account through the API, then act through the UI as that admin.
  await admin.patch(`/api/admin/users/${adminUser.id}`, { isAdmin: true });
  await signIn(page, adminUser.username);
  await page.getByRole('link', { name: 'Administration' }).click();
  await page.getByLabel('Search users').fill(target.username);
  const row = page.getByRole('row', { name: new RegExp(target.username) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row).toContainText('Disabled');

  const other = await browser.newPage();
  await other.goto('/login');
  await other.getByLabel('Username').fill(target.username);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByRole('alert')).toContainText('disabled');
});
