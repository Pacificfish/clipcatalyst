import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegLib from 'fluent-ffmpeg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const app = express();
app.use(express.json({ limit: '20mb' }));

ffmpegLib.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');
ffmpegLib.setFfprobePath(process.env.FFPROBE_PATH || '/usr/bin/ffprobe');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

app.get('/healthz', (_, res) => res.send('ok'));

app.post('/render', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required){
      return res.status(403).json({ error: 'forbidden' })
    }

    const { mp3_url, csv_url, bg_urls = [], preset = 'tiktok_v1', title } = req.body || {};
    if (!mp3_url || !csv_url) return res.status(400).json({ error: 'mp3_url and csv_url are required' });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const audioPath = path.join(tmp, `${crypto.randomUUID()}.mp3`);
    const csvPath = path.join(tmp, `${crypto.randomUUID()}.csv`);
    const outPath = path.join(tmp, `${crypto.randomUUID()}.mp4`);

    const [mp3, csv] = await Promise.all([fetch(mp3_url), fetch(csv_url)]);
    if (!mp3.ok || !csv.ok) return res.status(400).json({ error: 'Failed to fetch inputs' });
    fs.writeFileSync(audioPath, Buffer.from(await mp3.arrayBuffer()));
    fs.writeFileSync(csvPath, Buffer.from(await csv.arrayBuffer()));

    const cmd = ffmpegLib();
    cmd.input(`color=c=#0b0b0f:s=1080x1920:r=30:d=15`).inputFormat('lavfi');
    cmd.input(audioPath);
    cmd.outputOptions([
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest'
    ]);

    await new Promise((resolve, reject) => {
      cmd.on('start', c => console.log('ffmpeg:', c));
      cmd.on('stderr', l => console.error(l));
      cmd.on('end', resolve);
      cmd.on('error', reject);
      cmd.save(outPath);
    });

    const hasS3 = Boolean(process.env.S3_BUCKET && process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI))

    if (hasS3){
      const bucket = process.env.S3_BUCKET;
      const key = `renders/${Date.now()}-${path.basename(outPath)}`;
      const body = fs.readFileSync(outPath);
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4', ACL: 'public-read'
      }));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      const url = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
      res.json({ url, key });
    } else {
      // Stream the MP4 directly if S3 is not configured
      const stat = fs.statSync(outPath)
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store'
      })
      const rs = fs.createReadStream(outPath)
      rs.pipe(res)
      rs.on('close', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || 'Render failed' });
  }
});

app.listen(8080, () => console.log('worker listening on :8080'));

