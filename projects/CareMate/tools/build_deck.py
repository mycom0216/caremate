"""최종 발표 PPT 생성: python tools/build_deck.py  →  docs/CareMate_최종발표.pptx"""
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
FONT = "Malgun Gothic"
INK, MUTED = RGBColor(0x1C, 0x23, 0x33), RGBColor(0x66, 0x70, 0x85)
BRAND, SOFT, WHITE = RGBColor(0x4F, 0x46, 0xE5), RGBColor(0xEC, 0xEA, 0xFD), RGBColor(0xFF, 0xFF, 0xFF)
OK, WARN, BAD, LINE = RGBColor(0x0F, 0x9D, 0x6B), RGBColor(0xD9, 0x77, 0x06), RGBColor(0xD9, 0x2D, 0x20), RGBColor(0xE4, 0xE8, 0xF0)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]
N = 12


def text(slide, x, y, w, h, s, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05)
    lines = s if isinstance(s, list) else [s]
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = ln
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = color
        p.space_after = Pt(4)
    return tb


def box(slide, x, y, w, h, fill=SOFT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    else:
        s.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s


def card(slide, x, y, w, h, title, body, accent=BRAND, tsize=17, bsize=14):
    box(slide, x, y, w, h, WHITE, LINE)
    bar = box(slide, x, y, 0.09, h, accent, None, MSO_SHAPE.RECTANGLE)
    text(slide, x + 0.25, y + 0.12, w - 0.4, 0.5, title, tsize, True)
    text(slide, x + 0.25, y + 0.68, w - 0.4, h - 0.8, body, bsize, False, MUTED)


def base(title, n, notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = RGBColor(0xF7, 0xF8, 0xFC)
    box(s, 0, 0, 13.333, 0.12, BRAND, None, MSO_SHAPE.RECTANGLE)
    text(s, 0.6, 0.35, 11.5, 0.8, title, 30, True)
    text(s, 12.0, 7.0, 1.0, 0.3, f"{n} / {N}", 11, False, MUTED, PP_ALIGN.RIGHT)
    text(s, 0.6, 7.0, 6, 0.3, "CareMate · AI 고객 문의 분석·상담 지원", 11, False, MUTED)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def pic(slide, name, x, y, w):
    slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), width=Inches(w))
    # 얇은 테두리
    p = slide.shapes[-1]
    p.line.color.rgb = LINE
    p.line.width = Pt(1)


# 1 표지
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.0, 11, 1.2, "CareMate", 60, True, WHITE)
text(s, 0.9, 3.25, 11.5, 1.0, "RAG 챗봇 기반 고객 문의 분석·상담 지원 시스템", 30, False, WHITE)
text(s, 0.9, 4.5, 11, 0.5, "모르면 지어내지 않고, 근거와 함께 답하거나 사람에게 연결합니다", 18, False, RGBColor(0xDD, 0xDA, 0xFF))
text(s, 0.9, 6.3, 11, 0.5, "인공지능 응용 시스템 개발 종합 프로젝트 · 최종 발표 2026.12.30 · 발표자 [이름 기입]", 14, False, RGBColor(0xDD, 0xDA, 0xFF))
s.notes_slide.notes_text_frame.text = "안녕하세요. 쇼핑몰 고객 문의를 문서 근거로 응대하는 RAG 챗봇 CareMate를 발표하겠습니다. 모아마켓은 가상의 쇼핑몰입니다."

# 2 배경
s = base("왜 만들었나: 고객센터의 두 가지 문제", 2,
         "반복 질문 때문에 급한 문의가 밀리는 문제, 그리고 일반 LLM의 환각 문제를 함께 풀고자 했습니다.")
card(s, 0.6, 1.5, 5.9, 2.4, "① 반복 질문이 대부분", "배송비, 반품 기간, 쿠폰 규칙처럼 문서에 이미 답이 있는 질문에 상담원 시간이 쓰이고, 결제 오류·파손 같은 급한 문의가 뒤로 밀립니다.")
card(s, 6.8, 1.5, 5.9, 2.4, "② LLM만 붙이면 지어낸다", "문서에 없는 환불 정책을 그럴듯하게 답하면 곧바로 고객 불만과 분쟁이 됩니다. 근거 표시와 거절 능력이 필수입니다.", BAD)
box(s, 0.6, 4.4, 12.1, 1.9, BRAND)
text(s, 0.9, 4.6, 11.5, 0.6, "해결 방향", 18, True, WHITE)
text(s, 0.9, 5.2, 11.5, 1.0, ["문서에 있으면 → 출처와 함께 답변      문서에 없으면 → 지어내지 않고 상담원에게 연결", "모든 문의를 유형·감정·우선순위로 분석 → 급한 문의 먼저"], 17, False, WHITE)

# 3 목표·기능
s = base("핵심 기능", 3, "다섯 가지 기능을 한 흐름으로 묶었습니다. 이후 슬라이드에서 구조와 시연을 보여드립니다.")
items = [("RAG 답변 + 출처", "안내 문서 37개 항목에서 검색해 답하고 근거 문서 ID·원문을 함께 표시", BRAND),
         ("환각 방지 3겹", "신뢰도 임계값 · LLM '근거 부족' 응답 · 숫자·근거 일치도 검사", BAD),
         ("문의 분석", "유형 분류(나이브 베이즈) · 감정 · 우선순위 · 개인정보 마스킹", OK),
         ("상담원 콘솔", "우선순위순 티켓, 근거가 달린 AI 답변 초안, 중복 처리 방지", WARN),
         ("대시보드·주문 조회", "자동 해결률, 만족도, 자주 묻는 주제 / 주문번호로 DB 실시간 조회", BRAND)]
for i, (t, b, c) in enumerate(items):
    x, y = 0.6 + (i % 3) * 4.1, 1.5 + (i // 3) * 2.75
    card(s, x, y, 3.9, 2.5, t, b, c, 18, 14)
box(s, 8.8, 4.25, 3.9, 2.5, SOFT)
text(s, 9.0, 4.4, 3.5, 2.2, ["기술 스택", "Node.js · SQLite", "Ollama (kanana2:3b)", "HTML/CSS/JS", "외부 npm 패키지 0개"], 15, False, INK)

# 4 아키텍처
s = base("시스템 구조", 4, "고객 질문은 마스킹과 분석을 거친 뒤 네 갈래로 분기합니다. RAG 경로에서만 LLM을 호출합니다.")
steps = [("브라우저", "고객 · 상담원 · 운영자"), ("REST 서버", "Node.js"), ("ChatService", "마스킹 → 분석 → 분기"), ("답변 or 티켓", "근거 + 출처")]
for i, (t, b) in enumerate(steps):
    x = 0.6 + i * 3.15
    box(s, x, 1.6, 2.7, 1.3, WHITE, BRAND)
    text(s, x, 1.7, 2.7, 0.5, t, 18, True, BRAND, PP_ALIGN.CENTER)
    text(s, x, 2.25, 2.7, 0.5, b, 13, False, MUTED, PP_ALIGN.CENTER)
    if i < 3:
        text(s, x + 2.7, 1.9, 0.45, 0.6, "→", 26, True, BRAND, PP_ALIGN.CENTER)
text(s, 0.6, 3.25, 6, 0.4, "ChatService 분기", 17, True)
branches = [("상담원 요청", "즉시 티켓"), ("잡담", "고정 응답"), ("주문번호 MM-####", "DB 조회"), ("그 외 질문", "RAG 검색 → LLM → 검증")]
for i, (t, b) in enumerate(branches):
    x = 0.6 + i * 3.15
    box(s, x, 3.75, 2.9, 1.05, SOFT if i < 3 else BRAND)
    text(s, x, 3.82, 2.9, 0.45, t, 15, True, INK if i < 3 else WHITE, PP_ALIGN.CENTER)
    text(s, x, 4.27, 2.9, 0.45, b, 13, False, MUTED if i < 3 else WHITE, PP_ALIGN.CENTER)
box(s, 0.6, 5.2, 12.1, 1.5, WHITE, LINE)
text(s, 0.85, 5.3, 11.6, 1.3, ["SQLite 3테이블: orders(주문) · inquiries(문의·분석·답변·피드백) · tickets(상담원 연결, 상태·답변)", "knowledge/*.md: 6개 문서, 37개 항목을 '## [ID] 제목' 단위로 분할해 BM25 색인"], 15, False, INK)

# 5 RAG 파이프라인
s = base("RAG 파이프라인과 환각 방지", 5, "핵심은 오른쪽 세 겹의 검사입니다. 실제 평가 중에 이 검사가 필요하다는 것을 발견했습니다.")
flow = ["질문(마스킹)", "군말 제거·바이그램", "BM25 상위 4개 + 신뢰도", "프롬프트(문서만 사용)", "LLM 생성", "3겹 검사"]
for i, t in enumerate(flow):
    y = 1.5 + i * 0.88
    box(s, 0.6, y, 4.6, 0.7, BRAND if i == 5 else WHITE, BRAND)
    text(s, 0.6, y, 4.6, 0.7, t, 15, True, WHITE if i == 5 else INK, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
card(s, 5.7, 1.5, 7.0, 1.55, "① 신뢰도 < 0.2 → LLM 호출 없이 상담원 연결", "질문 토큰 가중 커버리지 × (1 − 0.7 × 코퍼스 밖 어절 비율)", BRAND, 16, 13)
card(s, 5.7, 3.2, 7.0, 1.55, "② LLM이 '근거 부족'이라고 답하면 상담원 연결", "프롬프트에서 문서에 없으면 그 한마디만 답하게 지시", WARN, 16, 13)
card(s, 5.7, 4.9, 7.0, 1.85, "③ 숫자·인용·근거 일치도 검사", "답변 숫자가 문서에 있는지, 답변 바이그램의 문서 일치도 ≥ 0.5 (정상 최저 0.57 / 지어낸 날씨 답변 0.20~0.27). 실패하면 원문 발췌 또는 상담원 연결", BAD, 16, 13)

# 6 분석
s = base("문의 분석: 유형 · 감정 · 우선순위 · 개인정보", 6, "분석 결과는 근거 단어와 함께 상담원 화면에 표시됩니다. 점수만 주면 상담원이 믿기 어렵기 때문입니다.")
card(s, 0.6, 1.5, 3.9, 2.9, "유형 분류", "문자 바이그램 나이브 베이즈\n8개 유형 · 학습 64문장\n분리된 24문장 정확도 75.0%", BRAND, 18, 15)
card(s, 4.7, 1.5, 3.9, 2.9, "감정·우선순위", "부정·긴급·법적 표현·사고성(중복 결제, 파손, 분실) 사전 점수\n근거 단어를 함께 표시", WARN, 18, 15)
card(s, 8.8, 1.5, 3.9, 2.9, "개인정보 마스킹", "전화·이메일·카드·주민번호를 저장 전에 가리고 LLM에도 가린 문장만 전달", OK, 18, 15)
box(s, 0.6, 4.75, 12.1, 1.9, SOFT)
text(s, 0.9, 4.85, 11.5, 0.5, "예시", 16, True, BRAND)
text(s, 0.9, 5.35, 11.5, 1.2, ["\"결제 오류로 중복 결제됐어요 도대체 몇 번째예요!!\"", "→ 유형 결제 · 감정 매우 부정(-0.85) · 우선순위 높음 · 근거 단어 '도대체, 몇 번째, 중복 결제, 결제 오류' · 챗봇 답변 + 상담원 티켓 동시 생성"], 15, False, INK)

# 7 시연 챗봇
s = base("시연 ① 고객 챗봇: 답변 + 근거 + 분석", 7, "왼쪽은 고객 화면, 오른쪽은 분석과 근거입니다. 반품 배송비 질문은 REF-02를 근거로 6,000원이라고 답했습니다. 두 번째는 중복 결제 문의로 상담원 티켓 #10이 같이 생성됩니다.")
pic(s, "ui-chat.jpg", 0.6, 1.35, 8.2)
card(s, 9.1, 1.4, 3.6, 2.1, "시연 순서", "① 반품 배송비\n② 중복 결제 문의\n③ 주문번호 조회\n④ 날씨(범위 밖)", BRAND, 15, 13)
card(s, 9.1, 3.65, 3.6, 1.45, "보이는 것", "답변 · 근거 문서 · 신뢰도 · 유형·감정·우선순위 · 생성 방식", OK, 15, 13)
card(s, 9.1, 5.25, 3.6, 1.6, "실행", "프로젝트 폴더에서\nnpm start\n→ localhost:5200", WARN, 15, 13)

# 8 시연 상담원/대시보드
s = base("시연 ② 상담원 콘솔 · 대시보드", 8, "긴급 티켓이 위로 정렬되고, 초안 버튼을 누르면 사과 문구와 근거가 달린 답변이 채워집니다. 상담원이 검토 후 등록합니다. 대시보드의 만족도는 시연용 데이터입니다.")
pic(s, "ui-agent.jpg", 0.6, 1.4, 6.0)
pic(s, "ui-dashboard.jpg", 6.8, 1.4, 6.0)
text(s, 0.6, 5.2, 6.0, 1.5, ["상담원 콘솔", "우선순위순 티켓 · AI 초안(근거 표시) · 답변 중복 등록 방지"], 14, False, MUTED)
text(s, 6.8, 5.2, 6.0, 1.5, ["운영 대시보드", "자동 해결률 · 평균 응답시간 · 유형별 · 자주 인용된 지식(= 많이 궁금해하는 주제)"], 14, False, MUTED)

# 9 평가
s = base("평가 결과 (질문 43개, 자체 작성)", 9, "수치는 직접 만든 작은 평가 세트의 결과입니다. 문구 자동 판정은 81.4%, 개발자 수기 검토는 90.7%입니다. 범위 밖 질문은 검색 단계만으로는 60%만 걸러지지만 LLM 검사까지 포함하면 5개 모두 연결 또는 잡담으로 처리됐습니다.")
cd = CategoryChartData()
cd.categories = ["검색 hit@1", "검색 hit@4", "답변(문구 판정)", "답변(수기 검토)", "문의 분류(24문장)"]
cd.add_series("정확도(%)", (92.1, 100, 81.4, 90.7, 75.0))
gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, Inches(0.6), Inches(1.4), Inches(7.4), Inches(4.9), cd)
ch = gf.chart
ch.has_legend = False
ch.has_title = False
ch.plots[0].has_data_labels = True
dl = ch.plots[0].data_labels
dl.font.size, dl.font.name, dl.number_format, dl.number_format_is_linked = Pt(14), FONT, '0.0"%"', False
dl.position = XL_LABEL_POSITION.OUTSIDE_END
ch.plots[0].gap_width = 60
ch.plots[0].series[0].format.fill.solid()
ch.plots[0].series[0].format.fill.fore_color.rgb = BRAND
ch.value_axis.maximum_scale, ch.value_axis.minimum_scale = 110, 0
ch.value_axis.visible = False
ch.value_axis.has_major_gridlines = False
ch.category_axis.tick_labels.font.size = Pt(14)
ch.category_axis.tick_labels.font.name = FONT
ch.category_axis.reverse_order = True
card(s, 8.3, 1.4, 4.4, 1.5, "응답 시간", "중앙값 2.3초 · 최댓값 18.9초(1건)", BRAND, 16, 14)
card(s, 8.3, 3.05, 4.4, 1.5, "자동 테스트", "30개 전부 통과", OK, 16, 14)
card(s, 8.3, 4.7, 4.4, 1.6, "범위 밖 질문 5개", "검색 단계 60% 거절 → 전체 파이프라인 5/5 상담원 연결·잡담", WARN, 16, 13)
text(s, 0.6, 6.4, 12, 0.5, "측정: 로컬 Ollama kanana2:3b · 검색 BM25 · 2026-11-20 · 원자료 evidence/rag-eval-llm.json", 12, False, MUTED)

# 10 개발 중 발견
s = base("개발 중 발견한 문제와 해결", 10, "평가를 돌려 보니 LLM이 날씨를 지어내 답했습니다. 숫자 검사는 숫자가 없어 통과했습니다. 그래서 근거 일치도 검사를 추가했고, 질문 문구를 근거로 인정하던 허점도 고쳤습니다.")
rows = [("LLM이 문서에 없는 날씨를 답변", "숫자가 없어 숫자 검사 통과", "답변-문서 바이그램 일치도 검사(≥0.5) 추가"),
        ("질문을 되풀이한 답이 통과", "질문 단어를 근거로 인정", "질문 문구를 근거에서 제외"),
        ("'상담원이 답해 주나요?'가 연결 요청으로 오인", "키워드 '상담원'만 검사", "연결·통화 등 요청 동사와 함께일 때만 인정"),
        ("정상 질문까지 범위 밖 판정", "코퍼스 밖 어절 패널티 과다", "3글자 이상 어절만, 선형 패널티로 완화"),
        ("분류 정확도 부풀리기 위험", "테스트 문장과 비슷한 학습 문장 추가", "추가분 폐기, 분리된 24문장 유지")]
y = 1.5
for i, hd in enumerate(["문제", "원인", "해결"]):
    box(s, 0.6 + i * 4.1, y, 3.95, 0.55, BRAND)
    text(s, 0.6 + i * 4.1, y, 3.95, 0.55, hd, 15, True, WHITE, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
for r, row in enumerate(rows):
    for c, t in enumerate(row):
        yy = 2.15 + r * 0.93
        box(s, 0.6 + c * 4.1, yy, 3.95, 0.83, WHITE, LINE)
        text(s, 0.65 + c * 4.1, yy, 3.85, 0.83, t, 13, False, INK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)

# 11 한계
s = base("한계와 향후 개선", 11, "정직하게 말씀드리면 이 수치는 작은 자체 평가 세트의 결과이고 실제 고객 질문에서는 낮아질 수 있습니다. 임베딩 검색은 이 PC에서 모델이 비정상 종료되어 검증하지 못했습니다.")
card(s, 0.6, 1.5, 6.0, 5.1, "한계", ["• 평가 질문과 문서를 같은 사람이 작성 → 낙관적", "• 가상 문서, 실제 고객 표현 미검증", "• 임베딩 검색: 이 PC에서 모델 비정상 종료로 미검증", "• 어휘 검색만으로는 범위 밖 질문 60%만 거절", "• 3B 모델: 조건 누락·부연 오류, 의미 반대 답변은 못 거름", "• 주문 조회에 본인 인증 없음(데모)", "• 실사용자 검증 없음, 만족도는 시연 데이터"], BAD, 20, 18)
card(s, 6.9, 1.5, 5.8, 5.1, "향후 개선", ["• 실제 문의로 평가 세트·분류 학습 데이터 확대", "• 형태소 분석·임베딩 재순위화 비교 실험", "• 더 큰 모델 / 문장 단위 근거 검증(NLI)", "• 상담원 수정 내용을 개선 데이터로 환류", "• 지식베이스 편집·업로드 화면", "• 인증·권한, 로그 보관 정책, 부하 테스트"], OK, 20, 18)

# 12 결론
s = base("결론", 12, "질의응답을 받겠습니다. 시연은 localhost:5200에서 바로 가능합니다.")
box(s, 0.6, 1.5, 12.1, 3.3, BRAND)
text(s, 0.95, 1.7, 11.4, 3.0, ["안내 문서를 근거로 답하고, 모르면 상담원에게 연결하는 RAG 상담 시스템을 구현·평가했습니다.", "", "검색 hit@4 100% · 답변 수기 검토 90.7% · 자동 테스트 30/30 통과", "환각 방지 3겹 + 에스컬레이션으로 소형 LLM의 오류를 줄였지만 완전하지는 않습니다."], 20, False, WHITE)
card(s, 0.6, 5.1, 5.9, 1.6, "제출물", "기획서 · 결과보고서 · 발표 PPT · 전체 소스 · 실행 스크립트 · 평가 원자료", BRAND, 16, 13)
card(s, 6.8, 5.1, 5.9, 1.6, "Q & A", "감사합니다.", OK, 16, 18)

out = ROOT / "docs" / "CareMate_최종발표.pptx"
prs.save(out)
print("saved", out, "slides:", len(prs.slides))
