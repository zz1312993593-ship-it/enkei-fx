import { expect, test } from '@playwright/test';

// 批B：核心路径冒烟。运行前提：`npx playwright install chromium`。
// 这些断言同时覆盖"后端服务在线"与"纯前端降级空态"两种环境。

test.describe('円衡 FX 工作台冒烟', () => {
  // 经典亮色模式下测试应用页面；控制台模式另行手工/专项验证。
  test.beforeEach(async ({ page }, testInfo) => {
    if (!testInfo.title.includes('全屏控制台')) {
      await page.addInitScript(() => window.localStorage.setItem('enkei-theme-mode', 'classic'));
    }
  });

  test('首次启动引导：选择语言与时区后进入，并长期记忆', async ({ page }) => {
    await page.goto('/');
    // addInitScript runs again on every reload, so using it to remove this key
    // would manufacture a false persistence failure. Clear once, then reload
    // into the actual first-run state.
    await page.evaluate(() => window.localStorage.removeItem('enkei-welcome-done'));
    await page.reload();
    const dialog = page.getByRole('dialog', { name: /初始设置|初期設定|First-run setup/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'English' }).click();
    await dialog.getByRole('button', { name: /Enter the workbench/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // 长期记忆：刷新后不再出现
    await page.reload();
    await expect(page.getByRole('dialog', { name: /First-run setup/ })).toBeHidden();
  });

  test('五组导航：每组可达，组内子导航切换', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('enkei-welcome-done', 'done'));
    await page.goto('/');
    // 五个一级组都存在（手风琴：点组名展开子项）
    const groups = ['市场', '研究', 'Demo', '模型与连接', '设置'];
    for (const label of groups) {
      await expect(page.locator('.nav-group-toggle', { hasText: label })).toBeVisible();
    }
    // 研究组 → 回测页
    await page.locator('.nav-group-toggle', { hasText: '研究' }).click();
    await page.locator('.nav-tree .nav-item', { hasText: '回测' }).click();
    await expect(page.locator('.page-heading h2')).toHaveText('策略回测');
    // 组内子导航切换 → 策略筛选
    await page.locator('.subnav-tab', { hasText: '策略筛选' }).click();
    await expect(page.locator('.page-heading h2')).toHaveText('策略筛选');
    // 设置组 → 使用说明
    await page.locator('.nav-group-toggle', { hasText: '设置' }).click();
    await page.locator('.nav-tree .nav-item', { hasText: '使用说明' }).click();
    await expect(page.locator('.page-heading h2')).toHaveText('使用说明');
    await expect(page.locator('.manual-section')).toHaveCount(7);
  });

  test('语言切换持久化并驱动说明文档', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('enkei-welcome-done', 'done'));
    await page.goto('/');
    await page.locator('.language-select select').selectOption('ja');
    await page.locator('.nav-tree .nav-item', { hasText: '概要' }).click();
    await expect(page.locator('.page-heading h2')).toHaveText('マーケット概要');
    await page.reload();
    await expect(page.locator('.language-select select')).toHaveValue('ja');
  });

  test('回测页蒙特卡洛区块存在；运营中心错误知识库与诊断包存在', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('enkei-welcome-done', 'done'));
    await page.goto('/');
    await page.locator('.nav-group-toggle', { hasText: '研究' }).click();
    await page.locator('.nav-tree .nav-item', { hasText: '回测' }).click();
    await expect(page.locator('summary', { hasText: '蒙特卡洛重抽样' })).toBeVisible();
    // 错误知识库（27 条 E-code）
    await page.locator('.nav-group-toggle', { hasText: '设置' }).click();
    await page.locator('.nav-tree .nav-item', { hasText: '运营中心' }).click();
    await page.getByRole('button', { name: /内置说明|エラーコード|guide/ }).first().click();
    await expect(page.locator('.error-entry')).toHaveCount(27);
    await expect(page.getByRole('button', { name: /一键诊断包/ })).toBeVisible();
  });

  test('Demo 与实盘连接页保持安全边界文案', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('enkei-welcome-done', 'done'));
    await page.goto('/');
    await page.locator('.nav-group-toggle', { hasText: 'Demo' }).click();
    await page.locator('.nav-tree .nav-item', { hasText: '实盘连接' }).click();
    await expect(page.locator('.page-heading h2')).toHaveText('实盘连接（默认锁定）');
  });

  test('窄屏与缩放：经典界面不产生页面级横向溢出', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('enkei-welcome-done', 'done'));
    await page.setViewportSize({ width: 480, height: 760 });
    await page.goto('/');
    await expect(page.locator('.nav-mobile-groups')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.evaluate(() => { document.body.style.zoom = '175%'; });
    const zoomedOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(zoomedOverflow).toBeLessThanOrEqual(1);
  });

  test('全屏控制台：可启动、切换周期并在窄屏安全降级', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('enkei-welcome-done', 'done');
      window.localStorage.setItem('enkei-theme-mode', 'command');
    });
    await page.setViewportSize({ width: 640, height: 800 });
    await page.goto('/');
    await expect(page.locator('.console')).toBeVisible();
    await page.locator('.console-tf-tabs button', { hasText: 'M15' }).click();
    await expect(page.locator('.console-tf-tabs button.active')).toHaveText('M15');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
