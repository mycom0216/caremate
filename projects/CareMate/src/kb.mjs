import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// knowledge/*.md 를 "## [ID] 제목" 단위의 청크로 분할합니다.
export function loadKnowledge(dir) {
  // 파일명 순으로 읽어 청크 순서를 결정적으로 유지한다.
  const chunks = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const raw = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    // 문서 제목과 청크 ID, 제목 및 본문을 출처 메타데이터로 보존한다.
    const docTitle = /^#\s+(.+)$/mu.exec(raw)?.[1] ?? file;
    for (const part of raw.split(/^##\s+/mu).slice(1)) {
      const m = /^\[([A-Z]+-\d+)\]\s*(.+)\n([\s\S]*)$/u.exec(part);
      if (!m) continue;
      chunks.push({ id: m[1], title: m[2].trim(), doc: docTitle, file, text: m[3].trim() });
    }
  }
  return chunks;
}
