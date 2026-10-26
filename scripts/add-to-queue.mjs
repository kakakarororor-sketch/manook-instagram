#!/usr/bin/env node
// Local helper: convert a post folder (NN.png + caption.md) into queue/<datetime>_<slug>/ (NN.jpg + caption.txt).
// Usage: node scripts/add-to-queue.mjs <post-folder> <YYYY-MM-DD_HHMM (JST)> <ascii-slug>
// Converter: ImageMagick ("magick") if installed, otherwise PowerShell System.Drawing on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFolderName, extractCaptionFromMarkdown, loadPost } from './lib.mjs';

const [src, when, slug] = process.argv.slice(2);
if (!src || !when || !slug) { console.error('Usage: node scripts/add-to-queue.mjs <post-folder> <YYYY-MM-DD_HHMM> <slug>'); process.exit(1); }
const name = `${when}_${slug}`;
if (!parseFolderName(name)) { console.error(`Invalid folder name "${name}". Use YYYY-MM-DD_HHMM (JST) and an ASCII slug.`); process.exit(1); }

const pngs = fs.readdirSync(src).filter((f) => /\.png$/i.test(f)).sort();
if (pngs.length < 1 || pngs.length > 10) { console.error(`Expected 1-10 PNG files in ${src}, found ${pngs.length}`); process.exit(1); }
const mdPath = path.join(src, 'caption.md');
const txtPath = path.join(src, 'caption.txt');
let caption;
if (fs.existsSync(txtPath)) caption = fs.readFileSync(txtPath, 'utf8');
else if (fs.existsSync(mdPath)) caption = extractCaptionFromMarkdown(fs.readFileSync(mdPath, 'utf8'));
else { console.error('caption.md / caption.txt not found'); process.exit(1); }

const dest = path.join('queue', name);
if (fs.existsSync(dest)) { console.error(`${dest} already exists`); process.exit(1); }
fs.mkdirSync(dest, { recursive: true });

function hasMagick() { try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const magick = hasMagick();
const ps = (s) => s.replaceAll("'", "''");

for (const f of pngs) {
  const out = path.resolve(dest, f.replace(/\.png$/i, '.jpg'));
  const inp = path.resolve(src, f);
  if (magick) {
    execFileSync('magick', [inp, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-colorspace', 'sRGB', '-quality', '92', out]);
  } else if (process.platform === 'win32') {
    const cmd = `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${ps(inp)}'); ` +
      `$b=New-Object System.Drawing.Bitmap($i.Width,$i.Height,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb); ` +
      `$g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $g.DrawImage($i,0,0,$i.Width,$i.Height); ` +
      `$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}; ` +
      `$p=New-Object System.Drawing.Imaging.EncoderParameters(1); $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]92); ` +
      `$b.Save('${ps(out)}',$enc,$p); $g.Dispose(); $b.Dispose(); $i.Dispose()`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' });
  } else {
    console.error('No converter found. Install ImageMagick (magick).'); process.exit(1);
  }
  console.log(`converted ${f} -> ${path.relative('.', out)}`);
}
fs.writeFileSync(path.join(dest, 'caption.txt'), caption.replace(/\r\n/g, '\n').trim() + '\n');

const { problems } = loadPost(dest);
if (problems.length) { console.error(`Created ${dest} but validation failed:\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log(`OK: ${dest}\nNext: git add queue && git commit -m "queue: ${name}" && git push`);
