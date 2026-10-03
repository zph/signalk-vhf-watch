import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtimeDist = path.join(root, 'node_modules/onnxruntime-web/dist')
const assets = path.join(root, 'public/client-transcription-assets')
await rm(assets, { recursive: true, force: true })
await mkdir(assets, { recursive: true })
await cp(path.join(root, 'node_modules/@huggingface/transformers/LICENSE'), path.join(assets, 'transformers-LICENSE.txt'))
await cp(path.join(root, 'public/client-transcription-runtime-licenses.txt'), path.join(assets, 'onnxruntime-web-LICENSE.txt'))
for (const filename of await readdir(runtimeDist)) {
  if (filename === 'ort-wasm-simd-threaded.jsep.wasm' || filename === 'ort-wasm-simd-threaded.jsep.mjs') {
    await cp(path.join(runtimeDist, filename), path.join(assets, filename))
  }
}
await build({
  entryPoints: [path.join(root, 'public/client-transcription.worker.js')],
  outfile: path.join(root, 'public/client-transcription.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  logLevel: 'info'
})
