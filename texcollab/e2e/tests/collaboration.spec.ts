import { expect, type Page, test } from '@playwright/test';
import { Api, createProject, createUser, openProject, PASSWORD, userPage } from './helpers';

test('shares a project and edits it together in real time', async ({ browser }) => {
  const admin = await Api.admin();
  const alice = await createUser(admin, 'alice');
  const bob = await createUser(admin, 'bob');
  const project = await createProject(await Api.login(alice.username, PASSWORD), 'Shared paper');

  const a = await userPage(browser, alice.username);
  await openProject(a, project.id);
  await a.getByRole('button', { name: 'Share' }).click();
  await a.getByLabel('Name, username or e-mail address').fill(bob.username);
  await a.locator('.suggestions button', { hasText: bob.username }).click();
  await a.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(a.getByText(bob.displayName)).toBeVisible();
  await a.keyboard.press('Escape');

  const b = await userPage(browser, bob.username);
  await expect(b.getByText('Shared paper')).toBeVisible();
  await openProject(b, project.id);

  // Both type into the same line at the same time; both edits survive.
  await a.locator('.cm-line', { hasText: 'Start writing here.' }).click();
  await b.locator('.cm-line', { hasText: 'Start writing here.' }).click();
  await a.keyboard.press('End');
  await b.keyboard.press('Home');
  await Promise.all([a.keyboard.type(' [alice]', { delay: 15 }), b.keyboard.type('[bob] ', { delay: 15 })]);
  for (const page of [a, b]) {
    await expect.poll(() => lineText(page, 'Start writing')).toBe('[bob] Start writing here. [alice]');
  }
  await expect(a.locator('.presence .avatar')).toHaveCount(2);

  // File tree changes reach the other user.
  await b.getByTitle('New file').click();
  await b.getByPlaceholder('File name').fill('bob-notes.tex');
  await b.keyboard.press('Enter');
  await expect(a.getByRole('tree').getByText('bob-notes.tex')).toBeVisible();
});

test('viewers get a read-only editor', async ({ browser }) => {
  const admin = await Api.admin();
  const owner = await createUser(admin, 'owner');
  const viewer = await createUser(admin, 'viewer');
  const api = await Api.login(owner.username, PASSWORD);
  const project = await createProject(api, 'Read only');
  await api.post(`/api/projects/${project.id}/members`, { userId: viewer.id, role: 'viewer' });

  const v = await userPage(browser, viewer.username);
  await openProject(v, project.id);
  await expect(v.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(v.getByTitle('New file')).toHaveCount(0);
});

/** Text of an editor line without remote-cursor widgets (name labels, zero-width joiners). */
function lineText(page: Page, containing: string): Promise<string> {
  return page.locator('.cm-line', { hasText: containing }).evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const w of copy.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo')) w.remove();
    return (copy.textContent ?? '').replace(/\u2060/g, '');
  });
}
