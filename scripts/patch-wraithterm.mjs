import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Wraith 0.6.1 inherits fractional DOM cell widths. Nearest-neighbour atlas
// sampling at half-pixel origins can duplicate/drop columns in Latin glyphs.
// Keep GPU pixels, CSS size, FitAddon and selection on the same integer grid.
const directory = new URL('../node_modules/wraithterm/', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8'))
if (version !== '0.6.1') throw Error(`Review the terminal pixel-grid patch for wraithterm ${version}`)
const filename = fileURLToPath(new URL('dist/xterm-renderer.js', directory))
let source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n')
const changes = [
  [
    `    get dimensions() {
        return this.fallback.dimensions;
    }`,
    `    pixelDimensions;
    pixelGeometry = '';
    get dimensions() {
        const original = this.fallback.dimensions;
        if (this.fallbackReason())
            return original;
        const dpr = this.core._coreBrowserService.dpr;
        const key = [dpr, this.terminal.cols, this.terminal.rows, original.device.cell.width, original.device.cell.height].join(',');
        if (key !== this.pixelGeometry) {
            const dimensions = structuredClone(original);
            // DOM measurement has small float errors (10.5 can be 10.499992).
            dimensions.device.cell.width = Math.max(1, Math.round(original.device.cell.width + 0.0001));
            dimensions.device.canvas.width = dimensions.device.cell.width * this.terminal.cols;
            dimensions.device.canvas.height = dimensions.device.cell.height * this.terminal.rows;
            dimensions.css.cell.width = dimensions.device.cell.width / dpr;
            dimensions.css.cell.height = dimensions.device.cell.height / dpr;
            dimensions.css.canvas.width = dimensions.device.canvas.width / dpr;
            dimensions.css.canvas.height = dimensions.device.canvas.height / dpr;
            this.pixelDimensions = dimensions;
            this.pixelGeometry = key;
        }
        return this.pixelDimensions;
    }`,
  ],
  [
    `        this.canvas.style.display = gpu ? 'block' : 'none';`,
    `        this.canvas.style.display = gpu ? 'block' : 'none';
        const dimensions = this.dimensions;
        this.core.screenElement.style.width = dimensions.css.canvas.width + 'px';
        this.core.screenElement.style.height = dimensions.css.canvas.height + 'px';`,
  ],
]
let changed = false
for (const [before, after] of changes) {
  if (source.includes(after)) continue
  if (source.split(before).length !== 2) throw Error('Wraith renderer changed; review the pixel-grid patch before building')
  source = source.replace(before, after)
  changed = true
}
if (changed) writeFileSync(filename, source, 'utf8')
console.log(`Wraith terminal pixel-grid patch: ${changed ? 'applied' : 'already applied'}`)
