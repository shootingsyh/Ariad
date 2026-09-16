import fs from 'node:fs';
import path from 'node:path';

export class FileEventStore {
  constructor(file) { this.file = file; }
  append(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('event with type is required');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() }) + '\n', 'utf8');
  }
  readAll() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
}
