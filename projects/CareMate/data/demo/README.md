# CareMate SQLite 데모 데이터

`caremate.db`는 2026-11-26 프로젝트의 원래 시드 질문 및 주문 샘플을 사용하여 별도로 생성한 SQLite 데이터베이스입니다. 실제 고객 개인정보나 인증 정보가 아닙니다. LLM과 임베딩을 비활성화한 추출형 서비스로 생성했습니다.

- 주문 5건, 문의 25건, 상담 티켓 4건, 피드백 17건
- `PRAGMA integrity_check` 결과 `ok`, `PRAGMA foreign_key_check` 위반 없음
- 크기 69,632 bytes; Git blob SHA `312279640deb7c6ca55b716ad0f5f0b9bfca4a03`
- WAL 체크포인트 완료 및 단일 파일로 저장

## 실행 (프로젝트 루트에서)

PowerShell:

```powershell
Copy-Item data/demo/caremate.db data/caremate.db
$env:LLM='off'
npm start
```

기존 운영 DB가 있으면 먼저 백업하고 별도 복사본을 사용하세요. `data/caremate.db`는 git에서 제외되며 공개 데모 원본을 운영 DB로 직접 사용하지 않습니다. 이 프로젝트는 로컬 시연용이며 인증 없는 공개 배포는 권장하지 않습니다.
