/**
 * Helpers shared by the screenshot and benchmark scripts: starts the project's
 * Vite server on a free port and a headless Chromium with WebGL.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Session {
  browser: Browser;
  page: Page;
  baseUrl: string;
  /** WebGL renderer string (real GPU or SwiftShader). */
  gpu: string;
  close(): Promise<void>;
}

interface VicemapApi {
  settled(): boolean;
  gpu(): string;
}

async function launch(software: boolean): Promise<Browser> {
  const args = software
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
  // The "chromium" channel uses the new headless mode, which can use the GPU.
  return chromium.launch({ channel: 'chromium', headless: true, args });
}

export async function openSession(opts: { width?: number; height?: number; software?: boolean; scale?: number } = {}): Promise<Session> {
  const server: ViteDevServer = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5183, strictPort: false, open: false } });
  await server.listen();
  const address = server.httpServer!.address();
  const port = typeof address === 'object' && address ? address.port : 5183;
  const baseUrl = `http://localhost:${port}/`;

  let browser = await launch(!!opts.software);
  let page = await browser.newPage({ viewport: { width: opts.width ?? 1600, height: opts.height ?? 900 }, deviceScaleFactor: opts.scale ?? 1 });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [page exception] ${e.message}`));

  await page.goto(`${baseUrl}?ui=0&intro=0`);
  let gpu = '';
  try {
    await page.waitForFunction(() => !!(window as unknown as { vicemap?: VicemapApi }).vicemap, null, { timeout: 60000 });
    gpu = await page.evaluate(() => (window as unknown as { vicemap: VicemapApi }).vicemap.gpu());
  } catch {
    if (opts.software) throw new Error('The viewer does not start, even with software rendering.');
    console.log('  The viewer does not start on the GPU (hardware WebGL unavailable, or assets missing): retrying with SwiftShader.');
    await browser.close();
    browser = await launch(true);
    page = await browser.newPage({ viewport: { width: opts.width ?? 1600, height: opts.height ?? 900 }, deviceScaleFactor: opts.scale ?? 1 });
    page.on('pageerror', (e) => console.log(`  [page exception] ${e.message}`));
    await page.goto(`${baseUrl}?ui=0&intro=0`);
    await page.waitForFunction(() => !!(window as unknown as { vicemap?: VicemapApi }).vicemap, null, { timeout: 120000 });
    gpu = await page.evaluate(() => (window as unknown as { vicemap: VicemapApi }).vicemap.gpu());
  }
  return {
    browser,
    page,
    baseUrl,
    gpu,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/** Opens a view and waits until everything it shows is loaded. */
export async function gotoView(s: Session, query: string, timeoutMs = 240000): Promise<void> {
  await s.page.goto(`${s.baseUrl}?${query}&intro=0`);
  await s.page.waitForFunction(
    () => {
      const v = (window as unknown as { vicemap?: VicemapApi }).vicemap;
      return !!v && v.settled();
    },
    null,
    { timeout: timeoutMs, polling: 250 },
  );
  // The viewer retries a failed tile; if the error persists once the view is stable, report it.
  const error = await s.page.evaluate(() => {
    const v = (window as unknown as { vicemap: { world: { lastError: string | null; tiles: { state: string }[] } } }).vicemap;
    return v.world.tiles.some((t) => t.state === 'failed') ? v.world.lastError : null;
  });
  if (error) throw new Error(`incomplete load: ${error}`);
}
