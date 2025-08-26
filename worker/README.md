# ClipCatalyst Render Worker

Endpoints:

- GET /healthz
- GET /diag
- POST /render
  - Inputs (JSON):
    - mp3_url (string, required): public URL to source audio in MP3
    - csv_url (string, required): public URL to captions CSV (either start,end,text per line or time/text)
    - word_csv_url (string, optional): per-word timings CSV (start,end,text)
    - bg_url/bg_urls (string or array, optional): background video or image URL
    - start_ms, end_ms (number, optional): when set, trims to a sub-clip window
    - preset (string, optional): 'tiktok_v1' (1080x1920 H.264/AAC)
  - Output: 200
    - If S3 configured (S3_BUCKET + AWS_REGION + credentials): { url, key, start_ms?, end_ms?, seconds }
    - Else: streams MP4 bytes
  - Auth: set SHARED_SECRET on the worker; caller may authenticate via header `x-shared-secret` or signed query `?t=HMAC_SHA256(ts)&ts=UNIX_EPOCH`.

- POST /render_batch
  - Batch-render multiple TikTok-ready clips in one request.
  - Inputs (JSON):
    - One of:
      - mp3_url (string): audio URL to reuse for all clips
      - youtube_url (string): a YouTube watch URL to download best audio from
    - Captions (any of):
      - csv_url (string): captions CSV URL for full audio
      - csv_text (string): inline CSV text
      - word_csv_url (string): optional per-word timings CSV URL for improved sync
      - word_csv_text (string): inline per-word timings CSV text
      - If no captions provided, you can still pass segments with `text`; worker will synthesize word-by-word timing across each segment duration.
    - segments: Array<{ start_ms: number; end_ms: number; text?: string; title?: string }>
    - bg_url/bg_urls (optional): background image or video to loop under captions
    - preset: 'tiktok_v1' (default)
  - Output (JSON): { clips: Array<{ url, key, start_ms, end_ms, seconds, title? }> }
  - Requires S3 (S3_BUCKET + AWS_REGION + credentials). Files are uploaded public-read for immediate download.
  - Auth: same as /render.

Notes:
- Outputs are TikTok-ready MP4s (1080x1920, 30fps, H.264 + AAC, yuv420p) with animated word captions at the bottom.
- If per-word timings are provided (word CSV), captions will sync precisely. Otherwise, the worker derives per-word timings by evenly distributing words within each event or segment window.

Environment Variables:
- SHARED_SECRET (recommended)
- S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or IAM role
- ASSEMBLYAI_API_KEY (only needed for /transcribe_assembly)
- FFMPEG_PATH, FFPROBE_PATH (optional; autodetected)

