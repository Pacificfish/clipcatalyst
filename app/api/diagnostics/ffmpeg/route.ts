import { NextResponse } from 'next/server'
import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function check(cmdPath: string){
  try {
    const exists = existsSync(cmdPath)
    if (!exists) return { path: cmdPath, exists: false, runnable: false }
    const r = spawnSync(cmdPath, ['-version'], { stdio: 'ignore' })
    return { path: cmdPath, exists: true, runnable: !r.error }
  } catch (e: any){
    return { path: cmdPath, exists: false, runnable: false, error: String(e?.message || e) }
  }
}

export async function GET(){
  const cwd = process.cwd()
  const node = process.version

  const envFFMPEG = process.env.FFMPEG_PATH || ''
  const envFFPROBE = process.env.FFPROBE_PATH || ''

  const candidatesFfmpeg = [
    envFFMPEG,
    tryRequire('@ffmpeg-installer/ffmpeg'),
    tryRequire('ffmpeg-static'),
    '/var/task/node_modules/@ffmpeg-installer/linux-x64/ffmpeg',
    '/var/task/node_modules/ffmpeg-static/ffmpeg',
    path.join(cwd, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.join(cwd, '.next', 'server', 'app', 'api', 'render', 'ffmpeg'),
    '/var/task/.next/server/app/api/render/ffmpeg'
  ].filter(Boolean) as string[]

  const candidatesProbe = [
    envFFPROBE,
    tryRequire('@ffprobe-installer/ffprobe'),
    getProp(tryRequire('ffprobe-static'), 'path'),
    '/var/task/node_modules/@ffprobe-installer/linux-x64/ffprobe',
    path.join(cwd, 'node_modules', '@ffprobe-installer', 'linux-x64', 'ffprobe'),
    path.join(cwd, 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe'),
    '/var/task/node_modules/ffprobe-static/bin/linux/x64/ffprobe',
    path.join(cwd, '.next', 'server', 'app', 'api', 'render', 'ffprobe'),
    '/var/task/.next/server/app/api/render/ffprobe'
  ].filter(Boolean) as string[]

  const renderDir = path.join(cwd, '.next', 'server', 'app', 'api', 'render')
  let renderDirList: string[] | string = []
  try { renderDirList = readdirSync(renderDir) } catch (e: any) { renderDirList = String(e?.message || e) }

  return NextResponse.json({
    cwd, node,
    env: {
      FFMPEG_PATH: envFFMPEG,
      FFPROBE_PATH: envFFPROBE,
    },
    ffmpeg: candidatesFfmpeg.map(check),
    ffprobe: candidatesProbe.map(check),
    tracedDir: renderDir,
    tracedDirList: renderDirList,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

function tryRequire(mod: string): string | undefined {
  try {
    const m = (eval('require'))(mod)
    if (typeof m === 'string') return m
    if (m && typeof m.path === 'string') return m.path
    return undefined
  } catch { return undefined }
}

function getProp(val: any, key: string){
  try { return val?.[key] } catch { return undefined }
}
