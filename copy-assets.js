const fs = require('fs');
const path = require('path');

const distDir = path.join('C:\\\\Users\\\\ROM\\\\Work\\\\quest-lite\\\\dist');
const pubDir = path.join('C:\\\\Users\\\\ROM\\\\Work\\\\quest-lite\\\\public');

// Delete and recreate public folder
try { fs.rmSync(pubDir, { recursive: true, force: true }); } catch(e) {}
fs.mkdirSync(pubDir, { recursive: true });

// Copy index.html and favicon
fs.copyFileSync(path.join(distDir, 'index.html'), path.join(pubDir, 'index.html'));
fs.copyFileSync(path.join(distDir, 'favicon.svg'), path.join(pubDir, 'favicon.svg'));

// Copy entire assets directory
const assetsDir = path.join(distDir, 'assets');
const pubAssetsDir = path.join(pubDir, 'assets');
fs.mkdirSync(pubAssetsDir, { recursive: true });

const assetFiles = fs.readdirSync(assetsDir);
assetFiles.forEach(file => {
  fs.copyFileSync(path.join(assetsDir, file), path.join(pubAssetsDir, file));
});

console.log('All files copied from dist to public');