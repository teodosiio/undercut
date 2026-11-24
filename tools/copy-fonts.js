// Copies the self-hosted Archivo variable font (weight and width axes) into public/fonts.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', '@fontsource-variable', 'archivo');
const target = path.join(root, 'public', 'fonts');

mkdirSync(target, { recursive: true });
for (const file of ['archivo-latin-wdth-normal.woff2', 'archivo-latin-ext-wdth-normal.woff2']) {
  copyFileSync(path.join(source, 'files', file), path.join(target, file));
}
copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'Archivo-OFL.txt'));
