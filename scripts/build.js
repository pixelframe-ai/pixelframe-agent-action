#!/usr/bin/env node

const { copyFileSync, mkdirSync } = require('fs');
const { resolve } = require('path');

const root = process.cwd();
const source = resolve(root, 'src/index.js');
const destinationDir = resolve(root, 'dist');
const destination = resolve(destinationDir, 'index.js');

mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);

console.log(`Built ${destination}`);

