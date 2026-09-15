'use strict';
// Tiny JSON-file store for settings and device profiles. Writes are atomic
// (write to a temp file, then rename) so a crash can't leave a half-written file.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(name) { return path.join(this.dir, `${name}.json`); }

  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this._file(name), 'utf8')); }
    catch { return fallback; }
  }

  write(name, value) {
    const file = this._file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }
}

module.exports = { JsonStore };
