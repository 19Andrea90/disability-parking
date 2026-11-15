// Copia in www/vendor le librerie che l'app carica (niente bundler: l'app è HTML/JS semplice).
import { cpSync, mkdirSync } from 'node:fs';
const out = new URL('../www/vendor/', import.meta.url); mkdirSync(out, { recursive: true });
const cp = (from, to) => cpSync(new URL('../node_modules/' + from, import.meta.url), new URL(to, out));
cp('maplibre-gl/dist/maplibre-gl.js', 'maplibre-gl.js');
cp('maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css');
cp('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2', 'atkinson-400.woff2');
cp('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2', 'atkinson-700.woff2');
console.log('vendor pronto');
