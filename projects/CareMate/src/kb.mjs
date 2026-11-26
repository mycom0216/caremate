// ─────────────────────────────────────────────────────────────────────────────
// kb.mjs — 지식베이스(knowledge/*.md) 불러오기와 "청크" 분할
//
// [용어]  · 지식베이스(KB): 챗봇이 답의 근거로 삼는 안내 문서 모음(여기서는 가상 쇼핑몰 '모아마켓'의 마크다운 문서).
//         · 청크(chunk): 검색 단위로 잘게 나눈 문서 조각. 문서를 통째로 검색하면 답과 상관없는 내용이 섞이므로
//           "## [REF-02] 제목" 하나가 한 조각이 되도록 나눕니다.
//         · RAG(검색 증강 생성): 질문과 관련된 조각을 먼저 "검색"하고, 그 조각만 근거로 답을 "생성"하는 방식.
//
// [문서 형식]  각 .md 파일은 "# 문서 제목" 한 줄과, "## [ID] 항목 제목" 줄 뒤에 본문이 오는 항목들로 구성됩니다.
//             ID 는 대문자-숫자 형태(예: REF-02, MEM-03, PAY-02)이며 화면에 "근거 REF-02"처럼 출처로 표시됩니다.
//
// [반환 모양]  [{ id:'REF-02', title:'항목 제목', doc:'문서 제목', file:'refund.md', text:'본문' }, ...]
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// dir 폴더의 .md 파일을 이름순으로(.sort() → 항상 같은 순서) 읽어 청크 배열을 만듭니다.
//   이 순서가 곧 검색기 내부 배열 순서이므로, 순서가 고정되어야 임베딩 캐시 키와 평가 결과가 재현됩니다.
// knowledge/*.md 를 "## [ID] 제목" 단위의 청크로 분할합니다.
export function loadKnowledge(dir) {
  const chunks = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    // 1) 파일을 UTF-8 로 읽고 줄바꿈을 \n 으로 통일합니다(Windows 의 \r\n 이 정규식 ^ $ 매칭을 깨뜨리지 않도록).
    const raw = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    // 2) 문서 제목: 첫 번째 "# 제목" 줄. 없으면 파일 이름을 대신 씁니다.
    const docTitle = /^#\s+(.+)$/mu.exec(raw)?.[1] ?? file;
    // 3) "## " 로 시작하는 줄을 기준으로 분할합니다. 첫 조각(slice(1)로 버림)은 첫 "## " 앞의 머리말(문서 제목 등)입니다.
    for (const part of raw.split(/^##\s+/mu).slice(1)) {
      // 4) 각 조각의 첫 줄이 "[ID] 제목" 형식인지 확인해 id, 제목, 본문으로 나눕니다. 형식이 다르면 지식 항목이 아니므로 건너뜁니다(continue).
      const m = /^\[([A-Z]+-\d+)\]\s*(.+)\n([\s\S]*)$/u.exec(part);
      if (!m) continue;
      chunks.push({ id: m[1], title: m[2].trim(), doc: docTitle, file, text: m[3].trim() });
    }
  }
  return chunks;
}
