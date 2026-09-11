import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

type HostingConfig = { d1?: string; r2?: string };

// `.openai/hosting.json` is installation-specific and intentionally excluded
// from the public repository. Cloud/Sites checkouts may provide it, while
// open-source clones and CI must still compile without a private local file.
const hostingConfigPath = resolve(process.cwd(), '.openai', 'hosting.json');
const hostingConfig: HostingConfig = existsSync(hostingConfigPath)
  ? JSON.parse(readFileSync(hostingConfigPath, 'utf8')) as HostingConfig
  : {};
const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  const localDesktop = process.env.ENKEI_LOCAL_DESKTOP === '1' || !existsSync(hostingConfigPath);
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // The packaged Windows desktop launcher is entirely local and must not wait
  // for Cloudflare/Miniflare network discovery. Cloud hosting builds keep the
  // original Sites + Cloudflare plugin path.
  const cloudPlugins = localDesktop
    ? []
    : [
        sites(),
        (await import('@cloudflare/vite-plugin')).cloudflare({
          viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
          config: localBindingConfig,
        }),
      ];

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      ...cloudPlugins,
    ],
  };
});
