const fs = require('fs');
const path = require('path');

function ensureDir(p){ try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function copyFile(src, dst){ try { fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o755); } catch (e) { console.warn('copy failed', src, '->', dst, e.message); }
}

const projectRoot = process.cwd();
const srcDir = path.join(projectRoot, 'public', 'bin', 'linux-x64');
const dstDir = path.join(projectRoot, 'app', 'api', 'render', 'bin', 'linux-x64');

try {
  if (fs.existsSync(srcDir)){
    ensureDir(dstDir);
    const items = fs.readdirSync(srcDir);
    for (const f of items){
      const s = path.join(srcDir, f);
      const d = path.join(dstDir, f);
      copyFile(s, d);
    }
    console.log('[copy-bins] Copied vendored binaries to app/api/render/bin/linux-x64');
  } else {
    console.log('[copy-bins] Source vendor dir missing:', srcDir);
  }
} catch (e){
  console.warn('[copy-bins] error:', e && e.message);
}

