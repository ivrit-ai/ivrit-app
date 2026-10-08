// Builds whisper-gpu (a separate project, ../whisper-gpu by default) into
// web/lab/whisper/, for the on-device transcription test at app.ivrit.ai/lab.
// A plain object, so it needs nothing from this repo's node_modules; Vite runs
// from the whisper-gpu checkout. Used by scripts/build-lab.sh.
import { resolve } from "node:path";

const source = resolve(process.env.WHISPER_GPU_DIR);
const out = resolve(process.env.LAB_OUT_DIR);

export default {
  root: resolve(source, "demo"),
  base: "./",
  build: {
    outDir: out,
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(source, "demo/index.html"),
        bench: resolve(source, "demo/bench.html"),
        run: resolve(source, "demo/run.html"),
      },
    },
  },
};
