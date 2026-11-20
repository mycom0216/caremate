import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// knowledge/*.md 를 "## [ID] 제목" 단위의 청크로 분할합니다.
export function loadKnowledge(dir) {
  const chunks = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const raw = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const docTitle = /^#\s+(.+)$/mu.exec(raw)?.[1] ?? file;
    for (const part of raw.split(/^##\s+/mu).slice(1)) {
      const m = /^\[([A-Z]+-\d+)\]\s*(.+)\n([\s\S]*)$/u.exec(part);
      if (!m) continue;
      chunks.push({ id: m[1], title: m[2].trim(), doc: docTitle, file, text: m[3].trim() });
    }
  }
  return chunks;
}
