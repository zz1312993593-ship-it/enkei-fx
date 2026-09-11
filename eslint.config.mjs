import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    '.vinext/**',
    'out/**',
    'build/**',
    'tests/.build/**',
    '**/.venv/**',
    'decision-service/vendor/**',
    'next-env.d.ts',
    '圆衡Enkei-v1.3.0-正式版-整包/**',
  ]),
]);

export default eslintConfig;
