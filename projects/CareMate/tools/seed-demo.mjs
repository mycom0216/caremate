// 시연용 문의 데이터를 실행 중인 서버에 보냅니다. 사용법: node tools/seed-demo.mjs [http://127.0.0.1:5200]
const base = process.argv[2] ?? 'http://127.0.0.1:5200';
const demo = [
  ['u1', '배송비는 얼마인가요?'], ['u1', '50000원 넘으면 무료인가요?'], ['u2', '택배가 3일째 안 와요 언제 오나요'],
  ['u3', 'MM-1005 어디쯤 왔나요?'], ['u4', '반품은 며칠 안에 해야 하나요?'], ['u4', '그럼 배송비는요?'],
  ['u5', '환불은 언제 들어와요? 카드 취소가 안 보여요'], ['u6', '결제 오류로 중복 결제됐어요 도대체 몇 번째예요!!'],
  ['u7', '포인트 유효기간이 얼마예요?'], ['u8', '쿠폰 두 장 같이 쓸 수 있어요?'], ['u9', '비밀번호를 잊어버렸어요'],
  ['u10', '무통장입금 기한이 지나면 어떻게 되나요?'], ['u11', '오늘 서울 날씨 어때?'], ['u12', '상담원 연결해 주세요'],
  ['u13', '파손된 상품이 왔어요 소비자원에 신고할 거예요!!'], ['u14', '전자제품 무상 A/S 기간이 궁금해요'],
  ['u15', '회원 탈퇴하면 포인트는 어떻게 되나요?'], ['u16', '새벽배송은 몇 시까지 주문해요?'], ['u17', '주문을 취소하고 싶어요'],
  ['u18', '사진 리뷰 적립금 얼마예요?'], ['u19', '안녕하세요'], ['u20', '무이자 할부 되나요?'], ['u21', '영수증은 어디서 출력해요?'],
  ['u22', '삼성 갤럭시 가격 알려줘'], ['u23', '세금계산서 발행해 주세요'],
];
let n = 0;
for (const [u, question] of demo) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'demo-session-' + u, question }) });
  const r = await res.json();
  if (r.id && n++ % 3 !== 2) await fetch(`${base}/api/inquiries/${r.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ helpful: n % 5 !== 0 }) });
  console.log(res.status, r.generator ?? r.error, question);
  await new Promise((r2) => setTimeout(r2, 900));
}
