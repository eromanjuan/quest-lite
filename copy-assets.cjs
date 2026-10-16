const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const pubDir = path.join(__dirname, 'public');

fs.mkdirSync(pubDir, { recursive: true });

const files = fs.readdirSync(distDir, { withFileTypes: true });
for (const file of files) {
  const src = path.join(distDir, file.name);
  const dest = path.join(pubDir, file.name);
  if (file.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    // Recurse into subdirectory
    const subFiles = fs.readdirSync(src, { withFileTypes: true });
    for (const subFile of subFiles) {
      const subSrc = path.join(src, subFile.name);
      const subDest = path.join(dest, subFile.name);
      fs.copyFileSync(subSrc, subDest);
    }
  } else {
    fs.copyFileSync(src, dest);
    console.log('Copied:', file.name);
  }
}
console.log('Done copying dist to public');