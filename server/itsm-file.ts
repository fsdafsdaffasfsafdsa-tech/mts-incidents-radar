// Источник из ТЗ: JSON-выгрузка ITSM (формат data/incidents_attributes.json).
// Следим за файлом; при изменении отдаём записи симулятору, он сравнивает по id и рассылает события.
// Если JSON сломан — держим последние рабочие данные и показываем ошибку.
import fs from 'node:fs';
import path from 'node:path';
import type { RawIncident } from './catalog.ts';

export interface FileStatus {
  file: string;
  records: number;
  error: string | null;
  changedAt: number | null;
}

export class ItsmFile {
  status: FileStatus;
  private mtime = 0;
  private timers: NodeJS.Timeout[] = [];
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    sample: string,
    private onRecords: (records: RawIncident[], initial: boolean) => void,
  ) {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(sample, file);
    }
    this.status = { file: path.basename(file), records: 0, error: null, changedAt: null };
  }

  start() {
    this.read(true);
    try {
      this.watcher = fs.watch(path.dirname(this.file), (_ev, name) => {
        if (!name || name === path.basename(this.file)) this.schedule();
      });
    } catch {
      /* на некоторых ФС watch недоступен — хватит опроса */
    }
    this.timers.push(setInterval(() => this.poll(), 1500));
  }

  stop() {
    this.watcher?.close();
    for (const t of this.timers) clearInterval(t);
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.poll(), 150);
  }

  private poll() {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m !== this.mtime) this.read(false);
    } catch {
      /* файл на мгновение пропал при сохранении редактором */
    }
  }

  private read(initial: boolean) {
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '');
      const data = JSON.parse(raw) as unknown;
      const list = (Array.isArray(data) ? data : Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null) as RawIncident[] | null;
      if (!list) throw new Error('ожидается массив инцидентов');
      const valid = list.filter((r) => r && typeof r === 'object' && r.id);
      this.status = { ...this.status, records: valid.length, error: null, changedAt: initial ? this.status.changedAt : Date.now() };
      this.onRecords(valid, initial);
    } catch (err) {
      this.status = { ...this.status, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
