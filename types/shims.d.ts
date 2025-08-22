declare module 'fluent-ffmpeg' {
  const ffmpeg: any;
  export default ffmpeg;
}

declare module 'ffmpeg-static' {
  const pathToFfmpeg: string | undefined;
  export default pathToFfmpeg;
}

declare module 'ffprobe-static' {
  const ffprobe: { path?: string };
  export default ffprobe;
  export const path: string | undefined;
}

