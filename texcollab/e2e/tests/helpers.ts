import { randomBytes } from 'node:crypto';
import { type APIRequestContext, type Browser, expect, type Page, request } from '@playwright/test';

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';
export const PASSWORD = 'e2e correct horse battery staple';
export const skipCompile = process.env.E2E_SKIP_COMPILE === '1';

/** API session that behaves like the SPA (same Origin, CSRF header). */
export class Api {
  private constructor(
    readonly ctx: APIRequestContext,
    private readonly csrf: string,
  ) {}

  static async login(username: string, password: string): Promise<Api> {
    const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
    const res = await ctx.post('/api/auth/login', { headers: { 'x-csrf-token': '1' }, data: { username, password } });
    if (!res.ok()) throw new Error(`API login as ${username} failed: ${res.status()} ${await res.text()}`);
    return new Api(ctx, (await res.json()).csrfToken);
  }

  private static adminSession: Promise<Api> | undefined;

  /** One administrator API session per test worker (sign-ins are rate limited). */
  static admin(): Promise<Api> {
    Api.adminSession ??= Api.login(
      process.env.E2E_ADMIN_USERNAME ?? 'admin',
      process.env.E2E_ADMIN_PASSWORD ?? 'correct horse battery staple',
    );
    return Api.adminSession;
  }

  async patch<T>(url: string, data: unknown): Promise<T> {
    const res = await this.ctx.patch(url, { headers: { 'x-csrf-token': this.csrf }, data });
    if (!res.ok()) throw new Error(`PATCH ${url}: ${res.status()} ${await res.text()}`);
    return res.json();
  }

  async post<T>(url: string, data: unknown): Promise<T> {
    const res = await this.ctx.post(url, { headers: { 'x-csrf-token': this.csrf }, data });
    if (!res.ok()) throw new Error(`POST ${url}: ${res.status()} ${await res.text()}`);
    return res.json();
  }
}

export interface TestUser {
  username: string;
  displayName: string;
  id: string;
}

/** Create a fresh local user (no forced password change). */
export async function createUser(admin: Api, prefix = 'e2e'): Promise<TestUser> {
  const username = `${prefix}_${randomBytes(4).toString('hex')}`;
  const displayName = `${prefix[0]!.toUpperCase()}${prefix.slice(1)} ${username.slice(-4)}`;
  const u = await admin.post<{ id: string }>('/api/admin/users', {
    username,
    displayName,
    password: PASSWORD,
    mustChangePassword: false,
  });
  return { username, displayName, id: u.id };
}

export async function signIn(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** A signed-in page in its own browser context (separate cookies). */
export async function userPage(browser: Browser, username: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await ctx.newPage();
  await signIn(page, username);
  return page;
}

export async function createProject(api: Api, name: string): Promise<{ id: string }> {
  return api.post('/api/projects', { name, template: 'article' });
}

export async function openProject(page: Page, id: string): Promise<void> {
  await page.goto(`/project/${id}`);
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** Put the cursor at the end of the template's placeholder line and type. */
export async function typeAfterPlaceholder(page: Page, text: string): Promise<void> {
  await page.locator('.cm-line', { hasText: 'Start writing here.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 10 });
}
