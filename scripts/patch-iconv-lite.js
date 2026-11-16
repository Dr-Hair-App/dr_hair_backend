import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.resolve(root, '../node_modules/iconv-lite/package.json');

if (!fs.existsSync(packagePath)) process.exit(0);

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (packageJson.version !== '0.7.3') {
  throw new Error(`Expected iconv-lite 0.7.3, found ${packageJson.version}`);
}

// Workers need the Node stream implementation for Express body-parser. The
// package's browser map replaces it with `false`, which breaks Wrangler's
// Node compatibility bundling at Worker startup.
if (packageJson.browser) {
  delete packageJson.browser;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}
