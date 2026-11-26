# CareMate — RAG 챗봇 기반 고객 문의 분석·상담 지원 시스템

가상 쇼핑몰 '모아마켓'의 고객 문의에 **안내 문서를 근거로 답하고**, 근거가 없거나 급한 문의는 **분석해서 상담원에게 연결**하는 시스템입니다. (인공지능 응용 시스템 개발 종합 프로젝트)

- 고객 챗봇: 답변 + 근거 문서 + 문의 유형·감정·우선순위 표시, 주문번호(`MM-1001`) 조회
- 상담원 콘솔: 우선순위순 티켓, 근거가 달린 AI 답변 초안, 중복 답변 방지
- 분석 대시보드: 자동 해결률, 평균 응답시간, 만족도, 유형별·자주 인용된 지식
- 환각 방지: 신뢰도 임계값 → LLM '근거 부족' 응답 → 숫자·근거 일치도 검사 → 실패 시 원문 발췌 또는 상담원 연결

## 실행

필요한 것: **Node.js 24 이상** (외부 npm 패키지 없음). AI 답변을 쓰려면 [Ollama](https://ollama.com/download)와 모델 `kanana2:3b`가 필요합니다. 없어도 실행되며 이때는 검색된 원문 문장으로 답합니다(추출형).

```bash
npm start
```

브라우저에서 <http://127.0.0.1:5200> 을 엽니다. Windows는 `시작하기.cmd`를 더블클릭해도 됩니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` / `HOST` | 5200 / 127.0.0.1 | 접속 주소 |
| `LLM` | (켜짐) | `off`면 LLM 없이 추출형 답변 |
| `LLM_MODEL` | kanana2:3b | Ollama 모델 이름 |
| `EMBEDDINGS` | (꺼짐) | `on`이면 Ollama `embeddinggemma` 임베딩을 BM25와 섞음(이 개발 PC에서는 모델이 비정상 종료되어 검증하지 못함) |
| `DB_FILE` | data/caremate.db | SQLite 파일 |

### 시연 순서 (5분)
1. 시연 데이터 넣기(선택): 서버 실행 후 `node tools/seed-demo.mjs`
2. 고객 챗봇: "반품 배송비는 누가 내나요?" → 근거 REF-02 확인
3. "결제 오류로 중복 결제됐어요 도대체 몇 번째예요!!" → 우선순위 높음 + 티켓 생성
4. "MM-1001 배송 어디쯤이에요?" → DB 조회
5. "오늘 서울 날씨 어때?" → 지어내지 않고 상담원 연결
6. 상담원 콘솔 → 티켓 선택 → "AI 답변 초안" → 등록
7. 분석 대시보드 확인

## 원격 자동 검증 (2026-11-26)

[GitHub Actions](https://github.com/mycom0216/caremate/actions/runs/45734441591)에서 Node.js 24 환경으로 단위 테스트 30/30 및 API·보안 검사 33/33을 통과했습니다. LLM과 임베딩은 비활성화한 상태입니다. 누락된 데이터는 [복구 기록](docs/DATA_RECONSTRUCTION.md)에 따라 재구성했으며, 기존 2026-11-20 평가와 직접 비교할 수 없습니다. 재구성 데이터의 검색 hit@1 92.1%, hit@4 100%, 분류 22/24(91.7%)를 확인했습니다. [검증 기록](docs/CI_VERIFICATION_2026-11-26.md)을 참고하세요.

## 테스트와 평가

```bash
npm test                              # 자동 테스트 30개
node tools/eval.mjs                   # 검색·분류 평가 (LLM 없이)
node tools/eval.mjs --llm --out evidence/rag-eval-llm.json   # 답변 평가 (Ollama 필요, 약 2분)
```

2026-11-20 측정(질문 43개, 직접 작성, BM25, kanana2:3b): 검색 hit@1 92.1% · hit@4 100%, 답변 문구 판정 81.4% / 수기 검토 90.7%, 분류 75.0%(24문장), 응답 중앙값 2.3초. **평가 세트가 작고 같은 사람이 문서와 질문을 썼으므로 실제 성능을 보장하지 않습니다.** 자세한 한계는 [결과보고서](docs/CareMate_결과보고서.md)를 참고하세요.

## 구조

```
server.mjs            REST API + 정적 파일
src/text.mjs          토크나이저(문자 바이그램), PII 마스킹
src/kb.mjs            knowledge/*.md → 청크
src/rag.mjs           BM25 검색, 신뢰도, (선택) 임베딩
src/llm.mjs           Ollama 호출, 환각 방지 검사, 추출형 답변
src/chat.mjs          질문 처리 흐름, 에스컬레이션, 답변 초안
src/analyze.mjs       나이브 베이즈 분류, 감정·우선순위
src/db.mjs            SQLite (orders, inquiries, tickets)
knowledge/            모아마켓 안내 문서 6개(37개 항목, 가상)
data/                 분류 학습·테스트 문장, 평가 질문
public/               웹 화면(챗봇, 상담원 콘솔, 대시보드, 지식베이스)
tools/                eval, seed-demo, 문서·PPT 생성 스크립트
docs/                 기획서, 결과보고서, 발표 PPT
evidence/             평가 원자료, 테스트 결과
```

API: `POST /api/chat` · `GET /api/stats` · `GET /api/tickets` · `GET /api/tickets/:id/draft` · `POST /api/tickets/:id/reply` · `POST /api/inquiries/:id/feedback` · `GET /api/kb` · `GET /api/kb/search?q=` · `GET /api/status`

## 한계 (요약)
- 모아마켓과 문서는 가상이며 실제 고객 데이터로 검증하지 않았습니다.
- 주문 조회는 본인 인증 없는 데모입니다. 로그인·권한·부하 대응은 구현하지 않았습니다.
- 소형 LLM(3B)은 조건을 빠뜨리거나 부연을 지어낼 수 있고, 의미가 반대인 답변은 검사로 걸러내지 못합니다.
- LLM 없이(추출형) 운영하면 어휘가 일부 겹치는 범위 밖 질문에 관련 없는 문서가 나올 수 있습니다.
