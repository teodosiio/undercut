// Copies the self-hosted variable fonts into public/fonts:
// Bricolage Grotesque (headings), Instrument Sans (text) and JetBrains Mono (prices and data).
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'fonts');
const fonts = {
  'bricolage-grotesque': 'opsz',
  'instrument-sans': 'wght',
  'jetbrains-mono': 'wght',
};

mkdirSync(target, { recursive: true });
for (const file of readdirSync(target)) rmSync(path.join(target, file));

for (const [name, axis] of Object.entries(fonts)) {
  const source = path.join(root, 'node_modules', '@fontsource-variable', name);
  for (const subset of ['latin', 'latin-ext']) {
    const file = `${name}-${subset}-${axis}-normal.woff2`;
    copyFileSync(path.join(source, 'files', file), path.join(target, file));
  }
  copyFileSync(path.join(source, 'LICENSE'), path.join(target, `${name}-OFL.txt`));
}
