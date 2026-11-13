'use strict';
/**
 * Fetches 7-Zip's own Linux build for the AppImage: the static 7zzs and its
 * licence, into vendor/7zip/ (package.json's linux extraResources ships it as
 * resources/7zip/). Pinned by version and sha256; a mismatch stops the build.
 * From 7-Zip's GitHub releases. Run before `electron-builder --linux`.
 *
 *   node scripts/fetch-7zip.js
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execFileSync } = require('child_process');

const VERSION = '26.05';
const SOURCE  = `https://github.com/ip7z/7zip/releases/download/${VERSION}/7z${VERSION.replace('.', '')}-linux-x64.tar.xz`;
const SHA256  = '22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e';
const OUT     = path.join(__dirname, '..', 'vendor', '7zip');

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'y4bo-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const have = path.join(OUT, 'VERSION');
  if (fs.existsSync(path.join(OUT, '7zzs')) && fs.existsSync(have) && fs.readFileSync(have, 'utf8').trim() === VERSION) {
    console.log(`7-Zip ${VERSION} already in ${OUT}`);
    return;
  }
  const body = await get(SOURCE);
  const sum = crypto.createHash('sha256').update(body).digest('hex');
  if (sum !== SHA256) throw new Error(`7-Zip ${VERSION}: sha256 ${sum}, expected ${SHA256}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tarball = path.join(OUT, 'download.tar.xz');
  fs.writeFileSync(tarball, body);
  execFileSync('tar', ['-xJf', tarball, '-C', OUT, '7zzs', 'License.txt']);
  fs.rmSync(tarball);
  fs.chmodSync(path.join(OUT, '7zzs'), 0o755);
  fs.writeFileSync(path.join(OUT, 'VERSION'), VERSION + '\n');
  console.log(`7-Zip ${VERSION} in ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
