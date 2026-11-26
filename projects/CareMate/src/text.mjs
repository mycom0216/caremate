// 한국어 질의·문서용 가벼운 토크나이저: 어절 + 어절 내부 문자 바이그램.
// 형태소 분석기 없이도 조사·어미 변화("반품이/반품은/반품하려면")에 견디도록 바이그램을 씁니다.
const JOSA = /(으로|에서|에게|까지|부터|이나|이랑|인가요|나요|까요|은|는|이|가|을|를|에|로|의|도|만|과|와|요)$/u;

// 유니코드 정규화와 소문자화, 공백 정리로 입력 표현을 통일한다.
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

// 문자와 숫자로 구성된 어절을 추출한다.
export function words(text) {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// 질의 전용: 의미 없는 군말·요청 어미("알려줘", "어때", "되나요")는 검색 근거에서 뺍니다.
export const FILLER = new Set(['알려줘', '알려주세요', '알려줄래', '해줘', '해주세요', '줄래', '어때', '어떻게', '어떡해', '되나요', '돼요', '있나요', '있어요', '가능한가요', '가능해요', '궁금해요', '궁금합니다', '싶어요', '싶은데', '하나요', '할까요', '인가요', '이에요', '예요', '뭐야', '뭔가요', '무엇인가요', '좀', '혹시', '그냥', '정말', '진짜', '너', '나', '저', '제가', '저는', '내가']);

// 어절 및 문자 바이그램을 검색·분류용 특징으로 변환한다.
export function tokens(text, { query = false } = {}) {
  const out = [];
  for (const w of words(text)) {
    if (query && FILLER.has(w)) continue;
    const stem = w.length > 2 ? w.replace(JOSA, '') : w;
    if (stem.length >= 2) out.push('w:' + stem);
    const chars = [...stem];
    if (chars.length === 1) out.push('c:' + chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.push('b:' + chars[i] + chars[i + 1]);
  }
  return out;
}

// 문장부호 뒤 공백을 기준으로 발췌 후보 문장을 분리한다.
export function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
}

// 개인정보(전화·이메일·카드·주민번호)를 저장·LLM 전달 전에 가립니다.
export function maskPII(text) {
  const found = [];
  let masked = String(text ?? '');
  // 유형별 정규식과 대체 문자열을 순서대로 적용한다.
  const rules = [
    ['주민등록번호', /\b\d{6}[- ]?[1-4]\d{6}\b/gu, '[주민번호]'],
    ['카드번호', /\b(?:\d{4}[- ]?){3}\d{4}\b/gu, '[카드번호]'],
    ['전화번호', /\b0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/gu, '[전화번호]'],
    ['이메일', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, '[이메일]'],
  ];
  for (const [name, re, repl] of rules) {
    const next = masked.replace(re, repl);
    if (next !== masked) { found.push(name); masked = next; }
  }
  return { masked, found };
}
