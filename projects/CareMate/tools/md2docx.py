"""간단한 마크다운 → Word(.docx) 변환기. 제출 문서(기획서·결과보고서) 생성용.
사용법: python tools/md2docx.py docs/CareMate_기획서.md docs/CareMate_기획서.docx
지원: # ## ### 제목, 표, 코드블록, 이미지, 글머리표/번호 목록, **굵게**, `코드`
"""
# ─────────────────────────────────────────────────────────────────────────────
# md2docx.py — 마크다운(.md)을 Word(.docx)로 바꾸는 간단한 변환기 (제출 문서 생성용 개발 도구, 서비스 실행과는 무관)
#
# [필요]  python-docx 패키지(import docx). 서버(Node.js)에는 쓰이지 않습니다.
# [방식]  원문을 한 줄씩 읽으며 줄의 모양으로 종류를 판단해 Word 요소로 바꿉니다.
#         코드블록(백틱 3개로 감싼 부분), 표(| 로 시작 + 구분선), 이미지, # ## ### 제목, 글머리표, 번호 목록, 일반 문단
#         인라인 서식: 굵게와 코드 서식만 지원(add_inline). 글꼴은 맑은 고딕(한글 글꼴은 eastAsia 속성으로 따로 지정해야 적용됨).
# [한계]  모든 마크다운 문법을 지원하지 않는 단순 변환기입니다(중첩 목록, 링크 등은 일반 글자로 나옵니다).
# ─────────────────────────────────────────────────────────────────────────────
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# 문서 기본 글꼴.
FONT = "Malgun Gothic"


# 글자(run) 서식 지정: 글꼴·크기·굵기·고정폭(코드)·색. 한글 글꼴은 w:eastAsia 속성에 따로 지정해야 Word 에서 적용됩니다.
def set_font(run, size=None, bold=None, mono=False, color=None):
    name = "Consolas" if mono else FONT
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


# 한 줄 안의 인라인 서식 처리: **굵게** 와 `코드` 를 정규식으로 쪼개 각각 알맞은 글자 서식으로 추가합니다(나머지는 보통 글자).
def add_inline(par, text, size=10.5):
    for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**"):
            set_font(par.add_run(part[2:-2]), size, True)
        elif part.startswith("`"):
            set_font(par.add_run(part[1:-1]), size - 0.5, mono=True, color="4F46E5")
        else:
            set_font(par.add_run(part), size)


# 표 머리 칸 배경색 칠하기: 셀 속성에 음영(w:shd) 요소를 추가합니다. hex_fill 은 16진수 색(예: ECEAFD).
def shade(cell, hex_fill):
    tcPr = cell._element.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcPr.append(shd)


# 변환 본체: src(.md) 경로를 읽어 dst(.docx) 로 저장합니다. 이미지 경로는 마크다운 파일이 있는 폴더 기준으로 찾습니다. 줄 단위 상태 기계(while 루프, i 는 현재 줄).
def convert(src, dst):
    lines = Path(src).read_text(encoding="utf-8").splitlines()
    base = Path(src).parent
    # 문서 기본 설정: 여백(좌우 2.2cm, 상하 2.0cm)과 기본 글꼴.
    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)
    doc.styles["Normal"].font.name = FONT
    doc.styles["Normal"].element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    i = 0
    while i < len(lines):
        ln = lines[i]
        # 코드블록: 백틱 3개로 시작하면 닫는 줄까지 모아 고정폭 글꼴 한 문단으로 만듭니다.
        if ln.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.4)
            for k, b in enumerate(block):
                set_font(p.add_run(b + ("\n" if k < len(block) - 1 else "")), 8.5, mono=True)
            i += 1
            continue
        # 표: 파이프(|)로 시작하고 다음 줄이 구분선(---)이면 표 시작. 구분선 줄은 건너뛰고 셀을 | 로 쪼개 Word 표를 만들며, 셀이 이미지 문법이면 그림을 넣습니다. 첫 줄은 머리글로 굵게·음영 처리.
        if ln.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                if not re.match(r"^\|[\s:|-]+\|$", lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = doc.add_table(rows=len(rows), cols=len(rows[0]))
            t.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, txt in enumerate(row):
                    cell = t.cell(r, c)
                    cell.text = ""
                    par = cell.paragraphs[0]
                    pm = re.match(r"!\[[^\]]*\]\(([^)]+)\)", txt)
                    if pm and (base / pm.group(1)).exists():
                        par.add_run().add_picture(str(base / pm.group(1)), width=Cm(7.4))
                        continue
                    add_inline(par, txt, 9.5)
                    if r == 0:
                        shade(cell, "ECEAFD")
                        for run in par.runs:
                            run.font.bold = True
            doc.add_paragraph()
            continue
        # 이미지 줄: 파일이 실제로 있을 때만 가운데 정렬로 넣습니다(없으면 조용히 건너뜀).
        m = re.match(r"!\[[^\]]*\]\(([^)]+)\)", ln)
        if m:
            f = base / m.group(1)
            if f.exists():
                doc.add_picture(str(f), width=Cm(15))
                doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            i += 1
            continue
        # 제목(# ## ###)은 글자 크기·색만 다르게 한 문단으로 표현(Word 제목 스타일은 쓰지 않음), 글머리표·번호 목록은 Word 기본 목록 스타일 사용.
        if ln.startswith("# "):
            p = doc.add_paragraph()
            set_font(p.add_run(ln[2:]), 22, True, color="3730A3")
        elif ln.startswith("## "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14)
            set_font(p.add_run(ln[3:]), 15, True, color="3730A3")
        elif ln.startswith("### "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(8)
            set_font(p.add_run(ln[4:]), 12, True)
        elif re.match(r"^\s*- ", ln):
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, re.sub(r"^\s*- ", "", ln))
        elif re.match(r"^\d+\. ", ln):
            p = doc.add_paragraph(style="List Number")
            add_inline(p, re.sub(r"^\d+\. ", "", ln))
        elif ln.strip():
            p = doc.add_paragraph()
            add_inline(p, ln)
        i += 1
    doc.save(dst)
    print("saved", dst)


# 명령줄 실행: python tools/md2docx.py 입력.md 출력.docx
if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
