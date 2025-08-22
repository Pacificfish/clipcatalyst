// Simple renderer: compose a 1080x1920 (9:16) canvas, burn-in captions, add voiceover audio.
// Input: --audio <path or URL> --captions <csv path or URL> --out <path>
// CSV format: start,end,text (milliseconds)

const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
const ffprobePath = require('ffprobe-static')?.path;
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { bgs: [], noSubs: false };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const v = args[i+1];
    if (k === '--audio') { out.audio = v; i++; continue; }
    if (k === '--captions') { out.captions = v; i++; continue; }
    if (k === '--out') { out.out = v; i++; continue; }
    if (k === '--bg') { if (v) out.bgs.push(v); i++; continue; }
    if (k === '--music') { out.music = v; i++; continue; }
    if (k === '--preset') { out.preset = v; i++; continue; }
    if (k === '--title') { out.title = v; i++; continue; }
    if (k === '--logo') { out.logo = v; i++; continue; }
    if (k === '--no-subs') { out.noSubs = true; continue; }
  }
  return out;
}

function parseCsv(line) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { parts.push(cur); cur=''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function hmsToMs(t) {
  // Accept mm:ss or hh:mm:ss[.ms]
  const seg = String(t).trim();
  const parts = seg.split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return null;
  let h = 0, m = 0; let s = 0;
  if (parts.length === 2) { [m, s] = parts; }
  else if (parts.length === 3) { [h, m, s] = parts; }
  else return null;
  return ((h*60 + m)*60 + s) * 1000;
}

function csvToEvents(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  const body = header.includes('time') || header.includes('start') || header.includes('text')
    ? lines.slice(1) : lines;

  const rows = body.map(parseCsv).filter((r) => r.length >= 2);

  // Support two formats:
  // 1) start,end,text (ms)
  // 2) time,text (hh:mm or mm:ss), infer end from next start or +1500ms
  const events = [];
  if (header.includes('start') && header.includes('end')) {
    for (const r of rows) {
      const start = Number(r[0]) || 0;
      const end = Number(r[1]) || Math.max(500, start + 1500);
      const text = (r.slice(2).join(',') || '').trim();
      events.push({ start, end, text });
    }
    return events;
  }
  // time,text mode
  const times = rows.map((r) => hmsToMs(r[0]));
  for (let i = 0; i < rows.length; i++) {
    const t = times[i];
    if (t == null) continue;
    const next = times[i+1];
    const end = next != null ? Math.max(t+500, next) : t + 1500;
    const text = (rows[i].slice(1).join(',') || '').trim();
    events.push({ start: t, end, text });
  }
  return events;
}

function msToAssTime(ms) {
  const h = Math.floor(ms/3600000).toString().padStart(1,'0');
  const m = Math.floor((ms%3600000)/60000).toString().padStart(2,'0');
  const s = Math.floor((ms%60000)/1000).toString().padStart(2,'0');
  const cs = Math.floor((ms%1000)/10).toString().padStart(2,'0'); // centiseconds
  return `${h}:${m}:${s}.${cs}`;
}

function buildAss(events, preset) {
  const isTikTok = preset === 'tiktok_v1';
  const header = `[
Script Info]
; TikTok-style bold captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok, Inter, ${isTikTok ? 84 : 72}, \u0026H00FFFFFF, \u0026H000000FF, \u0026H00101010, \u0026H7F000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, ${isTikTok ? 8 : 6}, ${isTikTok ? 2 : 0}, 2, 80, 80, ${isTikTok ? 140 : 160}, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = events.map((e) => {
    const start = msToAssTime(e.start);
    const end = msToAssTime(Math.max(e.end, e.start+500));
    // word highlight effect (simple): wrap words in \N for gentle line breaks
    const txt = e.text
      .replace(/\s+/g,' ')
      .split(' ')
      .map(w => `{\\bord6}\\b1${w}\\b0`)
      .join(' ');
    return `Dialogue: 0,${start},${end},TikTok,,0,0,0,,{\\an2}${txt}`;
  }).join('\n');
  return header + lines + '\n';
}

async function getAudioDurationMs(audioPath) {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(audioPath, (err, data) => {
        if (err) return resolve(0);
        const s = data?.format?.duration || 0;
        resolve(Math.max(0, Math.floor(s * 1000)));
      });
    } catch {
      resolve(0);
    }
  });
}

async function main() {
  const { audio, captions, out, bgs, music, preset, title, logo, noSubs } = parseArgs();
  if (!audio || !captions || !out) {
    console.error('Usage: node scripts/render.js --audio <file|url> --captions <csv> --out <mp4> [--bg <image|video>]');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const assPath = path.join(tmp, 'subs.ass');

  // Load captions CSV
  const csvText = fs.readFileSync(captions, 'utf8');
  const events = csvToEvents(csvText);
  const ass = buildAss(events, preset);
  fs.writeFileSync(assPath, ass, 'utf8');

  // Build ffmpeg command
  const cmd = ffmpeg();
  let videoInput;
  let totalSec = 0;
  if (bgs && bgs.length) {
    // add each bg as input
    for (const bg of bgs) cmd.input(bg);
    videoInput = '[vout]'; // will be produced by concat/xfade graph
  } else {
    const durMs = await getAudioDurationMs(audio);
    const totalMs = Math.max(durMs, (events.at(-1)?.end || 5000));
    totalSec = Math.max(1, Math.ceil(totalMs / 1000));
    // generate a solid background color (dark) for the computed duration
    cmd.input(`color=c=#0b0b0f:s=1080x1920:r=30:d=${totalSec}`).inputFormat('lavfi');
    videoInput = '[0:v]';
  }
  cmd.input(audio);
  if (music) { cmd.input(music); }
  const haveLogo = Boolean(logo);
  // Do not add logo as a raw input to avoid stream index confusion; we'll use movie= filter instead

  const chains = [];
  let lastLabel = null;
  const bgCount = Array.isArray(bgs) ? bgs.length : 0;
  if (bgs && bgs.length) {
    // Build per-input processing to 1080x1920 and apply subtle zoom
    const labels = bgs.map((_, i) => `bg${i}`);
    const processed = bgs.map((_, i) => {
      const label = labels[i];
      const src = `${i}:v`;
      const outLabel = `${label}p`;
      chains.push({
        filter: `[${src}]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,fps=30,format=yuv420p[${outLabel}]`,
        outputs: [outLabel]
      });
      return outLabel;
    });

    // Determine audio duration for totalSec if not set (will be set below for solid color path)
    if (!totalSec) {
      const durMs = await getAudioDurationMs(audio);
      totalSec = Math.max(1, Math.ceil(Math.max(durMs, 5000) / 1000));
    }

    // Compute per-clip segment duration with overlap for crossfades
    const N = processed.length;
    const overlap = 0.6; // seconds crossfade
    const seg = Math.max(1.5, (totalSec + (N-1)*overlap) / N);

    // Trim each processed clip to seg seconds
    const trimmed = processed.map((lab, i) => {
      const out = `${lab}t`;
      chains.push({ filter: `[${lab}]trim=duration=${seg},setpts=PTS-STARTPTS[${out}]`, outputs: [out] });
      return out;
    });

    // Concatenate clips without crossfade for stability
    if (trimmed.length > 0) {
      const concatOut = 'vcat';
      const inputs = trimmed.map(lab => `[${lab}]`).join('');
      chains.push({ filter: `${inputs}concat=n=${trimmed.length}:v=1:a=0[${concatOut}]`, outputs: [concatOut] });
      lastLabel = concatOut;
    }
  }

  // Filters: scale/pad or use composed b-roll, ASS subtitles, progress bar
  const assFileEsc = assPath.replace(/:/g,'\\:').replace(/'/g,"\\'");
  const progress = `drawbox=x=0:y=24:w='(1080*t)/${totalSec || 1}':h=${preset==='tiktok_v1'?12:8}:color=white@0.9:t=fill`;
  const baseLabel = lastLabel ? `[${lastLabel}]` : `${videoInput}`;
  const finalLabel = 'v';
  // base grading/vignette
  const grade = preset==='tiktok_v1' ? `eq=contrast=1.06:brightness=0.02:saturation=1.15,vignette=PI/8:0.5` : `null`;
  // title overlay for first 1.5s
  const titleDraw = (preset==='tiktok_v1' && title) ? `,drawbox=x=60:y=120:w=960:h=200:color=black@0.35:t=fill:enable='lt(t,1.5)',drawtext=text='${String(title).replace(/:/g,"\\:").replace(/'/g,"\\'")}':fontcolor=white:fontsize=72:line_spacing=10:x=(w-text_w)/2:y=150:enable='lt(t,1.5)'` : '';
  // optional logo overlay via movie filter to avoid input index fragility
  const logoFilter = haveLogo ? `;movie='${String(logo).replace(/:/g, "\\:").replace(/'/g, "\\'")}',scale=200:-1[wm];[${finalLabel}][wm]overlay=W-w-40:H-h-40:enable='gte(t,0)'[${finalLabel}]` : '';
  const subsPart = noSubs ? '' : `,ass='${assFileEsc}'`;
  chains.push({ filter: `${baseLabel}pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,${grade}${subsPart},${progress}${titleDraw}[${finalLabel}]${logoFilter}`, outputs: [finalLabel] });

  // Integrate audio mixing into the same filter graph to avoid multiple -filter_complex
  const audioIndex = bgCount ? bgCount : 1; // bg videos occupy [0..bgCount-1], else color is [0], audio is next
  const musicIndex = music ? (audioIndex + 1) : null;
  if (musicIndex != null) {
    chains.push({ filter: `[${audioIndex}:a]volume=1.0[a1]` });
    chains.push({ filter: `[${musicIndex}:a]volume=0.18[a2]` });
    chains.push({ filter: `[a1][a2]amix=inputs=2:duration=shortest[aout]`, outputs: ['aout'] });
  }

  const ffChains = chains.map((c) => c.filter);
  cmd.complexFilter(ffChains);

  cmd.outputOptions([
    '-map', '[v]',
    ...(music ? ['-map', '[aout]'] : ['-map', `${audioIndex}:a`]),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-threads', '1',
    '-shortest'
  ]);

  cmd.on('start', (c) => console.log('ffmpeg:', c));
  cmd.on('progress', (p) => process.stdout.write(`progress ${Math.round(p.percent || 0)}%\r`));
  cmd.on('stderr', (line) => console.error(line));
  cmd.on('end', () => {
    console.log('\nDone:', out);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  cmd.on('error', (err) => {
    console.error('ffmpeg error:', err.message);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  });

  cmd.save(out);
}

main().catch(err => { console.error(err); process.exit(1); });

