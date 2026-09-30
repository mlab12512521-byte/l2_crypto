import { expect, test } from '@playwright/test';
import { Api, createUser, PASSWORD, signIn } from './helpers';

test('rejects a wrong password with a generic message', async ({ page }) => {
  const user = await createUser(await Api.admin());
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
});

test('signs in, keeps the session across reloads, and signs out', async ({ page }) => {
  const user = await createUser(await Api.admin());
  await signIn(page, user.username);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('an account created by an administrator must choose a new password first', async ({ page }) => {
  const admin = await Api.admin();
  const username = `e2e_new_${Date.now().toString(36)}`;
  await admin.post('/api/admin/users', {
    username,
    displayName: 'New Person',
    password: PASSWORD,
    mustChangePassword: true,
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/change-password/);
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill(`${PASSWORD} changed`);
  await page.getByLabel('Confirm new password').fill(`${PASSWORD} changed`);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});
