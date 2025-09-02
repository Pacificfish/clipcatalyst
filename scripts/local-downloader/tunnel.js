import localtunnel from 'localtunnel'
import fs from 'fs'
import path from 'path'

const port = Number(process.env.PORT || 3009)
const file = path.join(process.cwd(), '.tunnel-url')

async function main(){
  const tunnel = await localtunnel({ port })
  fs.writeFileSync(file, tunnel.url, 'utf8')
  console.log('Localtunnel URL:', tunnel.url)
  tunnel.on('close', () => { /* keep alive until process exits */ })
}

main().catch((e)=>{ console.error(e?.message || e); process.exit(1) })

